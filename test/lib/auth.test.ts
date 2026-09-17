import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

import {
  authenticate,
  challengeHeader,
  resetKeyCache,
  type AuthFailure,
} from '../../lib/auth.js';
import { metadataUrl, protectedResourceMetadata } from '../../lib/metadata.js';

const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'https://icloud-mcp.example.com/api/mcp';

let privateKey: CryptoKey;
let publicJwk: JWK;

// The auth module fetches the issuer's public keys over HTTPS. Stubbing fetch
// lets the tests sign real tokens against a real key pair without a network.
function stubJwksFetch(jwk: JWK) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
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
  stubJwksFetch(publicJwk);

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
