import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizationServers, requiredScope, resourceIdentifier } from '../lib/auth.js';
import { publicBaseUrl } from '../lib/publicUrl.js';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * An MCP client that gets a 401 from /api/mcp reads the resource_metadata URL
 * out of the WWW-Authenticate header, fetches this document, and learns which
 * authorization server to send the user to. Served from
 * /.well-known/oauth-protected-resource[/api/mcp] via the rewrites in
 * vercel.json, because Vercel's file routing skips dot-directories.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const base = publicBaseUrl(req.headers);
  const scope = requiredScope();

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    resource: resourceIdentifier() ?? `${base}/api/mcp`,
    authorization_servers: authorizationServers(),
    bearer_methods_supported: ['header'],
    ...(scope ? { scopes_supported: [scope] } : {}),
    resource_documentation: 'https://github.com/ireves/icloud-mcp#readme',
  });
}
