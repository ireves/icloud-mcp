// The MCP endpoint. The [transport] segment is what mcp-handler dispatches on,
// so this file serves /api/mcp over streamable HTTP.
//
// Every request builds a fresh server. That keeps the handler stateless, which
// is what a serverless function needs: there is no long-lived process to hold a
// session, and two requests may land on different instances.

import { createMcpHandler } from 'mcp-handler';
import { requireMcpAuth } from '@better-auth/mcp';
import { auth, mcpResource, ICLOUD_SCOPE } from '@/lib/auth';
import { registerMailTools } from '@/tools/mail';
import { registerCalendarTools } from '@/tools/calendar';
import { registerReminderTools } from '@/tools/reminders';

export const runtime = 'nodejs';
export const maxDuration = 300;

const SERVER_INFO = { name: 'icloud-mcp', version: '2.0.0' };

const handler = createMcpHandler(
  (server) => {
    registerMailTools(server as never);
    registerCalendarTools(server as never);
    registerReminderTools(server as never);
  },
  { serverInfo: SERVER_INFO },
  {
    basePath: '/api',
    // The SSE transport needs Redis to carry a session between requests. This
    // deployment has none, and streamable HTTP over POST needs none, so only
    // that transport is offered.
    disableSse: true,
  },
);

// Verifies the token's signature, issuer, audience and expiry against this
// deployment's own key set, with no database round trip. An unauthenticated
// request gets a 401 carrying the WWW-Authenticate header that tells the client
// where to find the discovery documents, which is how a connector starts
// signing in without anyone pasting a URL.
//
// Built on the first request rather than on import, because Next.js imports
// this file while building, before any environment variable is set.
let protectedHandler: ((request: Request) => Promise<Response>) | undefined;

function getProtectedHandler() {
  if (!protectedHandler) {
    protectedHandler = requireMcpAuth(auth, (request) => handler(request), {
      resource: mcpResource(),
      requiredScopes: [ICLOUD_SCOPE],
      challengeScopes: [ICLOUD_SCOPE, 'offline_access'],
    });
  }
  return protectedHandler;
}

// /mcp is the path most people reach for, and leaving off /api is an easy slip.
// A Next.js rewrite sends it here but does not change the address the handler
// reads, so without this the handler would be asked about a path it has never
// heard of and would answer 404. Restoring the real path is what makes the
// short form work. The discovery documents still name /api/mcp as the resource,
// and a token stays bound to that, so there is no ambiguity about what it was
// issued for.
function canonical(request: Request, transport: string): Request {
  const url = new URL(request.url);
  const wanted = `/api/${transport}`;
  if (url.pathname === wanted) return request;

  url.pathname = wanted;
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // Required by the runtime whenever a request is built around a stream.
    duplex: 'half',
    signal: request.signal,
  } as RequestInit & { duplex: 'half' });
}

async function route(
  request: Request,
  { params }: { params: Promise<{ transport: string }> },
): Promise<Response> {
  const { transport } = await params;
  return getProtectedHandler()(canonical(request, transport));
}

export { route as GET, route as POST, route as DELETE };
