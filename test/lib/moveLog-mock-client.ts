import { vi } from 'vitest';

export function createMockRedisClient() {
  return {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    expire: vi.fn(),
    zadd: vi.fn(),
    zrange: vi.fn(),
    zrem: vi.fn(),
    sadd: vi.fn(),
    smembers: vi.fn(),
  };
}

export type MockRedisClient = ReturnType<typeof createMockRedisClient>;
