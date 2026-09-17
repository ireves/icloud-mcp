import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticate, challengeHeader } from '../lib/auth.js';
import { metadataUrl } from '../lib/metadata.js';
import { registerMailTools } from '../tools/mail.js';
import { registerCalendarTools } from '../tools/calendar.js';
import { registerReminderTools } from '../tools/reminders.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await authenticate(req.headers.authorization);

  if (!auth.ok) {
    // The challenge tells the client where to discover its authorization
    // server. The reason is logged but not returned, so a caller cannot use
    // the response to probe how the token failed.
    console.warn(`MCP request rejected (${auth.reason}): ${auth.detail}`);
    res.setHeader('WWW-Authenticate', challengeHeader(auth, metadataUrl(req.headers.host)));
    res.status(auth.status).json({
      error: auth.status === 403 ? 'Forbidden' : 'Unauthorized',
    });
    return;
  }

  const server = new McpServer({ name: 'icloud-mcp', version: '1.0.0' });
  registerMailTools(server);
  registerCalendarTools(server);
  registerReminderTools(server);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
