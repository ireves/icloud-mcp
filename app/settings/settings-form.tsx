'use client';

// Add and remove environment variables without the Vercel dashboard.
//
// Nothing on this page can show a value. The list holds names only, a value is
// typed into a masked field, sent once, and the field is cleared. Vercel stores
// it as a sensitive variable, which it will not reveal again to anyone.

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
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

const secondary: CSSProperties = { ...button, background: 'transparent', color: '#1a1a1a' };

const small: CSSProperties = { ...secondary, padding: '0.2rem 0.6rem', fontSize: '0.9rem' };

const field: CSSProperties = {
  font: 'inherit',
  padding: '0.5rem',
  borderRadius: '0.4rem',
  border: '1px solid #999',
  width: '100%',
  boxSizing: 'border-box',
  marginBottom: '0.75rem',
};

interface Env {
  id: string;
  key: string;
  target: string[];
  type: string;
  updatedAt: number | null;
  locked: boolean;
}

type Reason = 'signed_out' | 'stale' | 'not_owner' | 'not_configured' | 'cross_site' | undefined;

async function request(method: string, body?: unknown) {
  const response = await fetch('/api/settings/env', {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data } as {
    ok: boolean;
    data: { envs?: Env[]; error?: string; reason?: Reason; url?: string };
  };
}

export default function SettingsForm() {
  const [envs, setEnvs] = useState<Env[] | null>(null);
  const [reason, setReason] = useState<Reason>();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [pendingRedeploy, setPendingRedeploy] = useState(false);

  const load = useCallback(async () => {
    const result = await request('GET');
    if (!result.ok) {
      setReason(result.data.reason);
      setError(result.data.error || 'The list could not be loaded.');
      setEnvs(null);
      return;
    }
    setReason(undefined);
    setError(null);
    setEnvs(result.data.envs || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function signIn() {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    setBusy(false);
    if (result?.error) {
      setError(result.error.message || 'That passkey was not accepted.');
      return;
    }
    await load();
  }

  // Every change goes through here, so a sign-in that has gone stale is caught
  // the same way whichever button was pressed.
  async function change(method: string, body: unknown, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await request(method, body);
    setBusy(false);
    if (!result.ok) {
      setReason(result.data.reason);
      setError(result.data.error || 'That could not be completed.');
      return false;
    }
    setReason(undefined);
    setNotice(done);
    return true;
  }

  async function save() {
    const saved = await change('POST', { name: name.trim(), value }, `${name.trim()} saved.`);
    // Cleared either way: the value should not linger in the page.
    setValue('');
    if (saved) {
      setName('');
      setPendingRedeploy(true);
      await load();
    }
  }

  async function remove(env: Env) {
    if (!window.confirm(`Remove ${env.key}? This cannot be undone.`)) return;
    if (await change('DELETE', { id: env.id }, `${env.key} removed.`)) {
      setPendingRedeploy(true);
      await load();
    }
  }

  async function redeploy() {
    if (await change('PUT', {}, 'Redeploying. The change takes effect in a minute or two.')) {
      setPendingRedeploy(false);
    }
  }

  const needsSignIn = reason === 'signed_out' || reason === 'stale';

  return (
    <>
      <p>
        Add or remove this server&rsquo;s settings. A value can be written but never read
        back: not here, and not in the Vercel dashboard either.
      </p>

      {needsSignIn ? (
        <p>
          <button style={button} onClick={signIn} disabled={busy}>
            {busy ? 'One moment…' : 'Sign in with your passkey'}
          </button>
        </p>
      ) : null}

      {error ? (
        <p style={{ color: '#b00020' }} role="alert">
          {error}
        </p>
      ) : null}

      {notice ? <p role="status">{notice}</p> : null}

      {pendingRedeploy ? (
        <p
          style={{
            background: '#fff6e0',
            border: '1px solid #e0b000',
            borderRadius: '0.4rem',
            padding: '0.75rem',
          }}
        >
          The running server still uses the old settings until it is redeployed.{' '}
          <button style={small} onClick={redeploy} disabled={busy}>
            Redeploy now
          </button>
        </p>
      ) : null}

      {envs ? (
        <>
          <h2>Add or replace</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
            autoComplete="off"
          >
            <input
              style={field}
              value={name}
              placeholder="Name, e.g. NOTION_EXCEPTIONS_TOKEN"
              spellCheck={false}
              autoCapitalize="characters"
              onChange={(event) => setName(event.target.value)}
            />
            <input
              style={field}
              type="password"
              value={value}
              placeholder="Value"
              autoComplete="new-password"
              onChange={(event) => setValue(event.target.value)}
            />
            <button style={button} type="submit" disabled={busy || !name.trim() || !value}>
              Save
            </button>
          </form>
          <p style={{ fontSize: '0.9rem', color: '#555' }}>
            Saving a name that already exists replaces its value. It applies to production and
            preview deployments.
          </p>

          <h2>Current settings</h2>
          {envs.length === 0 ? <p>None yet.</p> : null}
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {envs.map((env) => (
              <li
                key={env.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.4rem 0',
                  borderBottom: '1px solid #eee',
                }}
              >
                <span style={{ overflowWrap: 'anywhere' }}>
                  <code>{env.key}</code>
                  <br />
                  <span style={{ fontSize: '0.85rem', color: '#555' }}>
                    {env.target.join(', ') || 'no environment'}
                    {env.updatedAt ? ` · changed ${new Date(env.updatedAt).toLocaleDateString('en-GB')}` : ''}
                  </span>
                </span>
                {env.locked ? (
                  <span style={{ fontSize: '0.85rem', color: '#555' }}>Dashboard only</span>
                ) : (
                  <button style={small} onClick={() => remove(env)} disabled={busy}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
