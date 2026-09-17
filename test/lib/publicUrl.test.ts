import { afterEach, describe, expect, it } from 'vitest';
import { publicBaseUrl, resourceMetadataUrl } from '../../lib/publicUrl.js';

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL;
});

describe('publicBaseUrl', () => {
  it('prefers the forwarded host and protocol Vercel sets', () => {
    expect(
      publicBaseUrl({ 'x-forwarded-host': 'icloud-mcp.vercel.app', 'x-forwarded-proto': 'https', host: 'internal' }),
    ).toBe('https://icloud-mcp.vercel.app');
  });

  it('falls back to the host header, assuming https', () => {
    expect(publicBaseUrl({ host: 'icloud-mcp.vercel.app' })).toBe('https://icloud-mcp.vercel.app');
  });

  it('uses http for localhost', () => {
    expect(publicBaseUrl({ host: 'localhost:3000' })).toBe('http://localhost:3000');
  });

  it('takes the first entry of a comma-joined forwarded host', () => {
    expect(publicBaseUrl({ 'x-forwarded-host': 'a.example.com, b.example.com', 'x-forwarded-proto': 'https' })).toBe(
      'https://a.example.com',
    );
  });

  it('lets PUBLIC_BASE_URL override everything, without a trailing slash', () => {
    process.env.PUBLIC_BASE_URL = 'https://mcp.example.com/';
    expect(publicBaseUrl({ host: 'ignored' })).toBe('https://mcp.example.com');
  });
});

describe('resourceMetadataUrl', () => {
  it('puts the resource path after the well-known segment, per RFC 9728', () => {
    expect(resourceMetadataUrl('https://mcp.example.com')).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp',
    );
  });
});
