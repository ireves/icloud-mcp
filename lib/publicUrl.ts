/**
 * Works out the server's own public base URL from the incoming request, so the
 * discovery documents are correct on preview deployments as well as production
 * without anyone having to configure the hostname twice.
 */
export function publicBaseUrl(headers: Record<string, string | string[] | undefined>): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const first = (value: string | string[] | undefined): string | undefined => {
    const v = Array.isArray(value) ? value[0] : value;
    return v ? v.split(',')[0].trim() : undefined;
  };

  const host = first(headers['x-forwarded-host']) ?? first(headers.host) ?? 'localhost';
  const proto = first(headers['x-forwarded-proto']) ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Where this server's protected resource metadata lives, per RFC 9728. */
export function resourceMetadataUrl(baseUrl: string, resourcePath = '/api/mcp'): string {
  return `${baseUrl}/.well-known/oauth-protected-resource${resourcePath}`;
}
