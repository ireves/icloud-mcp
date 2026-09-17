import { isOAuthConfigured, issuer, requiredScopes, resourceIdentifier } from './auth.js';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728). MCP clients fetch this
 * after a 401 to discover which authorization server issues tokens for this
 * server, then run the sign-in flow against that server.
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
  resource_documentation?: string;
}

export function protectedResourceMetadata(): ProtectedResourceMetadata {
  if (!isOAuthConfigured()) {
    throw new Error('OAuth is not configured: set OAUTH_ISSUER and OAUTH_AUDIENCE');
  }

  const scopes = requiredScopes();

  return {
    resource: resourceIdentifier(),
    authorization_servers: [issuer()],
    // Tokens go in the Authorization header only, never a query string.
    bearer_methods_supported: ['header'],
    ...(scopes.length > 0 ? { scopes_supported: scopes } : {}),
  };
}

/**
 * Absolute URL of the metadata document, for the `resource_metadata` parameter
 * of a `WWW-Authenticate` challenge. Falls back to the request's own host when
 * OAUTH_AUDIENCE is unset, so challenges still work before OAuth is switched on.
 */
export function metadataUrl(requestHost: string | undefined): string {
  let base: string;
  try {
    base = resourceIdentifier();
  } catch {
    base = requestHost ? `https://${requestHost}` : '';
  }

  const origin = base ? new URL(base).origin : '';
  return `${origin}/.well-known/oauth-protected-resource`;
}
