import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isAuthorized } from '../lib/auth.js';
import { registerMailTools } from '../tools/mail.js';
import { registerCalendarTools } from '../tools/calendar.js';
import { registerReminderTools } from '../tools/reminders.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorized(req.headers.authorization)) {
    res.status(401).json({ error: 'Unauthorized' });
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
