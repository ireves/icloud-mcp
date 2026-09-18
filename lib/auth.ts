import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/**
 * Access control for the public MCP endpoint.
 *
 * One route is accepted: an OAuth 2.1 access token issued by the
 * authorization server named in OAUTH_ISSUER. The server acts as a resource
 * server per the MCP authorization spec, validating the token's signature,
 * issuer, audience and scope on every request.
 *
 * There is deliberately no shared-secret alternative. One long-lived string
 * that unlocks every tool is exactly what an attacker who reads it once needs,
 * and it cannot be scoped, attributed to a person, or expired. A caller that
 * cannot complete an interactive sign-in should use a token issued to it by
 * the authorization server instead.
 */

export type AuthFailureReason = 'missing_token' | 'invalid_token' | 'insufficient_scope';

export interface AuthSuccess {
  ok: true;
  /** How the caller proved itself, for logging and for tests. */
  method: 'oauth';
  /** The `sub` claim of the token, when it carries one. */
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

/** What the issuer's discovery document tells us about it. */
export interface AuthServerMetadata {
  /**
   * The issuer exactly as the authorization server publishes it, which is what
   * appears in the `iss` claim of its tokens. Auth0 publishes a trailing slash
   * (`https://tenant.auth0.com/`) and most others do not, so the published form
   * is kept verbatim rather than normalised.
   */
  issuer: string;
  jwksUri: string;
}

/**
 * Asks the authorization server where its signing keys are and what it calls
 * itself.
 *
 * Providers disagree on both. WorkOS serves keys at `/oauth2/jwks` and Auth0 at
 * `/.well-known/jwks.json`; Auth0 puts a trailing slash on its issuer and WorkOS
 * does not. Rather than hard-code either, read the RFC 8414 document (falling
 * back to OpenID Connect Discovery) and take the provider at its word.
 *
 * OAUTH_JWKS_URI skips discovery for a provider that publishes neither document.
 */
export async function discoverAuthServer(): Promise<AuthServerMetadata> {
  const base = issuer();
  const pinned = optionalEnv('OAUTH_JWKS_URI');

  if (pinned) {
    // No document to consult, so accept the configured issuer as published.
    return { issuer: base, jwksUri: new URL(pinned).toString() };
  }

  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];

  const failures: string[] = [];

  for (const url of candidates) {
    let document: unknown;
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        failures.push(`${url} returned ${response.status}`);
        continue;
      }
      document = await response.json();
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : 'unreachable'}`);
      continue;
    }

    const metadata = document as { issuer?: unknown; jwks_uri?: unknown };

    if (typeof metadata.jwks_uri !== 'string') {
      failures.push(`${url} does not advertise a jwks_uri`);
      continue;
    }

    // RFC 8414 requires the issuer in the document to match the one we asked
    // about. Compare ignoring a trailing slash, since that is a formatting
    // difference between providers rather than a different issuer, but keep the
    // published form for validating tokens.
    const published = typeof metadata.issuer === 'string' ? metadata.issuer : base;
    if (published.replace(/\/+$/, '') !== base) {
      failures.push(`${url} is published by ${published}, not ${base}`);
      continue;
    }

    return { issuer: published, jwksUri: new URL(metadata.jwks_uri).toString() };
  }

  throw new Error(`Could not reach the authorization server at ${base}. Tried: ${failures.join('; ')}`);
}

// Discovery and the key set are cached per issuer: the keys rate-limit their own
// refetches, and the document rarely changes. Keyed so a config change in tests
// does not reuse a stale entry.
const serverCache = new Map<string, Promise<{ metadata: AuthServerMetadata; keys: JWTVerifyGetKey }>>();

function authServer(): Promise<{ metadata: AuthServerMetadata; keys: JWTVerifyGetKey }> {
  const cacheKey = `${issuer()}|${optionalEnv('OAUTH_JWKS_URI') ?? ''}`;
  let existing = serverCache.get(cacheKey);
  if (!existing) {
    existing = discoverAuthServer()
      .then((metadata) => ({ metadata, keys: createRemoteJWKSet(new URL(metadata.jwksUri)) }))
      // A failed lookup must not be cached, or one outage would stick until the
      // next deployment.
      .catch((error) => {
        serverCache.delete(cacheKey);
        throw error;
      });
    serverCache.set(cacheKey, existing);
  }
  return existing;
}

/** Test seam: drops cached keys so a changed issuer takes effect. */
export function resetKeyCache(): void {
  serverCache.clear();
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

export async function authenticate(
  authHeader: string | string[] | undefined,
): Promise<AuthResult> {
  // Nothing configured means nothing can be verified. The endpoint is public,
  // so it refuses everything rather than serving an unauthenticated caller.
  if (!isOAuthConfigured()) {
    console.error(
      'MCP authentication is not configured: set OAUTH_ISSUER and OAUTH_AUDIENCE. ' +
        'Every request is rejected until they are set.',
    );
    return {
      ok: false,
      reason: 'invalid_token',
      status: 401,
      detail: 'OAuth is not configured on this deployment',
      requiredScopes: [],
    };
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

  try {
    const { metadata, keys } = await authServer();
    const { payload } = await jwtVerify(token, keys, {
      // The issuer exactly as the provider publishes it, not as it was typed
      // into the environment.
      issuer: metadata.issuer,
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
    // Not a valid token for this issuer, and there is nothing else to try.
    return {
      ok: false,
      reason: 'invalid_token',
      status: 401,
      detail: error instanceof Error ? error.message : 'Token verification failed',
      requiredScopes: requiredScopes(),
    };
  }
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
