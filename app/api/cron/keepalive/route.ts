// Supabase pauses a free project after seven days without database activity,
// and a paused project would break every connector until someone opens the
// dashboard. One trivial query a day keeps it awake, which is well inside
// Vercel's once-per-day limit on the Hobby plan.
//
// Vercel signs its own cron requests with CRON_SECRET when that variable is
// set. Without it the route still works, so a missing secret does not silently
// stop the job, but setting it stops anyone else from calling the route.

import { databaseCheck } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = request.headers.get('authorization');
    if (provided !== `Bearer ${secret}`) {
      return new Response('Not found', { status: 404 });
    }
  }

  const result = await databaseCheck();
  return Response.json(
    { ok: result.reachable, at: new Date().toISOString(), ...result },
    { status: result.reachable ? 200 : 500, headers: { 'cache-control': 'no-store' } },
  );
}
