import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

// The real createRemoteJWKSet fetches over the network. Here it resolves to a
// key pair generated in the test, so token verification runs for real against a
// key we control.
const jwksState = vi.hoisted(() => ({ publicKey: undefined as unknown }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => jwksState.publicKey,
  };
});

const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'https://icloud-mcp.example.com/api/mcp';

let privateKey: CryptoKey;
let publicJwk: JWK;

async function sign(claims: Record<string, unknown>, overrides: { issuer?: string; audience?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject('user-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function freshAuth() {
  vi.resetModules();
  return import('../../lib/auth.js');
}

beforeEach(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = await exportJWK(pair.publicKey);
  jwksState.publicKey = pair.publicKey;

  process.env.OAUTH_ISSUER = ISSUER;
  process.env.OAUTH_AUDIENCE = AUDIENCE;
  // Most tests are about token checking, not key lookup, so the override short-
  // circuits discovery. The discovery suite below clears it.
  process.env.OAUTH_JWKS_URI = `${ISSUER}/oauth2/jwks`;
  delete process.env.OAUTH_REQUIRED_SCOPE;
  delete process.env.MCP_AUTH_TOKEN;
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.OAUTH_ISSUER;
  delete process.env.OAUTH_AUDIENCE;
  delete process.env.OAUTH_JWKS_URI;
  delete process.env.OAUTH_REQUIRED_SCOPE;
  delete process.env.MCP_AUTH_TOKEN;
  vi.unstubAllGlobals();
});

describe('authenticate — OAuth access tokens', () => {
  it('accepts a token with the right issuer, audience and scope', async () => {
    const { authenticate } = await freshAuth();
    const token = await sign({ scope: 'mcp:access other:scope' });

    const result = await authenticate(`Bearer ${token}`);

    expect(result.authorized).toBe(true);
    if (result.authorized) {
      expect(result.info.scheme).toBe('oauth');
      expect(result.info.subject).toBe('user-123');
      expect(result.info.scopes).toContain('mcp:access');
    }
  });

  it('accepts scopes given as an array in the scp claim', async () => {
    const { authenticate } = await freshAuth();
    const token = await sign({ scp: ['mcp:access'] });

    expect((await authenticate(`Bearer ${token}`)).authorized).toBe(true);
  });

  it('rejects a token minted for a different audience', async () => {
    const { authenticate } = await freshAuth();
    const token = await sign({ scope: 'mcp:access' }, { audience: 'https://someone-elses-api.example.com' });

    const result = await authenticate(`Bearer ${token}`);

    expect(result).toMatchObject({ authorized: false, error: 'invalid_token' });
  });

  it('rejects a token from a different issuer', async () => {
    const { authenticate } = await freshAuth();
    const token = await sign({ scope: 'mcp:access' }, { issuer: 'https://evil.example.com' });

    expect((await authenticate(`Bearer ${token}`)).authorized).toBe(false);
  });

  it('rejects an expired token', async () => {
    const { authenticate } = await freshAuth();
    const token = await new SignJWT({ scope: 'mcp:access' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    expect((await authenticate(`Bearer ${token}`)).authorized).toBe(false);
  });

  it('rejects a token signed by an unknown key', async () => {
    const { authenticate } = await freshAuth();
    const other = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({ scope: 'mcp:access' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(other.privateKey);

    expect((await authenticate(`Bearer ${token}`)).authorized).toBe(false);
  });

  it('returns insufficient_scope when the required scope is missing', async () => {
    const { authenticate } = await freshAuth();
    const token = await sign({ scope: 'some:other-scope' });

    const result = await authenticate(`Bearer ${token}`);

    expect(result).toMatchObject({ authorized: false, error: 'insufficient_scope' });
  });

  it('skips the scope check when OAUTH_REQUIRED_SCOPE is set to empty', async () => {
    process.env.OAUTH_REQUIRED_SCOPE = '';
    const { authenticate } = await freshAuth();
    const token = await sign({});

    expect((await authenticate(`Bearer ${token}`)).authorized).toBe(true);
  });

  it('honours a custom required scope', async () => {
    process.env.OAUTH_REQUIRED_SCOPE = 'icloud:full';
    const { authenticate } = await freshAuth();

    expect((await authenticate(`Bearer ${await sign({ scope: 'icloud:full' })}`)).authorized).toBe(true);
    expect((await authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`)).authorized).toBe(false);
  });

  it('reports a missing header as invalid_request', async () => {
    const { authenticate } = await freshAuth();

    expect(await authenticate(undefined)).toMatchObject({ authorized: false, error: 'invalid_request' });
    expect(await authenticate('Basic abc')).toMatchObject({ authorized: false, error: 'invalid_request' });
  });

  it('accepts a lower-case bearer prefix', async () => {
    const { authenticate } = await freshAuth();

    expect((await authenticate(`bearer ${await sign({ scope: 'mcp:access' })}`)).authorized).toBe(true);
  });

  it('reads the first value when the header arrives as an array', async () => {
    const { authenticate } = await freshAuth();
    const token = await sign({ scope: 'mcp:access' });

    expect((await authenticate([`Bearer ${token}`, 'Bearer ignored'])).authorized).toBe(true);
  });
});

describe('authenticate — legacy shared secret', () => {
  it('accepts the legacy token while MCP_AUTH_TOKEN is set', async () => {
    process.env.MCP_AUTH_TOKEN = 'legacy-secret-value';
    const { authenticate } = await freshAuth();

    const result = await authenticate('Bearer legacy-secret-value');

    expect(result.authorized).toBe(true);
    if (result.authorized) expect(result.info.scheme).toBe('legacy-token');
  });

  it('rejects a wrong legacy token', async () => {
    process.env.MCP_AUTH_TOKEN = 'legacy-secret-value';
    const { authenticate } = await freshAuth();

    expect((await authenticate('Bearer wrong-value')).authorized).toBe(false);
  });

  it('rejects the legacy token once MCP_AUTH_TOKEN is unset', async () => {
    const { authenticate } = await freshAuth();

    expect((await authenticate('Bearer legacy-secret-value')).authorized).toBe(false);
  });

  it('still accepts OAuth tokens while the legacy secret is set', async () => {
    process.env.MCP_AUTH_TOKEN = 'legacy-secret-value';
    const { authenticate } = await freshAuth();

    expect((await authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`)).authorized).toBe(true);
  });

  it('works with only the legacy secret configured', async () => {
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_AUDIENCE;
    process.env.MCP_AUTH_TOKEN = 'legacy-secret-value';
    const { authenticate } = await freshAuth();

    expect((await authenticate('Bearer legacy-secret-value')).authorized).toBe(true);
    expect((await authenticate('Bearer nope')).authorized).toBe(false);
  });
});

describe('authenticate — configuration errors', () => {
  it('throws when nothing is configured', async () => {
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_AUDIENCE;
    const { authenticate } = await freshAuth();

    await expect(authenticate('Bearer anything')).rejects.toThrow(/No authentication is configured/);
  });

  it('throws when the issuer is set without an audience', async () => {
    delete process.env.OAUTH_AUDIENCE;
    const { authenticate } = await freshAuth();

    await expect(authenticate('Bearer anything')).rejects.toThrow(/OAUTH_AUDIENCE/);
  });
});

describe('signing key discovery', () => {
  function mockFetch(responses: Record<string, { status: number; body?: unknown }>) {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const match = responses[url];
      if (!match) return new Response('not found', { status: 404 });
      return new Response(match.body === undefined ? '' : JSON.stringify(match.body), {
        status: match.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads jwks_uri from the RFC 8414 authorization server metadata', async () => {
    delete process.env.OAUTH_JWKS_URI;
    const fetchMock = mockFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: {
        status: 200,
        body: { issuer: ISSUER, jwks_uri: `${ISSUER}/oauth2/jwks` },
      },
    });
    const { authenticate } = await freshAuth();

    expect((await authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`)).authorized).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/oauth-authorization-server`,
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  it('falls back to the OpenID Connect document when the OAuth one is absent', async () => {
    delete process.env.OAUTH_JWKS_URI;
    const fetchMock = mockFetch({
      [`${ISSUER}/.well-known/openid-configuration`]: {
        status: 200,
        body: { issuer: ISSUER, jwks_uri: `${ISSUER}/keys` },
      },
    });
    const { authenticate } = await freshAuth();

    expect((await authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`)).authorized).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches the discovered URL instead of refetching on every request', async () => {
    delete process.env.OAUTH_JWKS_URI;
    const fetchMock = mockFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: {
        status: 200,
        body: { jwks_uri: `${ISSUER}/oauth2/jwks` },
      },
    });
    const { authenticate } = await freshAuth();

    await authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`);
    await authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips discovery entirely when OAUTH_JWKS_URI is set', async () => {
    const fetchMock = mockFetch({});
    const { authenticate } = await freshAuth();

    expect((await authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`)).authorized).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('raises a configuration error, not a token error, when discovery fails', async () => {
    delete process.env.OAUTH_JWKS_URI;
    mockFetch({});
    const { authenticate } = await freshAuth();

    await expect(authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`)).rejects.toThrow(
      /Could not discover signing keys.*OAUTH_JWKS_URI/s,
    );
  });

  it('raises a configuration error when the document omits jwks_uri', async () => {
    delete process.env.OAUTH_JWKS_URI;
    mockFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: { status: 200, body: { issuer: ISSUER } },
    });
    const { authenticate } = await freshAuth();

    await expect(authenticate(`Bearer ${await sign({ scope: 'mcp:access' })}`)).rejects.toThrow(/no jwks_uri/);
  });

  it('does not attempt discovery when the legacy secret matches', async () => {
    delete process.env.OAUTH_JWKS_URI;
    process.env.MCP_AUTH_TOKEN = 'legacy-secret-value';
    const fetchMock = mockFetch({});
    const { authenticate } = await freshAuth();

    expect((await authenticate('Bearer legacy-secret-value')).authorized).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('challengeHeader', () => {
  it('includes the resource metadata URL so clients can discover the flow', async () => {
    const { challengeHeader } = await freshAuth();

    const header = challengeHeader('https://example.com/.well-known/oauth-protected-resource/api/mcp');

    expect(header).toContain('Bearer realm="mcp"');
    expect(header).toContain('resource_metadata="https://example.com/.well-known/oauth-protected-resource/api/mcp"');
  });

  it('adds the error and a quote-safe description', async () => {
    const { challengeHeader } = await freshAuth();

    const header = challengeHeader('https://example.com/meta', 'invalid_token', 'bad "token" here');

    expect(header).toContain('error="invalid_token"');
    expect(header).toContain(`error_description="bad 'token' here"`);
  });
});

describe('metadata helpers', () => {
  it('reports the configured issuer and resource', async () => {
    const { authorizationServers, resourceIdentifier, oauthConfigured } = await freshAuth();

    expect(authorizationServers()).toEqual([ISSUER]);
    expect(resourceIdentifier()).toBe(AUDIENCE);
    expect(oauthConfigured()).toBe(true);
  });

  it('strips a trailing slash from the issuer', async () => {
    process.env.OAUTH_ISSUER = `${ISSUER}/`;
    const { authorizationServers } = await freshAuth();

    expect(authorizationServers()).toEqual([ISSUER]);
  });

  it('exposes a usable public JWK for the generated key', () => {
    expect(publicJwk.kty).toBe('RSA');
  });
});
