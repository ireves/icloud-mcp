// Adding and removing this project's environment variables from inside the
// deployment, so a setting can be changed without opening the Vercel dashboard.
//
// The page that uses this is write-only on purpose. A value goes in once and is
// stored as Vercel's "sensitive" type, which Vercel itself will never show
// again, not in its dashboard and not through its API. Listing returns names,
// environments and dates only; any value field Vercel sends back is dropped
// here, before it can reach a browser.
//
// A handful of names cannot be changed from here at all. Each of them is
// something this page itself depends on: the token it uses to reach Vercel, the
// secret that signs the session it checks, the database that holds the passkey.
// Getting one of those wrong from the page would lock the owner out of the page
// that could put it right, so they stay a dashboard-only job.

const API = 'https://api.vercel.com';

/** Names the page will neither overwrite nor delete. */
export const LOCKED_NAMES: ReadonlySet<string> = new Set([
  'VERCEL_API_TOKEN',
  'VERCEL_TEAM_ID',
  'BETTER_AUTH_SECRET',
  'MCP_OWNER_EMAIL',
  'MCP_PUBLIC_URL',
  'POSTGRES_URL',
  'DATABASE_URL',
]);

// Vercel refuses values much larger than this anyway, and a limit here gives a
// readable error rather than a rejected request.
const MAX_VALUE_BYTES = 64 * 1024;

// Sensitive variables exist only in these two. Vercel rejects "development".
const TARGETS = ['production', 'preview'] as const;

export interface EnvSummary {
  id: string;
  key: string;
  target: string[];
  type: string;
  updatedAt: number | null;
  locked: boolean;
}

export class EnvAdminError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Why a name cannot be used, or null when it can. */
export function nameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'Enter a name.';
  if (name.length > 256) return 'That name is too long.';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return 'Use only letters, numbers and underscores, and do not start with a number.';
  }
  if (/^VERCEL_/i.test(name) && !LOCKED_NAMES.has(name.toUpperCase())) {
    return 'Names starting with VERCEL_ are reserved by Vercel.';
  }
  if (LOCKED_NAMES.has(name.toUpperCase())) {
    return `${name} can only be changed in the Vercel dashboard, because this page depends on it.`;
  }
  return null;
}

/** Why a value cannot be used, or null when it can. */
export function valueProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'Enter a value.';
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return 'That value is too large.';
  return null;
}

interface Config {
  token: string;
  projectId: string;
  teamId?: string;
}

/**
 * What is needed to reach Vercel, or null when it is not set up. The project ID
 * is one Vercel provides to every deployment by itself; the token is the one
 * thing the owner has to add by hand, once.
 */
export function envAdminConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const token = env.VERCEL_API_TOKEN;
  const projectId = env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return null;
  return { token, projectId, teamId: env.VERCEL_TEAM_ID || undefined };
}

type Fetch = typeof fetch;

export function createEnvAdmin(config: Config, fetcher: Fetch = fetch) {
  function url(path: string, query: Record<string, string> = {}): string {
    const target = new URL(path, API);
    if (config.teamId) target.searchParams.set('teamId', config.teamId);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    return target.toString();
  }

  async function call(method: string, path: string, init: { query?: Record<string, string>; body?: unknown } = {}) {
    const response = await fetcher(url(path, init.query), {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) {
      // Vercel's own message only. It names the problem and never echoes a value.
      const message = data?.error?.message || `Vercel answered ${response.status}.`;
      throw new EnvAdminError(message, response.status === 403 ? 403 : 502);
    }
    return data;
  }

  const project = `/projects/${encodeURIComponent(config.projectId)}/env`;

  return {
    /** Every variable by name, never by value. */
    async list(): Promise<EnvSummary[]> {
      const data = await call('GET', `/v10${project}`);
      const envs = Array.isArray(data.envs) ? data.envs : [];
      return envs
        .map(
          (env: Record<string, any>): EnvSummary => ({
            id: String(env.id),
            key: String(env.key),
            target: Array.isArray(env.target) ? env.target : env.target ? [env.target] : [],
            type: String(env.type),
            updatedAt: typeof env.updatedAt === 'number' ? env.updatedAt : null,
            locked: LOCKED_NAMES.has(String(env.key).toUpperCase()) || env.type === 'system',
          }),
        )
        .sort((a: EnvSummary, b: EnvSummary) => a.key.localeCompare(b.key));
    },

    /** Adds a variable, or replaces it if one with that name already exists. */
    async set(name: string, value: string): Promise<void> {
      const problem = nameProblem(name) || valueProblem(value);
      if (problem) throw new EnvAdminError(problem);

      // A variable already saved from here is simply replaced. One added some
      // other way, of another type or for other environments, would clash with
      // the new one or sit beside it, leaving it unclear which a deployment
      // reads, so that one is cleared first.
      const existing = (await this.list()).filter((env) => env.key === name);
      const sameShape = (env: EnvSummary) =>
        env.type === 'sensitive' &&
        env.target.length === TARGETS.length &&
        TARGETS.every((target) => env.target.includes(target));
      if (!existing.every(sameShape)) {
        for (const env of existing) await call('DELETE', `/v9${project}/${encodeURIComponent(env.id)}`);
      }

      const data = await call('POST', `/v10${project}`, {
        query: { upsert: 'true' },
        body: { key: name, value, type: 'sensitive', target: [...TARGETS] },
      });
      if (Array.isArray(data.failed) && data.failed.length > 0) {
        const reason = data.failed[0]?.error?.message || 'Vercel did not save it.';
        throw new EnvAdminError(reason, 502);
      }
    },

    /** Removes a variable by the ID the listing gave. */
    async remove(id: string): Promise<void> {
      const env = (await this.list()).find((candidate) => candidate.id === id);
      if (!env) throw new EnvAdminError('That variable no longer exists.', 404);
      if (env.locked) {
        throw new EnvAdminError(
          `${env.key} can only be changed in the Vercel dashboard, because this page depends on it.`,
        );
      }
      await call('DELETE', `/v9${project}/${encodeURIComponent(id)}`);
    },

    /**
     * A running deployment keeps the variables it started with. This builds the
     * current production deployment again so a change actually takes effect.
     */
    async redeploy(deploymentId: string | undefined): Promise<string> {
      if (!deploymentId) {
        throw new EnvAdminError('This deployment does not know its own ID, so it cannot redeploy itself.');
      }
      const current = await call('GET', `/v13/deployments/${encodeURIComponent(deploymentId)}`);
      const data = await call('POST', '/v13/deployments', {
        body: { name: current.name, deploymentId, target: 'production' },
      });
      return String(data.url || '');
    },
  };
}

export type EnvAdmin = ReturnType<typeof createEnvAdmin>;
