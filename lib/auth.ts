import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/**
 * Access control for the public MCP endpoint. Two routes are accepted:
 *
 *  1. An OAuth 2.1 access token issued by the authorization server named in
 *     OAUTH_ISSUER. This is the route MCP clients use; the server acts as a
 *     resource server per the MCP authorization spec and validates the token
 *     signature, issuer, audience and scope on every request.
 *  2. The legacy MCP_AUTH_TOKEN shared secret, kept as a fallback for scripts
 *     and scheduled runs that cannot complete an interactive sign-in.
 *
 * Both arrive in the same `Authorization: Bearer <token>` header, so an OAuth
 * verification failure falls through to the shared-secret comparison rather
 * than rejecting outright.
 */

export type AuthFailureReason = 'missing_token' | 'invalid_token' | 'insufficient_scope';

export interface AuthSuccess {
  ok: true;
  /** How the caller proved itself, for logging and for tests. */
  method: 'oauth' | 'shared_secret';
  /** The `sub` claim of an OAuth token; null for the shared secret. */
  subject: string | null;
  scopes: string[];
}

export interface AuthFailure {
  ok: false;
  reason: AuthFailureReason;
  status: 401 | 403;
  /** Never surfaced to the caller; for server-side logging only. */
  detail: string;
  /** Scopes the caller must obtain, when the failure is about scope. */
  requiredScopes: string[];
}

export type AuthResult = AuthSuccess | AuthFailure;

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function isOAuthConfigured(): boolean {
  return Boolean(optionalEnv('OAUTH_ISSUER') && optionalEnv('OAUTH_AUDIENCE'));
}

export function isSharedSecretConfigured(): boolean {
  return Boolean(optionalEnv('MCP_AUTH_TOKEN'));
}

/**
 * Scopes a caller must hold. Empty when OAUTH_REQUIRED_SCOPE is unset, which
 * means any validly issued token for this audience is accepted.
 */
export function requiredScopes(): string[] {
  const raw = optionalEnv('OAUTH_REQUIRED_SCOPE');
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

/** The canonical URI of this MCP server, used as the expected token audience. */
export function resourceIdentifier(): string {
  const audience = optionalEnv('OAUTH_AUDIENCE');
  if (!audience) {
    throw new Error('OAUTH_AUDIENCE is not set');
  }
  return audience.replace(/\/+$/, '');
}

export function issuer(): string {
  const value = optionalEnv('OAUTH_ISSUER');
  if (!value) {
    throw new Error('OAUTH_ISSUER is not set');
  }
  return value.replace(/\/+$/, '');
}

/**
 * Where the authorization server publishes its metadata. Derived from the
 * issuer unless OAUTH_JWKS_URI pins the key set explicitly.
 */
function jwksUri(): URL {
  const pinned = optionalEnv('OAUTH_JWKS_URI');
  return new URL(pinned ?? `${issuer()}/.well-known/jwks.json`);
}

// The key set caches keys and rate-limits refetches, so it is built once per
// process rather than per request. Keyed by URI so a config change in tests
// does not reuse a stale set.
const jwksCache = new Map<string, JWTVerifyGetKey>();

function keySet(): JWTVerifyGetKey {
  const uri = jwksUri().toString();
  let existing = jwksCache.get(uri);
  if (!existing) {
    existing = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, existing);
  }
  return existing;
}

/** Test seam: drops cached JWKS so a changed issuer takes effect. */
export function resetKeyCache(): void {
  jwksCache.clear();
}

function extractBearer(authHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header) {
    return null;
  }
  // The scheme is case-insensitive per RFC 6750.
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Scopes carried by a verified token. Handles both the space-delimited `scope`
 * string of RFC 8693 and the array-valued `scp` claim some providers emit.
 */
function scopesFrom(payload: JWTPayload): string[] {
  const scope = payload.scope;
  if (typeof scope === 'string') {
    return scope.split(/\s+/).filter(Boolean);
  }
  const scp = (payload as Record<string, unknown>).scp;
  if (Array.isArray(scp)) {
    return scp.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof scp === 'string') {
    return scp.split(/\s+/).filter(Boolean);
  }
  return [];
}

function matchesSharedSecret(provided: string): boolean {
  const expected = optionalEnv('MCP_AUTH_TOKEN');
  if (!expected) {
    return false;
  }

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function authenticate(
  authHeader: string | string[] | undefined,
): Promise<AuthResult> {
  if (!isOAuthConfigured() && !isSharedSecretConfigured()) {
    throw new Error('No authentication is configured: set OAUTH_ISSUER and OAUTH_AUDIENCE, or MCP_AUTH_TOKEN');
  }

  const token = extractBearer(authHeader);
  if (!token) {
    return {
      ok: false,
      reason: 'missing_token',
      status: 401,
      detail: 'No bearer token in the Authorization header',
      requiredScopes: requiredScopes(),
    };
  }

  let oauthDetail = 'OAuth is not configured';

  if (isOAuthConfigured()) {
    try {
      const { payload } = await jwtVerify(token, keySet(), {
        issuer: issuer(),
        // Binds the token to this server. Without it, a token minted for a
        // different resource behind the same issuer would be accepted here.
        audience: resourceIdentifier(),
      });

      const granted = scopesFrom(payload);
      const needed = requiredScopes();
      const missing = needed.filter((scope) => !granted.includes(scope));

      if (missing.length > 0) {
        return {
          ok: false,
          reason: 'insufficient_scope',
          status: 403,
          detail: `Token is missing scope: ${missing.join(' ')}`,
          requiredScopes: needed,
        };
      }

      return {
        ok: true,
        method: 'oauth',
        subject: typeof payload.sub === 'string' ? payload.sub : null,
        scopes: granted,
      };
    } catch (error) {
      // Not a valid token for this issuer. It may still be the shared secret,
      // so record why and fall through instead of returning.
      oauthDetail = error instanceof Error ? error.message : 'Token verification failed';
    }
  }

  if (matchesSharedSecret(token)) {
    return { ok: true, method: 'shared_secret', subject: null, scopes: [] };
  }

  return {
    ok: false,
    reason: 'invalid_token',
    status: 401,
    detail: oauthDetail,
    requiredScopes: requiredScopes(),
  };
}

/**
 * The `WWW-Authenticate` value for a rejected request. Points clients at the
 * protected resource metadata document so they can discover where to sign in.
 */
export function challengeHeader(failure: AuthFailure, metadataUrl: string): string {
  const parts = [`Bearer resource_metadata="${metadataUrl}"`];

  if (failure.reason === 'insufficient_scope') {
    parts.push('error="insufficient_scope"');
  } else if (failure.reason === 'invalid_token') {
    parts.push('error="invalid_token"');
  }

  if (failure.requiredScopes.length > 0) {
    parts.push(`scope="${failure.requiredScopes.join(' ')}"`);
  }

  return parts.join(', ');
}
