// This deployment's own OAuth 2.1 authorization server.
//
// Earlier versions pointed at an outside provider named by OAUTH_ISSUER and
// only checked the tokens it issued. That indirection is gone: the server now
// issues its own tokens, so there is no provider dashboard to keep in step with
// it, no client ID or secret to copy around, and no redirect URL to re-register
// when a client changes one.
//
// Clients identify themselves in one of two ways, both automatic:
//
//   - Client ID Metadata Documents, where the client hosts a small JSON file
//     and the URL of that file is its client ID. This is what the 2026-07-28
//     MCP revision asks for, and what Claude and ChatGPT prefer.
//   - Dynamic client registration, kept on as a fallback for older clients.
//
// The human half is a passkey. One is registered on first run, guarded by
// MCP_SETUP_CODE, and after that the code is inert because registration closes
// as soon as a passkey exists.

import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { passkey } from '@better-auth/passkey';
import { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Add it to the project's environment variables in Vercel.`);
  }
  return value;
}

/**
 * This deployment's public origin. Pin MCP_PUBLIC_URL to the final domain:
 * clients compare the issuer in the discovery documents against the URL they
 * were given and reject a mismatch, and a passkey is bound to the hostname, so
 * moving afterwards means registering a new one.
 */
export function publicOrigin(): string {
  const configured = process.env.MCP_PUBLIC_URL;
  if (configured) {
    // Only the scheme and host are wanted. It is easy to paste the full
    // endpoint URL here instead, and a path kept here would be doubled into
    // every address the discovery documents publish, sending clients to
    // endpoints that do not exist. A passkey follows the host alone, so
    // trimming the path cannot invalidate one either.
    try {
      return new URL(configured).origin;
    } catch {
      return `https://${configured.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
    }
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return 'http://localhost:3000';
}

/**
 * The canonical identifier every issued token is bound to. It is a function
 * rather than a constant, because a constant would be fixed when this file is
 * first imported, which during a build is before any environment variable
 * exists.
 */
export function mcpResource(): string {
  return `${publicOrigin()}/api/mcp`;
}

// The one scope that grants access to the tools. The mail, calendar and
// reminder tools are registered together and are not split into a read half
// and a write half, so advertising `icloud:read` and `icloud:write` would
// promise a distinction the server does not actually enforce. What the server
// will and will not do to a mailbox is decided by ALLOW_TRASH_JUNK_MOVES and
// ALLOWED_MOVE_DESTINATIONS, which are the operator's settings, not the
// client's to ask for.
export const ICLOUD_SCOPE = 'icloud';

// Sign-in tables live in the same database as the mail and calendar tables, so
// they carry a prefix. The sibling YNAB deployment already keeps its own
// unprefixed set here, and the two cannot share them: each deployment signs its
// tokens with its own BETTER_AUTH_SECRET, and the signing keys in `jwks` are
// encrypted with it, so whichever wrote last would lock the other out.
const TABLE_PREFIX = 'icloud_';

function table(model: string): { modelName: string } {
  return { modelName: `${TABLE_PREFIX}${model}` };
}

/**
 * Which settings this deployment is missing, by name only. Nothing here reads a
 * value, so the result is safe to serve publicly, and it turns "every page is a
 * 500" into a list of what to go and set.
 */
export function settingsReport() {
  const present = (name: string) => !!process.env[name];
  const missing: string[] = [];

  if (!present('BETTER_AUTH_SECRET')) missing.push('BETTER_AUTH_SECRET');
  if (!present('MCP_OWNER_EMAIL')) missing.push('MCP_OWNER_EMAIL');
  if (!present('POSTGRES_URL') && !present('DATABASE_URL')) {
    missing.push('POSTGRES_URL or DATABASE_URL');
  }
  if (!present('ICLOUD_EMAIL')) missing.push('ICLOUD_EMAIL');
  if (!present('ICLOUD_APP_PASSWORD')) missing.push('ICLOUD_APP_PASSWORD');

  return {
    ok: missing.length === 0,
    missing,
    database: databaseSummary(),
    // Not required, but worth seeing: without it the server names itself by
    // whatever Vercel happens to call this deployment, and a passkey follows
    // the hostname.
    public_url: process.env.MCP_PUBLIC_URL ? publicOrigin() : null,
    resource: mcpResource(),
    table_prefix: TABLE_PREFIX,
    // Only meaningful before the first passkey exists. Once one does,
    // registration is closed whether or not this is still set.
    setup_code_set: present('MCP_SETUP_CODE'),
  };
}

/**
 * Describes the database connection without revealing anything secret: which
 * variable it came from, and the host and port it points at. The host matters,
 * because Supabase's direct connection is reachable only over IPv6 and a Vercel
 * function is not, so it has to be the pooler.
 */
function databaseSummary() {
  const source = process.env.POSTGRES_URL
    ? 'POSTGRES_URL'
    : process.env.DATABASE_URL
      ? 'DATABASE_URL'
      : null;
  if (!source) return { source: null };

  try {
    const url = new URL(process.env[source] as string);
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return {
      source,
      host: url.hostname,
      port: url.port || '5432',
      looks_pooled: local ? null : url.hostname.includes('pooler.') || url.port === '6543',
      tls: local
        ? 'not used, the database is on this machine'
        : url.searchParams.get('sslmode') === 'verify-full'
          ? 'encrypted, server identity verified'
          : 'encrypted, server identity not verified',
    };
  } catch {
    return { source, host: null, note: 'could not be read as a connection string' };
  }
}

/**
 * Actually opens a connection and runs the cheapest possible query. A settings
 * list saying everything is present is not much use when the reason nothing
 * works is that the database cannot be reached, and the driver's complaint is
 * otherwise buried in a log someone has to go and find.
 */
export async function databaseCheck(): Promise<{
  reachable: boolean;
  error?: string;
  code?: string | null;
}> {
  try {
    const result = await database().query('select 1 as ok');
    return { reachable: result.rows?.[0]?.ok === 1 };
  } catch (error) {
    const cause = error as { message?: string; code?: string };
    return {
      reachable: false,
      // The message and code only. A connection string carries a password, and
      // this endpoint is public.
      error: String(cause?.message || error).replace(
        /postgres(ql)?:\/\/[^\s]*/gi,
        '[connection string]',
      ),
      code: cause?.code || null,
    };
  }
}

/**
 * Supabase's pooler, not the direct database port. Vercel functions start and
 * stop constantly, and one connection per invocation would exhaust the limit
 * within a day. The Vercel integration sets POSTGRES_URL; DATABASE_URL is the
 * manual fallback.
 *
 * One wrinkle deserves stating plainly. Postgres connection strings use
 * `sslmode`, and every common client reads `require` as "encrypt this
 * connection". The driver used here reads it as "encrypt it and check the
 * server's certificate against the ones this machine already trusts", which
 * Supabase's is not, so the connection fails outright. Adding the compatibility
 * flag restores the meaning the connection string was written with. Traffic is
 * encrypted either way; what is not checked is the server's identity, which is
 * how Supabase is normally reached. /api/status says which of the two is in use
 * rather than leaving it implied.
 */
function connectionString(): string {
  const raw = process.env.POSTGRES_URL || required('DATABASE_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return raw;

  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require');
  if (url.searchParams.get('sslmode') !== 'verify-full') {
    url.searchParams.set('uselibpqcompat', 'true');
  }
  return url.toString();
}

let pool: Pool | undefined;
function database(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: 1,
      idleTimeoutMillis: 10_000,
      // A Vercel function is short-lived, and a connection that hangs should
      // surface as an error rather than sitting there until the request dies.
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

function ownerEmail(): string {
  return (process.env.MCP_OWNER_EMAIL || '').trim().toLowerCase();
}

/**
 * Compares two strings without leaking, through timing, how much of the setup
 * code was right.
 */
function secretsMatch(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The hostname WebAuthn binds a passkey to. A passkey registered against one
 * hostname will not work on another, which is what makes it phishing-resistant.
 */
function relyingPartyId(): string {
  return new URL(publicOrigin()).hostname;
}

export function createAuth() {
  return betterAuth({
    appName: 'iCloud MCP',
    baseURL: publicOrigin(),
    secret: required('BETTER_AUTH_SECRET'),
    database: database(),
    emailAndPassword: { enabled: false },
    // The four core tables, renamed so they sit beside the sibling
    // deployment's rather than on top of them.
    user: table('user'),
    session: table('session'),
    account: table('account'),
    verification: table('verification'),
    // Nothing else can create an account: the passkey registration hook below
    // is the only way in, and it closes after the first passkey.
    advanced: { disableCSRFCheck: false },
    plugins: [
      // Signs access and ID tokens, and serves the key set the MCP endpoint
      // verifies them against.
      jwt({ schema: { jwks: table('jwks') } }),

      mcp({
        resource: mcpResource(),
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: ['openid', 'profile', 'email', 'offline_access', ICLOUD_SCOPE],
        advertisedMetadata: {
          scopes_supported: ['openid', 'offline_access', ICLOUD_SCOPE],
        },
        // An hour-long access token with a rotating refresh token. Claude
        // refreshes both ahead of expiry and again on a 401, so the reuse
        // window below keeps two overlapping refreshes from revoking the whole
        // chain, which is what forces someone to reconnect the server by hand.
        accessTokenExpiresIn: 3600,
        refreshTokenExpiresIn: 7_776_000,
        refreshTokenReuseInterval: 30,
        storeTokens: 'hashed',
        // Dynamic registration stays on for clients that predate metadata
        // documents.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ['openid', 'offline_access', ICLOUD_SCOPE],
        clientRegistrationAllowedScopes: ['profile', 'email'],
        clientRegistrationDefaultResources: [mcpResource()],
        schema: {
          oauthClient: table('oauthClient'),
          oauthResource: table('oauthResource'),
          oauthClientResource: table('oauthClientResource'),
          oauthRefreshToken: table('oauthRefreshToken'),
          oauthAccessToken: table('oauthAccessToken'),
          oauthConsent: table('oauthConsent'),
          oauthClientAssertion: table('oauthClientAssertion'),
        },
      }),

      // Lets a client identify itself by a metadata document it hosts, so
      // nothing is registered and no redirect URL is ever typed into a
      // dashboard. The Node transport resolves the hostname once, refuses
      // private addresses and follows no redirects, which is what stops a
      // client ID pointing the server at something on its own network.
      cimd({
        fetchClientMetadataResource,
        metadataProfile: 'mcp-2026-07-28',
      }),

      passkey({
        rpID: relyingPartyId(),
        rpName: 'iCloud MCP',
        origin: publicOrigin(),
        schema: { passkey: table('passkey') },
        registration: {
          // Registration happens before there is anyone to be signed in as, so
          // the setup code stands in for a session exactly once.
          requireSession: false,
          resolveUser: async ({ ctx, context }: { ctx: any; context?: unknown }) => {
            const setupCode = process.env.MCP_SETUP_CODE;
            if (!setupCode) {
              throw ctx.error('FORBIDDEN', {
                message: 'MCP_SETUP_CODE is not set, so no passkey can be registered.',
              });
            }
            if (!context || !secretsMatch(context, setupCode)) {
              throw ctx.error('FORBIDDEN', { message: 'That setup code is not right.' });
            }

            // One owner, one passkey. This looks at the whole table rather than
            // at one account, so re-running setup cannot add a second way in
            // under a different address either.
            const anyPasskey = await ctx.context.adapter.findMany({
              model: 'passkey',
              limit: 1,
            });
            if (anyPasskey.length > 0) {
              throw ctx.error('FORBIDDEN', {
                message:
                  'A passkey is already registered. Remove it from the database before registering another.',
              });
            }

            const email = ownerEmail();
            if (!email) {
              throw ctx.error('FORBIDDEN', { message: 'MCP_OWNER_EMAIL is not set.' });
            }

            let user = await ctx.context.adapter.findOne({
              model: 'user',
              where: [{ field: 'email', value: email }],
            });

            if (!user) {
              user = await ctx.context.internalAdapter.createUser({
                email,
                name: 'Owner',
                emailVerified: true,
              });
            }

            return { id: user.id, name: email, displayName: 'iCloud MCP owner' };
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

/**
 * A stand-in for the authorization server that builds it the first time
 * anything is actually read from it. Next.js imports every route while it
 * builds, before any environment variable exists, and building the real thing
 * at that moment would read BETTER_AUTH_SECRET and fail the build.
 */
export const auth: Auth = new Proxy({} as Auth, {
  get(_target, property: string | symbol) {
    if (!instance) instance = createAuth();
    const value = (instance as unknown as Record<string | symbol, unknown>)[property];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
