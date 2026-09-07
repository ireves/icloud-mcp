import { vi } from 'vitest';

export function createMockImapClient() {
  return {
    connect: vi.fn(),
    logout: vi.fn(),
    list: vi.fn(),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    messageMove: vi.fn(),
  };
}

export type MockImapClient = ReturnType<typeof createMockImapClient>;
