'use client';

// The browser half of the authorization server: the sign-in and consent pages
// talk to it. It only ever runs in a page, never in the MCP endpoint.

import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});
