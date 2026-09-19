'use client';

// The one screen that shows what is being connected before anything is granted.
//
// It names the client and, just as importantly, the address the browser will be
// sent back to. A client identified by a metadata document is only as
// trustworthy as that address, and a local one can be claimed by any program on
// the machine, so both are shown plainly rather than buried.

import { useEffect, useState, type CSSProperties } from 'react';
import { authClient } from '@/lib/auth-client';

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'Read your name',
  email: 'Read your email address',
  offline_access: 'Stay connected without signing in again',
  icloud: 'Read and file your iCloud mail, and read and change your calendar and reminders',
};

const button: CSSProperties = {
  font: 'inherit',
  padding: '0.6rem 1rem',
  borderRadius: '0.4rem',
  border: '1px solid #1a1a1a',
  background: '#1a1a1a',
  color: '#fff',
  cursor: 'pointer',
  marginRight: '0.5rem',
};

const secondary: CSSProperties = { ...button, background: 'transparent', color: '#1a1a1a' };

interface Details {
  clientId: string;
  redirectHost: string;
  isLoopback: boolean;
  scopes: string[];
  name: string;
}

export default function ConsentForm() {
  const [query, setQuery] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const search = window.location.search.replace(/^\?/, '');
    setQuery(search);

    const params = new URLSearchParams(search);
    const clientId = params.get('client_id') || '';
    const redirectUri = params.get('redirect_uri') || '';
    const scopes = (params.get('scope') || '').split(' ').filter(Boolean);

    let redirectHost = redirectUri;
    let isLoopback = false;
    try {
      const url = new URL(redirectUri);
      redirectHost = url.host;
      isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
      // Leave the raw value on show rather than hiding something unparseable.
    }

    setDetails({ clientId, redirectHost, isLoopback, scopes, name: clientId });

    // The client's own name, if it registered one. The server answers in OAuth's
    // own spelling, `client_name`, so that is what is read here. Failing to get
    // it is not an error worth blocking on: the client ID is already on show,
    // and it is the redirect address below that actually matters.
    authClient
      .$fetch(`/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
      .then((result) => {
        const data = (result as { data?: { client_name?: string; name?: string } })?.data;
        const name = data?.client_name || data?.name;
        if (name) setDetails((current) => (current ? { ...current, name } : current));
      })
      .catch(() => {});
  }, []);

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    const result = (await authClient.$fetch('/oauth2/consent', {
      method: 'POST',
      body: { accept, oauth_query: query },
    })) as { data?: { url?: string; redirectURI?: string }; error?: { message?: string } };
    const redirectTo = result?.data?.url || result?.data?.redirectURI;
    if (result?.error || !redirectTo) {
      setBusy(false);
      setError(result?.error?.message || 'That could not be completed.');
      return;
    }
    window.location.href = redirectTo;
  }

  if (!details) return <p>Loading…</p>;

  return (
    <>
      <p>
        <strong>{details.name}</strong> wants to connect to your iCloud mail,
        calendar and reminders.
      </p>

      <p>
        It will be sent back to <strong>{details.redirectHost}</strong>.
      </p>

      {details.isLoopback ? (
        <p
          style={{
            background: '#fff6e0',
            border: '1px solid #e0b000',
            borderRadius: '0.4rem',
            padding: '0.75rem',
          }}
        >
          That address is this device. Any program running on it could be asking,
          not only the app you recognise. Continue only if you just started this
          yourself.
        </p>
      ) : null}

      <p>It is asking to:</p>
      <ul>
        {details.scopes.map((scope) => (
          <li key={scope}>{SCOPE_LABELS[scope] || scope}</li>
        ))}
      </ul>

      <button style={button} onClick={() => decide(true)} disabled={busy}>
        {busy ? 'One moment…' : 'Allow'}
      </button>
      <button style={secondary} onClick={() => decide(false)} disabled={busy}>
        Refuse
      </button>

      {error ? (
        <p style={{ color: '#b00020', marginTop: '1rem' }} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
