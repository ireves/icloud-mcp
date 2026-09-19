// Every authorization server endpoint: sign-in, consent, authorize, token,
// registration, the key set, and the discovery documents. They all live under
// /api/auth, and next.config.mjs sends the /.well-known paths that MCP clients
// actually ask for to the route that fetches them from here.
//
// The request is handed over inside the handler rather than at import time.
// Next.js imports this file while building, when no environment variable is
// set, and reading the authorization server there would fail the build.

import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return auth.handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return auth.handler(request);
}
