import 'dotenv/config';
import { decodeJwt } from 'jose';
import { authenticate, discoverAuthServer, isOAuthConfigured, issuer, requiredScopes, resourceIdentifier } from '../lib/auth.js';
import { protectedResourceMetadata } from '../lib/metadata.js';

/**
 * Checks an OAuth setup end to end before you wire the server into Claude.
 *
 * Run without arguments to check the configuration itself. Pass an access token
 * to also check that a real token from your provider would be accepted:
 *
 *   npm run check:oauth -- <access-token>
 */

let failures = 0;

function pass(message: string) {
  console.log(`  ok    ${message}`);
}

function fail(message: string, remedy: string) {
  failures += 1;
  console.log(`  FAIL  ${message}`);
  console.log(`        ${remedy}`);
}

async function checkConfiguration() {
  console.log('--- configuration ---');

  if (!isOAuthConfigured()) {
    fail(
      'OAUTH_ISSUER and OAUTH_AUDIENCE are not both set',
      'Set them in .env for a local check, or in the Vercel dashboard for the deployment.',
    );
    return false;
  }

  pass(`issuer is ${issuer()}`);
  pass(`this server is identified as ${resourceIdentifier()}`);

  const scopes = requiredScopes();
  pass(scopes.length > 0 ? `required scopes: ${scopes.join(' ')}` : 'no scopes required; any valid token is accepted');

  try {
    new URL(resourceIdentifier());
  } catch {
    fail(
      'OAUTH_AUDIENCE is not a valid absolute URL',
      'It must be the full address of this server, e.g. https://your-deployment.vercel.app/api/mcp',
    );
  }

  return true;
}

async function checkDiscovery() {
  console.log('\n--- authorization server ---');

  try {
    const metadata = await discoverAuthServer();
    pass(`signing keys found at ${metadata.jwksUri}`);
    pass(`tokens will be checked against the issuer "${metadata.issuer}"`);
    if (metadata.issuer !== issuer()) {
      console.log('        (your provider publishes it slightly differently to how you typed it,');
      console.log('         which is normal for Auth0 and is handled automatically)');
    }
  } catch (error) {
    fail(
      error instanceof Error ? error.message : 'Could not reach the authorization server',
      'Check OAUTH_ISSUER is the full address including https:// and is reachable.',
    );
  }
}

function checkMetadata() {
  console.log('\n--- what clients will discover ---');

  try {
    const metadata = protectedResourceMetadata();
    console.log(JSON.stringify(metadata, null, 2).split('\n').map((line) => `        ${line}`).join('\n'));
    pass('the metadata document builds cleanly');
    console.log(`        The "resource" value above must match the URL you type into Claude exactly, path included.`);
  } catch (error) {
    fail(
      error instanceof Error ? error.message : 'Could not build the metadata document',
      'Set OAUTH_ISSUER and OAUTH_AUDIENCE.',
    );
  }
}

async function checkToken(token: string) {
  console.log('\n--- supplied access token ---');

  // A signed token has three dot-separated parts. Five means it is encrypted
  // (a JWE), which Auth0 issues when it has no audience to address the token to.
  // The server cannot read it, so name the cause rather than just failing.
  if (token.split('.').length === 5) {
    fail(
      'That token is encrypted, not signed, so this server cannot read it',
      'Auth0 does this when no audience is set. In the Auth0 dashboard, go to Settings → General → Default Audience and set it to this server\'s URL, then sign in again.',
    );
    return;
  }

  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(token);
  } catch {
    fail(
      'That does not look like a JWT',
      'Copy an access token your provider issued for this server, not an ID token or an API key.',
    );
    return;
  }

  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : audience ? [audience] : [];

  if (audiences.length === 0) {
    fail(
      'The token carries no audience (aud) claim',
      'Register this server\'s URL with your provider as the thing tokens are for: in Auth0, create an API whose identifier is that URL and request it as the audience; in WorkOS, add it as a resource indicator. Without that, the token is not addressed to this server and is rejected.',
    );
  } else if (!audiences.includes(resourceIdentifier())) {
    fail(
      `The token is for ${audiences.join(', ')}, not ${resourceIdentifier()}`,
      'Make OAUTH_AUDIENCE and the resource indicator registered with your provider the same string.',
    );
  } else {
    pass(`audience matches ${resourceIdentifier()}`);
  }

  const result = await authenticate(`Bearer ${token}`);
  if (result.ok) {
    pass(`accepted via ${result.method}${result.subject ? ` as ${result.subject}` : ''}`);
    if (result.scopes.length > 0) {
      pass(`scopes on the token: ${result.scopes.join(' ')}`);
    }
  } else {
    fail(`rejected: ${result.detail}`, `The server would return ${result.status} for this token.`);
  }
}

async function main() {
  const token = process.argv[2];

  const configured = await checkConfiguration();
  if (configured) {
    await checkDiscovery();
    checkMetadata();
    if (token) {
      await checkToken(token);
    } else {
      console.log('\nPass an access token to check a real token too:');
      console.log('  npm run check:oauth -- <access-token>');
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} problem${failures === 1 ? '' : 's'} found.`);
    process.exit(1);
  }
  console.log('No problems found.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
