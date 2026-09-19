// Only the schema tool reads this file. It wants a real authorization server it
// can inspect, and it cannot see through the stand-in that lib/auth.ts exports,
// which deliberately builds one on first use so that a build with no
// environment variables set still succeeds.
//
// Run it with the variables from .env.example in a .env.local file:
//
//   npm run auth:migrate

import { createAuth } from './auth.js';

export const auth = createAuth();
