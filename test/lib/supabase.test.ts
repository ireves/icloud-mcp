import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.hoisted(() => vi.fn(() => ({ from: vi.fn() })));

vi.mock('@supabase/supabase-js', () => ({ createClient }));

const KEY_NAMES = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

async function freshSupabase() {
  vi.resetModules();
  createClient.mockClear();
  return import('../../lib/supabase.js');
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  for (const name of KEY_NAMES) delete process.env[name];
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  for (const name of KEY_NAMES) delete process.env[name];
});

describe('getSupabase', () => {
  it('uses SUPABASE_SECRET_KEY, which is what a Vercel-created project supplies', async () => {
    const supabase = await freshSupabase();
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_example';

    supabase.getSupabase();

    expect(createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'sb_secret_example',
      expect.objectContaining({ auth: expect.objectContaining({ persistSession: false }) }),
    );
  });

  it('falls back to SUPABASE_SERVICE_ROLE_KEY for a project set up by hand', async () => {
    const supabase = await freshSupabase();
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-role-key';

    supabase.getSupabase();

    expect(createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'legacy-service-role-key',
      expect.anything(),
    );
  });

  it('prefers the newer name when both are present', async () => {
    const supabase = await freshSupabase();
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-role-key';

    supabase.getSupabase();

    expect(createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'sb_secret_example',
      expect.anything(),
    );
  });

  it('names both options when neither key is set', async () => {
    const supabase = await freshSupabase();

    expect(() => supabase.getSupabase()).toThrow(
      /Neither SUPABASE_SECRET_KEY nor SUPABASE_SERVICE_ROLE_KEY is set/,
    );
  });

  it('says so when the project URL is missing', async () => {
    const supabase = await freshSupabase();
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_example';

    expect(() => supabase.getSupabase()).toThrow(/SUPABASE_URL is not set/);
  });

  it('builds the client once and reuses it', async () => {
    const supabase = await freshSupabase();
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_example';

    const first = supabase.getSupabase();
    const second = supabase.getSupabase();

    expect(first).toBe(second);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
