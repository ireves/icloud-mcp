import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Request authentication for this MCP server.
 *
 * The primary scheme is OAuth 2.1: an external authorization server (Auth0,
 * Clerk, WorkOS, Okta, Keycloak — anything publishing standard OpenID Connect
 * discovery metadata) issues short-lived access tokens, and this server only
 * verifies them. No token is ever minted here.
 *
 * The legacy shared-secret bearer token (MCP_AUTH_TOKEN) is still accepted when
 * it is set, so an existing connector keeps working across the switch. Unset it
 * once every client has moved to OAuth.
 */

export interface AuthInfo {
  /** How the request authenticated. */
  scheme: 'oauth' | 'legacy-token';
  /** Subject claim of the access token, absent for the legacy scheme. */
  subject?: string;
  /** Scopes granted by the access token. */
  scopes: string[];
}

export type AuthResult =
  | { authorized: true; info: AuthInfo }
  | { authorized: false; error: 'invalid_request' | 'invalid_token' | 'insufficient_scope'; description: string };

/** Scope an access token must carry, unless OAUTH_REQUIRED_SCOPE overrides it. */
const DEFAULT_REQUIRED_SCOPE = 'mcp:access';

let cachedJwks: { issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined;
let cachedJwksUri: { issuer: string; uri: string } | undefined;

function oauthIssuer(): string | undefined {
  const issuer = process.env.OAUTH_ISSUER?.trim();
  return issuer ? issuer.replace(/\/+$/, '') : undefined;
}

/**
 * The canonical identifier of this resource server. Access tokens must name it
 * in their audience, which is what stops a token minted for some other service
 * on the same authorization server from being replayed here.
 */
export function resourceIdentifier(): string | undefined {
  return process.env.OAUTH_AUDIENCE?.trim() || undefined;
}

export function requiredScope(): string | undefined {
  const configured = process.env.OAUTH_REQUIRED_SCOPE;
  if (configured === undefined) return oauthIssuer() ? DEFAULT_REQUIRED_SCOPE : undefined;
  const trimmed = configured.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function oauthConfigured(): boolean {
  return Boolean(oauthIssuer() && resourceIdentifier());
}

/** Authorization server metadata URL, for the protected resource document. */
export function authorizationServers(): string[] {
  const issuer = oauthIssuer();
  return issuer ? [issuer] : [];
}

/**
 * Finds the authorization server's signing keys.
 *
 * Providers publish these at different paths (WorkOS, Auth0 and Clerk all
 * differ), so rather than hardcode a guess the issuer's own discovery document
 * is read and its `jwks_uri` used. OAUTH_JWKS_URI skips the lookup entirely.
 * The result is cached for the life of the instance.
 */
async function discoverJwksUri(issuer: string): Promise<string> {
  const override = process.env.OAUTH_JWKS_URI?.trim();
  if (override) return override;
  if (cachedJwksUri?.issuer === issuer) return cachedJwksUri.uri;

  // RFC 8414 first, since an OAuth authorization server need not be an OpenID
  // provider; the OIDC path is the fallback.
  const candidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];

  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        failures.push(`${url} returned ${response.status}`);
        continue;
      }
      const metadata = (await response.json()) as { jwks_uri?: unknown };
      if (typeof metadata.jwks_uri === 'string' && metadata.jwks_uri) {
        cachedJwksUri = { issuer, uri: metadata.jwks_uri };
        return metadata.jwks_uri;
      }
      failures.push(`${url} has no jwks_uri`);
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : 'request failed'}`);
    }
  }

  throw new Error(
    `Could not discover signing keys for ${issuer} (${failures.join('; ')}). ` +
      'Check OAUTH_ISSUER, or set OAUTH_JWKS_URI to the key set URL directly.',
  );
}

async function jwksFor(issuer: string) {
  const uri = await discoverJwksUri(issuer);
  if (cachedJwks?.issuer !== issuer) {
    cachedJwks = { issuer, jwks: createRemoteJWKSet(new URL(uri)) };
  }
  return cachedJwks.jwks;
}

function scopesFrom(payload: JWTPayload): string[] {
  const raw = (payload as { scope?: unknown; scp?: unknown }).scope ?? (payload as { scp?: unknown }).scp;
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  return [];
}

function bearerToken(authHeader: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

function matchesLegacyToken(provided: string): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return false;

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function authenticate(authHeader: string | string[] | undefined): Promise<AuthResult> {
  const issuer = oauthIssuer();
  const audience = resourceIdentifier();
  const legacyEnabled = Boolean(process.env.MCP_AUTH_TOKEN);

  if (!issuer && !legacyEnabled) {
    throw new Error('No authentication is configured: set OAUTH_ISSUER and OAUTH_AUDIENCE, or MCP_AUTH_TOKEN');
  }
  if (issuer && !audience) {
    throw new Error('OAUTH_ISSUER is set without OAUTH_AUDIENCE; both are required for OAuth');
  }

  const token = bearerToken(authHeader);
  if (!token) {
    return { authorized: false, error: 'invalid_request', description: 'Missing bearer token' };
  }

  // The legacy secret is compared first and in constant time, so a token that is
  // not a JWT at all never reaches the verifier.
  if (legacyEnabled && matchesLegacyToken(token)) {
    return { authorized: true, info: { scheme: 'legacy-token', scopes: [] } };
  }

  if (!issuer || !audience) {
    return { authorized: false, error: 'invalid_token', description: 'Token not recognised' };
  }

  // Resolved outside the try below so a discovery failure surfaces as the
  // configuration error it is, rather than being reported as a bad token.
  const jwks = await jwksFor(issuer);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer, audience }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'verification failed';
    return { authorized: false, error: 'invalid_token', description: `Access token rejected: ${reason}` };
  }

  const scopes = scopesFrom(payload);
  const needed = requiredScope();
  if (needed && !scopes.includes(needed)) {
    return {
      authorized: false,
      error: 'insufficient_scope',
      description: `Access token is missing the "${needed}" scope`,
    };
  }

  return {
    authorized: true,
    info: { scheme: 'oauth', subject: typeof payload.sub === 'string' ? payload.sub : undefined, scopes },
  };
}

/**
 * The WWW-Authenticate value sent with a 401 or 403. `resource_metadata` is how
 * an MCP client discovers which authorization server to send the user to.
 */
export function challengeHeader(metadataUrl: string, error?: string, description?: string): string {
  const parts = [`Bearer realm="mcp"`, `resource_metadata="${metadataUrl}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}
