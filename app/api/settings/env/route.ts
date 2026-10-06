// The settings page's only way to Vercel. GET lists variables by name; POST
// adds or replaces one; DELETE removes one; PUT redeploys so a change takes
// effect. No answer from here ever carries a value. See lib/envAdmin.ts.

import { createEnvAdmin, envAdminConfig, EnvAdminError } from '@/lib/envAdmin';
import { checkAccess } from '@/lib/settingsAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'cache-control': 'no-store' };

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

async function handle(request: Request, change: boolean, work: (admin: ReturnType<typeof createEnvAdmin>) => Promise<unknown>) {
  const access = await checkAccess(request, { change });
  if (!access.ok) return answer({ error: access.message, reason: access.reason }, access.status);

  const config = envAdminConfig();
  if (!config) {
    return answer(
      {
        error:
          'VERCEL_API_TOKEN is not set, so this page cannot reach Vercel. Add it once in the Vercel dashboard.',
        reason: 'not_configured',
      },
      503,
    );
  }

  try {
    return answer((await work(createEnvAdmin(config))) ?? { ok: true });
  } catch (error) {
    if (error instanceof EnvAdminError) return answer({ error: error.message }, error.status);
    return answer({ error: 'Something went wrong reaching Vercel.' }, 502);
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request, false, async (admin) => ({ envs: await admin.list() }));
}

export async function POST(request: Request): Promise<Response> {
  return handle(request, true, async (admin) => {
    const body = await readJson(request);
    await admin.set(String(body.name ?? '').trim(), String(body.value ?? ''));
    return { ok: true };
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request, true, async (admin) => {
    const body = await readJson(request);
    await admin.remove(String(body.id ?? ''));
    return { ok: true };
  });
}

export async function PUT(request: Request): Promise<Response> {
  return handle(request, true, async (admin) => ({
    ok: true,
    url: await admin.redeploy(process.env.VERCEL_DEPLOYMENT_ID),
  }));
}
