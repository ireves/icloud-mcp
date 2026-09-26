import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const mockImap = vi.hoisted(() => ({
  listFolders: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  markMessage: vi.fn(),
  flagMessage: vi.fn(),
  moveMessage: vi.fn(),
  undoMove: vi.fn(),
  markScanned: vi.fn(),
  reconcileFlagged: vi.fn(),
  listMoveOperations: vi.fn(),
  getMoveOperation: vi.fn(),
  saveDraft: vi.fn(),
  MAX_DRAFT_RECIPIENTS: 4,
  MAX_DRAFT_ATTACHMENTS: 10,
  MAX_DRAFT_ATTACHMENT_BYTES: 3 * 1024 * 1024,
}));

vi.mock('../../lib/imap.js', () => mockImap);
vi.mock('../../lib/exceptions.js', () => ({
  isExceptionsConfigured: () => true,
  getExceptions: async () => [
    { sender: 'a@b.com', action: 'keep_in_inbox' as const, readRule: false },
    { sender: 'c@d.com', action: 'move_to_folder' as const, destinationFolder: 'Receipts', notes: 'n', timing: 't', readRule: true },
    { title: 'Themed rule', action: 'move_to_folder' as const, destinationFolder: 'Alerts', readRule: false },
  ],
}));

/**
 * Drives the real tools through the real protocol, so the server's own output
 * validation runs. A result that does not match its declared schema comes back
 * as an error here, which is exactly what a client would see.
 */
async function connectedClient() {
  const { registerMailTools } = await import('../../tools/mail.js');
  const server = new McpServer({ name: 'icloud-mcp', version: 'test' });
  registerMailTools(server);

  const client = new Client({ name: 'test-client', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const summary = {
  uid: 33605,
  subject: 'Hello',
  from: 'someone@example.com',
  date: '2026-09-18T00:00:00.000Z',
  unread: true,
  flagged: false,
};

beforeEach(() => {
  for (const fn of Object.values(mockImap)) if (typeof fn === 'function') fn.mockReset();
});

describe('tools/list', () => {
  it('advertises an output schema for every mail tool', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    const withoutSchema = tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name);
    expect(withoutSchema).toEqual([]);
  });

  it('publishes the schema as JSON Schema a client can read', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const listMessages = tools.find((tool) => tool.name === 'list_messages');

    expect(listMessages?.outputSchema).toMatchObject({
      type: 'object',
      properties: { messages: { type: 'array' }, next_cursor: expect.anything() },
    });
  });
});

describe('tool results pass the server\'s own validation', () => {
  it('returns structured content for list_messages', async () => {
    mockImap.listMessages.mockResolvedValue({ messages: [summary], nextCursor: 33600 });
    const client = await connectedClient();

    const result = await client.callTool({ name: 'list_messages', arguments: { folder: 'INBOX' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ messages: [summary], next_cursor: 33600 });
  });

  it('returns structured content for list_folders, wrapped in a named field', async () => {
    mockImap.listFolders.mockResolvedValue([{ path: 'INBOX', name: 'INBOX', flags: [] }]);
    const client = await connectedClient();

    const result = await client.callTool({ name: 'list_folders', arguments: {} });

    expect(result.structuredContent).toEqual({ folders: [{ path: 'INBOX', name: 'INBOX', flags: [] }] });
  });

  it('returns structured content for list_exceptions', async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: 'list_exceptions', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { exceptions: unknown[] }).exceptions).toHaveLength(3);
  });

  it('returns structured content for a move', async () => {
    mockImap.moveMessage.mockResolvedValue({ operationId: 'op-1' });
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'move_message',
      arguments: { folder: 'INBOX', uid: 1, target_folder: 'INBOX.Archive' },
    });

    expect(result.structuredContent).toEqual({ ok: true, operation_id: 'op-1', undoable_for_days: 7 });
  });

  it('returns structured content for mark_scanned', async () => {
    mockImap.markScanned.mockResolvedValue({ lastSeenUid: 33536 });
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'mark_scanned',
      arguments: { folder: 'INBOX', through_uid: 33536 },
    });

    expect(result.structuredContent).toEqual({ last_seen_uid: 33536 });
  });

  it('returns structured content for save_draft', async () => {
    mockImap.saveDraft.mockResolvedValue({ folder: 'Drafts', uid: 12 });
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'save_draft',
      arguments: { to: ['someone@example.com'], subject: 'Hello', body: 'Hi there' },
    });

    expect(result.structuredContent).toEqual({ ok: true, folder: 'Drafts', uid: 12 });
  });

  it('refuses a reply given only half of the original message', async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'save_draft',
      arguments: { to: ['someone@example.com'], subject: 'Re: Hello', body: 'Hi', reply_to_uid: 5 },
    });

    expect(result.isError).toBe(true);
    expect(mockImap.saveDraft).not.toHaveBeenCalled();
  });

  it('refuses a fifth address in To before anything is saved', async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'save_draft',
      arguments: {
        to: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'],
        subject: 'Hello',
        body: 'Hi',
      },
    });

    expect(result.isError).toBe(true);
    expect(mockImap.saveDraft).not.toHaveBeenCalled();
  });

  it('refuses a draft with no body of either kind', async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'save_draft',
      arguments: { to: ['someone@example.com'], subject: 'Hello' },
    });

    expect(result.isError).toBe(true);
    expect(mockImap.saveDraft).not.toHaveBeenCalled();
  });

  it('passes html and attachments through to the library', async () => {
    mockImap.saveDraft.mockResolvedValue({ folder: 'Drafts', uid: 13 });
    const client = await connectedClient();

    await client.callTool({
      name: 'save_draft',
      arguments: {
        to: ['someone@example.com'],
        subject: 'Hello',
        html: '<p><b>Hi</b></p>',
        attachments: [{ filename: 'a.txt', content_base64: 'aGk=', content_type: 'text/plain' }],
      },
    });

    expect(mockImap.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        html: '<p><b>Hi</b></p>',
        attachments: [{ filename: 'a.txt', contentBase64: 'aGk=', contentType: 'text/plain' }],
      }),
    );
  });

  it('still reports a refusal as a plain error, with no structured content', async () => {
    mockImap.moveMessage.mockRejectedValue(new Error('Moving into Trash is not allowed.'));
    const client = await connectedClient();

    const result = await client.callTool({
      name: 'move_message',
      arguments: { folder: 'INBOX', uid: 1, target_folder: 'INBOX.Trash' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/Trash is not allowed/);
  });
});
