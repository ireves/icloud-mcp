// A plain readiness check: which settings this deployment is missing, and
// whether the database it was pointed at actually answers.
//
// It reports only whether each setting is present, never its value, so it is
// safe to leave public. Use it after a deploy to confirm the server is
// configured before pointing a client at it, and to tell a half-configured
// deployment apart from a broken one.

import { settingsReport, databaseCheck } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = settingsReport();
  // Only worth trying once the connection details are there at all.
  const database = report.database?.source
    ? { ...report.database, ...(await databaseCheck()) }
    : report.database;

  const ok = report.ok && (database as { reachable?: boolean })?.reachable === true;

  return Response.json(
    { ...report, ok, database },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
