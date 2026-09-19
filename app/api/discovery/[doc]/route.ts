// Serves the OAuth discovery documents at the /.well-known paths clients ask
// for, whichever spelling they use.
//
// The authorization server is mounted at /api/auth, so its own documents live
// under that prefix. A Next.js rewrite alone is not enough to expose them at
// the root: a rewrite is invisible to the handler, which still sees the address
// the client asked for and quite rightly says that is not where its documents
// live. So this route asks it for the document by the address it does
// recognise, and returns the answer.
//
// Clients look in several places, in an order the specification fixes, and this
// makes every one of them work rather than relying on which one the client
// happens to try first.

import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Where the server actually keeps each document, and an allow list at the same
// time, because the name arrives from the address bar and is used to build the
// address asked for internally.
//
// The two are not in the same place, and that is correct rather than an
// oversight. A document describing the authorization server belongs under that
// server's own address, while one describing the protected resource belongs at
// the site root, because that is where a client looks for it.
const DOCUMENTS: Record<string, string> = {
  'oauth-authorization-server': '/api/auth/.well-known/oauth-authorization-server',
  'openid-configuration': '/api/auth/.well-known/openid-configuration',
  'oauth-protected-resource': '/.well-known/oauth-protected-resource',
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ doc: string }> },
): Promise<Response> {
  const { doc } = await params;
  const path = Object.prototype.hasOwnProperty.call(DOCUMENTS, doc) ? DOCUMENTS[doc] : null;
  if (!path) {
    return new Response('Not found', { status: 404 });
  }

  const target = new URL(request.url);
  target.pathname = path;
  target.search = '';

  return auth.handler(new Request(target, { headers: request.headers }));
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
    },
  });
}
