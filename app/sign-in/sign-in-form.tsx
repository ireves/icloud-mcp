'use client';

// Sign-in is a passkey: a fingerprint or face check on a key that only works on
// this hostname, so a lookalike site cannot collect anything reusable.
//
// The page has two jobs. Normally it signs the owner in and hands the browser
// back to the authorization endpoint with the query it arrived with, which is
// signed and carries the pending request. On a brand new deployment there is no
// passkey yet, so it also registers the first one, guarded by the setup code.

import { useEffect, useState, type CSSProperties } from 'react';
import { authClient } from '@/lib/auth-client';

const button: CSSProperties = {
  font: 'inherit',
  padding: '0.6rem 1rem',
  borderRadius: '0.4rem',
  border: '1px solid #1a1a1a',
  background: '#1a1a1a',
  color: '#fff',
  cursor: 'pointer',
};

const field: CSSProperties = {
  font: 'inherit',
  padding: '0.5rem',
  borderRadius: '0.4rem',
  border: '1px solid #999',
  width: '100%',
  marginBottom: '0.75rem',
};

export default function SignInForm() {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupCode, setSetupCode] = useState('');
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setQuery(window.location.search.replace(/^\?/, ''));
    setSupported(typeof window.PublicKeyCredential === 'function');
  }, []);

  // Back to where the sign-in came from. The query is signed by the server, so
  // it cannot be edited on the way through.
  function resume() {
    if (!query) {
      window.location.href = '/';
      return;
    }
    window.location.href = `/api/auth/oauth2/authorize?${query}`;
  }

  async function signIn() {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) {
      setBusy(false);
      setError(result.error.message || 'That passkey was not accepted.');
      return;
    }
    resume();
  }

  async function register() {
    setBusy(true);
    setError(null);
    const result = await authClient.passkey.addPasskey({
      name: 'Owner passkey',
      context: setupCode,
      createSession: true,
    } as Parameters<typeof authClient.passkey.addPasskey>[0]);
    if (result?.error) {
      setBusy(false);
      setError(result.error.message || 'That passkey could not be registered.');
      return;
    }
    resume();
  }

  if (!supported) {
    return (
      <p>
        This browser cannot use passkeys. Open the link in Safari, Chrome or Edge
        on a device with a screen lock.
      </p>
    );
  }

  return (
    <>
      <p>An assistant is asking to connect to your iCloud mail and calendar.</p>

      <button style={button} onClick={signIn} disabled={busy}>
        {busy ? 'One moment…' : 'Sign in with your passkey'}
      </button>

      {error ? (
        <p style={{ color: '#b00020', marginTop: '1rem' }} role="alert">
          {error}
        </p>
      ) : null}

      <hr style={{ margin: '2rem 0', border: 0, borderTop: '1px solid #ddd' }} />

      {setupOpen ? (
        <>
          <p>
            First time here? Enter the setup code you put in <code>MCP_SETUP_CODE</code>{' '}
            to register this device. This works once, and only while no passkey
            exists.
          </p>
          <input
            style={field}
            type="password"
            value={setupCode}
            autoComplete="one-time-code"
            placeholder="Setup code"
            onChange={(event) => setSetupCode(event.target.value)}
          />
          <button style={button} onClick={register} disabled={busy || !setupCode}>
            Register this device
          </button>
        </>
      ) : (
        <button
          style={{ ...button, background: 'transparent', color: '#1a1a1a' }}
          onClick={() => setSetupOpen(true)}
        >
          Set up a new deployment
        </button>
      )}
    </>
  );
}
