import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

import {
  authenticate,
  challengeHeader,
  discoverAuthServer,
  resetKeyCache,
  type AuthFailure,
} from '../../lib/auth.js';
import { metadataUrl, protectedResourceMetadata } from '../../lib/metadata.js';

const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'https://icloud-mcp.example.com/api/mcp';

let privateKey: CryptoKey;
let publicJwk: JWK;

const JWKS_URL = `${ISSUER}/oauth2/jwks`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stands in for the authorization server: it serves an RFC 8414 discovery
 * document pointing at a non-standard key path (as WorkOS does), then the keys
 * themselves. Stubbing fetch lets the tests sign real tokens against a real key
 * pair without touching the network.
 */
function stubAuthServer(
  jwk: JWK,
  options: { discoveryStatus?: number; publishedIssuer?: string } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      if (options.discoveryStatus && options.discoveryStatus !== 200) {
        return json({ error: 'not found' }, options.discoveryStatus);
      }
      return json({ issuer: options.publishedIssuer ?? ISSUER, jwks_uri: JWKS_URL });
    }

    if (url === JWKS_URL) {
      return json({ keys: [jwk] });
    }

    return json({ error: 'unexpected request' }, 404);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function signToken(claims: Record<string, unknown> = {}, overrides: {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
} = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .setSubject('user-123')
    .sign(privateKey);
}

beforeEach(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.kid = 'test-key';

  resetKeyCache();
  stubAuthServer(publicJwk);

  process.env.OAUTH_ISSUER = ISSUER;
  process.env.OAUTH_AUDIENCE = AUDIENCE;
  delete process.env.OAUTH_REQUIRED_SCOPE;
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.OAUTH_JWKS_URI;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authenticate — OAuth tokens', () => {
  it('accepts a token signed by the issuer for this audience', async () => {
    const result = await authenticate(`Bearer ${await signToken()}`);
    expect(result).toMatchObject({ ok: true, method: 'oauth', subject: 'user-123' });
  });

  it('reads the Bearer scheme case-insensitively', async () => {
    const result = await authenticate(`bearer ${await signToken()}`);
    expect(result.ok).toBe(true);
  });

  it('rejects a token minted for a different audience', async () => {
    const token = await signToken({}, { audience: 'https://someone-else.example.com' });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token', status: 401 });
  });

  it('rejects a token from a different issuer', async () => {
    const token = await signToken({}, { issuer: 'https://evil.example.com' });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('rejects an expired token', async () => {
    const token = await signToken({}, { expiresIn: '-1m' });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('rejects a token signed by a key the issuer does not publish', async () => {
    const other = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(other.privateKey);

    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('reports 401 with no token at all', async () => {
    const result = await authenticate(undefined);
    expect(result).toMatchObject({ ok: false, reason: 'missing_token', status: 401 });
  });
});

describe('authenticate — scopes', () => {
  beforeEach(() => {
    process.env.OAUTH_REQUIRED_SCOPE = 'icloud:read icloud:write';
  });

  it('accepts a token carrying every required scope in the scope claim', async () => {
    const token = await signToken({ scope: 'icloud:read icloud:write extra' });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: true, method: 'oauth' });
  });

  it('accepts the array-valued scp claim some providers emit', async () => {
    const token = await signToken({ scp: ['icloud:read', 'icloud:write'] });
    const result = await authenticate(`Bearer ${token}`);
    expect(result.ok).toBe(true);
  });

  it('returns 403 insufficient_scope when a scope is missing', async () => {
    const token = await signToken({ scope: 'icloud:read' });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({
      ok: false,
      reason: 'insufficient_scope',
      status: 403,
      requiredScopes: ['icloud:read', 'icloud:write'],
    });
  });
});

describe('authenticate — shared secret fallback', () => {
  it('accepts the shared secret when OAuth verification fails', async () => {
    process.env.MCP_AUTH_TOKEN = 'a-long-random-shared-secret';
    const result = await authenticate('Bearer a-long-random-shared-secret');
    expect(result).toMatchObject({ ok: true, method: 'shared_secret', subject: null });
  });

  it('works with OAuth switched off entirely', async () => {
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_AUDIENCE;
    process.env.MCP_AUTH_TOKEN = 'a-long-random-shared-secret';

    const ok = await authenticate('Bearer a-long-random-shared-secret');
    expect(ok).toMatchObject({ ok: true, method: 'shared_secret' });

    const bad = await authenticate('Bearer nope');
    expect(bad).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('rejects a wrong secret of the same length', async () => {
    process.env.MCP_AUTH_TOKEN = 'aaaaaaaaaaaaaaaa';
    const result = await authenticate('Bearer bbbbbbbbbbbbbbbb');
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('still rejects a valid OAuth token that lacks a required scope', async () => {
    // The fallback must not become a way around scope checks.
    process.env.OAUTH_REQUIRED_SCOPE = 'icloud:write';
    process.env.MCP_AUTH_TOKEN = 'a-long-random-shared-secret';

    const token = await signToken({ scope: 'icloud:read' });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_scope' });
  });

  it('throws when neither route is configured', async () => {
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_AUDIENCE;
    await expect(authenticate('Bearer anything')).rejects.toThrow(/No authentication is configured/);
  });
});

describe('discovering the signing keys', () => {
  it('reads jwks_uri from the issuer metadata rather than guessing a path', async () => {
    // WorkOS publishes keys at /oauth2/jwks, not /.well-known/jwks.json.
    await expect(discoverAuthServer()).resolves.toMatchObject({ jwksUri: JWKS_URL });
  });

  it('falls back to the OpenID Connect document when RFC 8414 is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${ISSUER}/.well-known/openid-configuration`) {
          return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` });
        }
        return json({ error: 'not found' }, 404);
      }),
    );
    resetKeyCache();
    await expect(discoverAuthServer()).resolves.toMatchObject({ jwksUri: `${ISSUER}/keys` });
  });

  it('refuses a discovery document published by a different issuer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ issuer: 'https://evil.example.com', jwks_uri: 'https://evil.example.com/keys' })),
    );
    resetKeyCache();
    await expect(discoverAuthServer()).rejects.toThrow(/published by https:\/\/evil\.example\.com/);
  });

  it('skips discovery entirely when OAUTH_JWKS_URI is pinned', async () => {
    process.env.OAUTH_JWKS_URI = 'https://pinned.example.com/keys';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resetKeyCache();

    await expect(discoverAuthServer()).resolves.toMatchObject({ jwksUri: 'https://pinned.example.com/keys' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a trailing slash the provider publishes, as Auth0 does', async () => {
    stubAuthServer(publicJwk, { publishedIssuer: `${ISSUER}/` });
    resetKeyCache();
    await expect(discoverAuthServer()).resolves.toMatchObject({ issuer: `${ISSUER}/` });
  });

  it('accepts an Auth0-style token whose iss claim carries a trailing slash', async () => {
    // OAUTH_ISSUER is set without the slash, but Auth0 signs tokens with one.
    // Validation must follow what the provider publishes, not what was typed in.
    stubAuthServer(publicJwk, { publishedIssuer: `${ISSUER}/` });
    resetKeyCache();

    const token = await signToken({}, { issuer: `${ISSUER}/` });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: true, method: 'oauth' });
  });

  it('still rejects a token whose issuer differs by more than a trailing slash', async () => {
    stubAuthServer(publicJwk, { publishedIssuer: `${ISSUER}/` });
    resetKeyCache();

    const token = await signToken({}, { issuer: 'https://auth.example.com.evil.test/' });
    const result = await authenticate(`Bearer ${token}`);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('does not cache a failed lookup, so a later request can recover', async () => {
    stubAuthServer(publicJwk, { discoveryStatus: 500 });
    resetKeyCache();
    await expect(discoverAuthServer()).rejects.toThrow();

    stubAuthServer(publicJwk);
    const result = await authenticate(`Bearer ${await signToken()}`);
    expect(result).toMatchObject({ ok: true, method: 'oauth' });
  });

  it('explains which URLs it tried when discovery fails', async () => {
    stubAuthServer(publicJwk, { discoveryStatus: 500 });
    resetKeyCache();
    await expect(discoverAuthServer()).rejects.toThrow(/Could not reach the authorization server/);
  });

  it('rejects a request when the keys cannot be found', async () => {
    stubAuthServer(publicJwk, { discoveryStatus: 500 });
    resetKeyCache();
    const result = await authenticate(`Bearer ${await signToken()}`);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' });
  });
});

describe('challengeHeader', () => {
  const metadata = 'https://icloud-mcp.example.com/.well-known/oauth-protected-resource';

  it('points at the metadata document on a missing token', () => {
    const failure: AuthFailure = {
      ok: false,
      reason: 'missing_token',
      status: 401,
      detail: '',
      requiredScopes: [],
    };
    expect(challengeHeader(failure, metadata)).toBe(`Bearer resource_metadata="${metadata}"`);
  });

  it('names the error and the scopes needed on an insufficient scope', () => {
    const failure: AuthFailure = {
      ok: false,
      reason: 'insufficient_scope',
      status: 403,
      detail: '',
      requiredScopes: ['icloud:read', 'icloud:write'],
    };
    const header = challengeHeader(failure, metadata);
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="icloud:read icloud:write"');
  });
});

describe('protected resource metadata', () => {
  it('advertises the issuer and the canonical resource URI', () => {
    expect(protectedResourceMetadata()).toEqual({
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
    });
  });

  it('lists the required scopes when some are configured', () => {
    process.env.OAUTH_REQUIRED_SCOPE = 'icloud:read';
    expect(protectedResourceMetadata().scopes_supported).toEqual(['icloud:read']);
  });

  it('builds the metadata URL from the audience origin, not its path', () => {
    expect(metadataUrl('ignored.example.com')).toBe(
      'https://icloud-mcp.example.com/.well-known/oauth-protected-resource',
    );
  });

  it('falls back to the request host before OAuth is configured', () => {
    delete process.env.OAUTH_AUDIENCE;
    expect(metadataUrl('fallback.example.com')).toBe(
      'https://fallback.example.com/.well-known/oauth-protected-resource',
    );
  });
});
