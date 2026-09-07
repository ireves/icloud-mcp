import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(authHeader: string | string[] | undefined): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    throw new Error('MCP_AUTH_TOKEN is not set');
  }

  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header || !header.startsWith('Bearer ')) {
    return false;
  }

  const provided = header.slice('Bearer '.length);
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}
