import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticate, challengeHeader } from '../lib/auth.js';
import { publicBaseUrl, resourceMetadataUrl } from '../lib/publicUrl.js';
import { registerMailTools } from '../tools/mail.js';
import { registerCalendarTools } from '../tools/calendar.js';
import { registerReminderTools } from '../tools/reminders.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const metadataUrl = resourceMetadataUrl(publicBaseUrl(req.headers));
  const auth = await authenticate(req.headers.authorization);

  if (!auth.authorized) {
    // 403 for a valid token that simply lacks the scope; 401 otherwise, which is
    // what tells an MCP client to start the OAuth flow rather than give up.
    const status = auth.error === 'insufficient_scope' ? 403 : 401;
    res.setHeader('WWW-Authenticate', challengeHeader(metadataUrl, auth.error, auth.description));
    res.status(status).json({ error: auth.error, error_description: auth.description });
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
