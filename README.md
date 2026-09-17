# icloud-mcp

A remote MCP server exposing iCloud Mail, Calendar, and Reminders as tools for Claude — built for use with Claude Cowork scheduled tasks. Self-hosted on Vercel, using your own iCloud account and Claude subscription. No LLM calls happen inside this server; it only provides read/write tools.

## Setup

### 1. Generate an iCloud app-specific password

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. Under **Sign-In and Security**, choose **App-Specific Passwords**.
3. Generate a new one and label it (e.g. "icloud-mcp"). Copy it — you won't see it again.

This password is used for both mail (IMAP) and calendar/reminders (CalDAV). Do not use your main Apple ID password.

### 2. Set up sign-in

Access to this server is protected by OAuth. You sign in through an outside service (Auth0, Clerk, WorkOS, Okta, Keycloak — anything publishing standard OpenID Connect discovery), and this server only checks that the token it receives is genuine. No sign-in screen, password or token store lives in this project.

In that service, create an **API** (some call it a resource or audience) whose identifier is your deployed MCP endpoint, e.g. `https://icloud-mcp-yourname.vercel.app/api/mcp`, and give it a scope named `mcp:access`. Allow dynamic client registration if the service offers it, since that is how Claude registers itself.

### 3. Set environment variables

In the Vercel dashboard, under Project Settings → Environment Variables, set:

| Variable | Description |
|---|---|
| `ICLOUD_EMAIL` | Your iCloud email address |
| `ICLOUD_APP_PASSWORD` | The app-specific password from step 1 |
| `OAUTH_ISSUER` | The sign-in service's base URL, exactly as it appears in the `iss` claim of its tokens |
| `OAUTH_AUDIENCE` | This server's identifier, as registered in step 2. Tokens must name it |
| `OAUTH_REQUIRED_SCOPE` | Optional. Scope a token must carry. Defaults to `mcp:access`; set it empty to skip the check |
| `OAUTH_JWKS_URI` | Optional. Only if signing keys are published somewhere other than `<issuer>/.well-known/jwks.json` |
| `PUBLIC_BASE_URL` | Optional. Overrides the public URL in the discovery document. Normally worked out from the request |
| `MCP_AUTH_TOKEN` | Optional, being retired. The original shared secret. While set, it is still accepted alongside OAuth so an existing connector keeps working |
| `KV_REST_API_URL` | REST URL for the Upstash Redis database used to track moves for undo. Set automatically, under this name, when you connect the Upstash integration to this project in Vercel's Storage tab. |
| `KV_REST_API_TOKEN` | REST token for the same Upstash database. Also set automatically by the Vercel integration. |

At least one of OAuth (`OAUTH_ISSUER` plus `OAUTH_AUDIENCE`) or `MCP_AUTH_TOKEN` must be set, or the server refuses every request.

See `.env.example` for local development — copy it to `.env` and fill in real values (never commit `.env`).

### 4. Deploy

```bash
npm install
npx vercel deploy --prod
```

Note the deployed URL, e.g. `https://icloud-mcp-yourname.vercel.app`. The MCP endpoint is at `/api/mcp`.

### 5. Add as a Claude custom connector

In Claude's connector settings, add a custom connector pointing at `https://<your-deployment>/api/mcp`, and leave the token field empty. Claude will find the sign-in service by itself and open a browser window for you to approve access. Test each tool manually before wiring up a scheduled task.

If you still have a connector using the old shared secret, it keeps working while `MCP_AUTH_TOKEN` remains set. Once the OAuth connector is proven, remove that variable in Vercel and redeploy, which retires the old token for good.

## How sign-in works

The server acts purely as a resource server, in OAuth terms, so it checks tokens but never issues them.

1. Claude calls `/api/mcp` with no token and gets back `401` with a `WWW-Authenticate` header naming the discovery document.
2. Claude fetches `/.well-known/oauth-protected-resource/api/mcp`, which names the sign-in service and the scope required.
3. Claude registers itself with that service, sends you to sign in, and receives a short-lived access token.
4. Every later call carries that token. The server checks the signature against the service's published keys, checks the issuer and audience, and checks the scope, before any tool runs.

Because the token expires and can be revoked at the sign-in service, losing one is far less serious than losing the old shared secret.

## Local testing

Before deploying, verify each protocol independently:

```bash
npm run test:imap    # exercises lib/imap.ts against real IMAP
npm run test:caldav  # exercises lib/caldav.ts against real CalDAV
```

Both read from a local `.env` file and print what they find. Run them separately so a connection problem in one protocol doesn't get confused with the other.

## Tools

### Mail (IMAP)

| Tool | Description |
|---|---|
| `list_folders` | List all mail folders |
| `list_messages` | List message headers in a folder (subject, sender, date, unread, UID) |
| `get_message` | Get full headers and body for one message (HTML converted to plain text) |
| `mark_message` | Mark a message read/unread |
| `move_message` | Move a message to another folder (moves into Trash/Junk are blocked by default, server-enforced); returns an `operation_id` you can pass to `undo_move` |
| `flag_message` | Flag/unflag a message |
| `undo_move` | Reverse a previous `move_message` by its `operation_id`, with safety checks |
| `list_move_operations` | List recent move operations, most recent first |
| `get_move_operation` | Get the full record for one move operation |

### Calendar (CalDAV)

| Tool | Description |
|---|---|
| `list_calendars` | List event calendars |
| `list_events` | List events in a calendar within a date range (max 366 days); occurrence identifiers are stable and resolve to the exact occurrence |
| `get_event` | Get full details for one event or occurrence (explicit error if the occurrence can no longer be resolved) |
| `create_event` | Create a personal event (no attendees, no invitations) |
| `update_event` | Update fields on an existing event (no attendees, no invitations) |

### Reminders (CalDAV/VTODO)

| Tool | Description |
|---|---|
| `list_reminder_lists` | List reminder lists |
| `list_reminders` | List reminders in a list (title, due date, completed) |
| `get_reminder` | Get full details for one reminder |
| `create_reminder` | Create a reminder |
| `complete_reminder` | Mark a reminder completed or reopen it |

## Mailbox safety

`move_message` blocks moves into any folder whose IMAP special-use metadata (or, as a fallback, exact folder name) identifies it as Trash or Junk. This is enforced in the server itself — there is no tool parameter that can override it, and no combination of agent instructions changes it. Moving a message *out of* Trash or Junk (recovery) is always allowed.

To lift the restriction, an operator (not the agent) sets `ALLOW_TRASH_JUNK_MOVES=true` in the deployment's environment variables. Leave it unset for the default, safer behaviour.

## Recovering from a move

Every `move_message` call is durably logged in Upstash Redis for 7 days, independently of the mail server itself. `undo_move` reverses a logged move, but only after re-verifying that the message is still where it was left: it checks the destination folder's UIDVALIDITY hasn't changed and that the message's identity (Message-ID, date, and subject) still matches what was originally moved, before moving anything back. The same Trash/Junk destination policy applies to undo as to the original move.

Use `list_move_operations` to see recent moves and their status, or `get_move_operation` with an `operation_id` to inspect one in detail. A move can be in one of five states: `pending` (in progress), `confirmed` (completed and undoable), `failed` (didn't happen — nothing to undo), `uncertain` (the mail server's response was ambiguous, so the outcome couldn't be confirmed), or `undone`. Calling `undo_move` on an `uncertain` operation automatically attempts to reconcile it first, by checking both the source and destination folders for the message; if that reconciliation is itself ambiguous, `undo_move` refuses and asks for manual verification rather than guessing.

## v1 scope

Deliberately out of scope: sending mail, permanently deleting mail/emptying trash, calendar invitations or attendees, deleting events or reminders. Reminders reflect iCloud's legacy CalDAV/VTODO data model, not everything the current Reminders app supports — this is an Apple platform limitation.
