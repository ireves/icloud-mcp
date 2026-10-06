import { describe, it, expect } from 'vitest';
import { createEnvAdmin, envAdminConfig, nameProblem, valueProblem } from '../../lib/envAdmin';

interface Call {
  method: string;
  url: URL;
  body: any;
}

function fakeVercel(envs: Record<string, unknown>[]) {
  const calls: Call[] = [];
  const fetcher = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method || 'GET', url, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (init.method === 'GET' && url.pathname.endsWith('/env')) return json({ envs });
    if (init.method === 'POST' && url.pathname.endsWith('/env')) return json({ created: { id: 'new' }, failed: [] });
    if (init.method === 'DELETE') return json({});
    if (init.method === 'GET' && url.pathname.startsWith('/v13/deployments/')) return json({ name: 'icloud-mcp' });
    if (init.method === 'POST' && url.pathname === '/v13/deployments') return json({ url: 'icloud-mcp-abc.vercel.app' });
    return json({ error: { message: 'unexpected' } }, 500);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const config = { token: 'tok', projectId: 'prj_1', teamId: 'team_1' };

describe('nameProblem', () => {
  it('accepts an ordinary name', () => {
    expect(nameProblem('NOTION_EXCEPTIONS_TOKEN')).toBeNull();
  });

  it('refuses malformed names', () => {
    expect(nameProblem('')).not.toBeNull();
    expect(nameProblem('1ABC')).not.toBeNull();
    expect(nameProblem('A-B')).not.toBeNull();
  });

  it('refuses the names this page depends on, in any case', () => {
    expect(nameProblem('BETTER_AUTH_SECRET')).toMatch(/dashboard/);
    expect(nameProblem('vercel_api_token')).toMatch(/dashboard/);
    expect(nameProblem('POSTGRES_URL')).toMatch(/dashboard/);
  });

  it('refuses names Vercel reserves', () => {
    expect(nameProblem('VERCEL_ENV')).toMatch(/reserved/);
  });
});

describe('valueProblem', () => {
  it('refuses an empty or oversized value', () => {
    expect(valueProblem('')).not.toBeNull();
    expect(valueProblem('x'.repeat(70_000))).not.toBeNull();
    expect(valueProblem('secret')).toBeNull();
  });
});

describe('envAdminConfig', () => {
  it('needs both the token and the project ID', () => {
    expect(envAdminConfig({ VERCEL_PROJECT_ID: 'prj' })).toBeNull();
    expect(envAdminConfig({ VERCEL_API_TOKEN: 't' })).toBeNull();
    expect(envAdminConfig({ VERCEL_API_TOKEN: 't', VERCEL_PROJECT_ID: 'prj' })).toEqual({
      token: 't',
      projectId: 'prj',
      teamId: undefined,
    });
  });
});

describe('list', () => {
  it('never passes a value on, and marks locked names', async () => {
    const { fetcher, calls } = fakeVercel([
      { id: 'a', key: 'ICLOUD_EMAIL', value: 'encrypted-blob', type: 'encrypted', target: ['production'], updatedAt: 1 },
      { id: 'b', key: 'BETTER_AUTH_SECRET', value: 'decrypted?', type: 'sensitive', target: ['production'] },
    ]);
    const envs = await createEnvAdmin(config, fetcher).list();

    expect(JSON.stringify(envs)).not.toContain('blob');
    expect(JSON.stringify(envs)).not.toContain('decrypted');
    expect(envs.map((env) => [env.key, env.locked])).toEqual([
      ['BETTER_AUTH_SECRET', true],
      ['ICLOUD_EMAIL', false],
    ]);
    expect(calls[0].url.searchParams.get('teamId')).toBe('team_1');
    expect(calls[0].url.searchParams.get('decrypt')).toBeNull();
  });
});

describe('set', () => {
  it('saves a new variable as sensitive for production and preview', async () => {
    const { fetcher, calls } = fakeVercel([]);
    await createEnvAdmin(config, fetcher).set('NEW_KEY', 'shh');

    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url.searchParams.get('upsert')).toBe('true');
    expect(post.body).toEqual({ key: 'NEW_KEY', value: 'shh', type: 'sensitive', target: ['production', 'preview'] });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('replaces one saved from here in place', async () => {
    const { fetcher, calls } = fakeVercel([
      { id: 'a', key: 'NEW_KEY', type: 'sensitive', target: ['preview', 'production'] },
    ]);
    await createEnvAdmin(config, fetcher).set('NEW_KEY', 'shh');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('clears one of another shape first', async () => {
    const { fetcher, calls } = fakeVercel([
      { id: 'a', key: 'NEW_KEY', type: 'encrypted', target: ['production', 'preview', 'development'] },
    ]);
    await createEnvAdmin(config, fetcher).set('NEW_KEY', 'shh');
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf('DELETE')).toBeLessThan(methods.indexOf('POST'));
  });

  it('refuses a locked name without calling Vercel', async () => {
    const { fetcher, calls } = fakeVercel([]);
    await expect(createEnvAdmin(config, fetcher).set('BETTER_AUTH_SECRET', 'x')).rejects.toThrow(/dashboard/);
    expect(calls).toHaveLength(0);
  });
});

describe('remove', () => {
  it('removes an ordinary variable', async () => {
    const { fetcher, calls } = fakeVercel([{ id: 'a', key: 'OLD', type: 'sensitive', target: ['production'] }]);
    await createEnvAdmin(config, fetcher).remove('a');
    expect(calls.at(-1)?.method).toBe('DELETE');
    expect(calls.at(-1)?.url.pathname).toBe('/v9/projects/prj_1/env/a');
  });

  it('refuses a locked one', async () => {
    const { fetcher, calls } = fakeVercel([{ id: 'b', key: 'VERCEL_API_TOKEN', type: 'sensitive', target: [] }]);
    await expect(createEnvAdmin(config, fetcher).remove('b')).rejects.toThrow(/dashboard/);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});

describe('redeploy', () => {
  it('rebuilds the current deployment for production', async () => {
    const { fetcher, calls } = fakeVercel([]);
    const url = await createEnvAdmin(config, fetcher).redeploy('dpl_1');
    expect(url).toBe('icloud-mcp-abc.vercel.app');
    expect(calls.at(-1)?.body).toEqual({ name: 'icloud-mcp', deploymentId: 'dpl_1', target: 'production' });
  });
});
