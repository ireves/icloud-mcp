// Who may use the settings page, decided on the server for every request.
//
// Three checks, in order:
//
//   - The request came from this site's own pages. A session cookie travels with
//     any request the browser makes, including one a different site starts, so
//     a change is accepted only when the browser says it came from here.
//   - Someone is signed in, and it is the owner.
//   - For a change, that sign-in is recent. A session lasts days; a passkey check
//     a few minutes ago is what shows the person at the keyboard is the owner,
//     rather than whoever finds an unlocked laptop.

import { auth, publicOrigin } from '@/lib/auth';

export const FRESH_SIGN_IN_MS = 15 * 60 * 1000;

export type Access =
  | { ok: true }
  | { ok: false; status: number; reason: 'cross_site' | 'signed_out' | 'not_owner' | 'stale'; message: string };

export function sameSite(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  return origin === publicOrigin() || origin === new URL(request.url).origin;
}

export async function checkAccess(request: Request, { change }: { change: boolean }): Promise<Access> {
  if (change && !sameSite(request)) {
    return { ok: false, status: 403, reason: 'cross_site', message: 'That request did not come from this site.' };
  }

  const result = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!result?.session) {
    return { ok: false, status: 401, reason: 'signed_out', message: 'Sign in first.' };
  }

  const owner = (process.env.MCP_OWNER_EMAIL || '').trim().toLowerCase();
  if (!owner || result.user?.email?.toLowerCase() !== owner) {
    return { ok: false, status: 403, reason: 'not_owner', message: 'Only the owner can change settings.' };
  }

  if (change) {
    const signedInAt = new Date(result.session.createdAt).getTime();
    if (!Number.isFinite(signedInAt) || Date.now() - signedInAt > FRESH_SIGN_IN_MS) {
      return {
        ok: false,
        status: 401,
        reason: 'stale',
        message: 'Sign in again with your passkey to make changes.',
      };
    }
  }

  return { ok: true };
}
