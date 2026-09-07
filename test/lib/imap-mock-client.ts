import { vi } from 'vitest';

export function createMockImapClient() {
  return {
    connect: vi.fn(),
    logout: vi.fn(),
    list: vi.fn(),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    messageMove: vi.fn(),
    fetchOne: vi.fn(),
    mailbox: { uidValidity: 1000n } as { uidValidity: bigint } | false,
  };
}

export type MockImapClient = ReturnType<typeof createMockImapClient>;
