import { vi } from 'vitest';

export function createMockDavClient() {
  return {
    fetchCalendars: vi.fn(),
    fetchCalendarObjects: vi.fn(),
    createCalendarObject: vi.fn(),
    updateCalendarObject: vi.fn(),
  };
}

export type MockDavClient = ReturnType<typeof createMockDavClient>;
