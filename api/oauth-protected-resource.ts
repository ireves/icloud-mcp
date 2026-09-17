import type { VercelRequest, VercelResponse } from '@vercel/node';
import { protectedResourceMetadata } from '../lib/metadata.js';

/**
 * Served at /.well-known/oauth-protected-resource via the rewrites in
 * vercel.json. Unauthenticated by design: RFC 9728 metadata is public, and a
 * client has to read it before it can obtain a token.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let metadata;
  try {
    metadata = protectedResourceMetadata();
  } catch {
    // OAuth has not been configured on this deployment, so there is no
    // authorization server to advertise.
    res.status(404).json({ error: 'OAuth is not configured for this server' });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(metadata);
}
