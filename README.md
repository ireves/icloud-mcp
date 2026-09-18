# icloud-mcp

A remote MCP server exposing iCloud Mail, Calendar, and Reminders as tools for Claude — built for use with Claude Cowork scheduled tasks. Self-hosted on Vercel, using your own iCloud account and Claude subscription. No LLM calls happen inside this server; it only provides read/write tools.

## Setup

### 1. Generate an iCloud app-specific password

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. Under **Sign-In and Security**, choose **App-Specific Passwords**.
3. Generate a new one and label it (e.g. "icloud-mcp"). Copy it — you won't see it again.

This password is used for both mail (IMAP) and calendar/reminders (CalDAV). Do not use your main Apple ID password.

### 2. Set environment variables

In the Vercel dashboard, under Project Settings → Environment Variables, set:

| Variable | Description |
|---|---|
| `ICLOUD_EMAIL` | Your iCloud email address |
| `ICLOUD_APP_PASSWORD` | The app-specific password from step 1 |
| `OAUTH_ISSUER` | The base URL of your authorization server, e.g. `https://your-tenant.eu.auth0.com`. A trailing slash makes no difference; the server reads the exact form from the provider itself. Required for OAuth sign-in. |
| `OAUTH_AUDIENCE` | The canonical URL of this MCP server, e.g. `https://<your-deployment>/api/mcp`. Access tokens are only accepted if they were issued for this audience. Required for OAuth sign-in. |
| `OAUTH_REQUIRED_SCOPE` | Optional. Space-separated scopes a token must carry, e.g. `icloud:read icloud:write`. When unset, any valid token for this audience is accepted. |
| `OAUTH_JWKS_URI` | Optional. The signing key address is discovered from the issuer automatically, so this is only needed for a provider that publishes no discovery document. |
| `ALLOWED_MOVE_DESTINATIONS` | Optional. A comma-separated list of folders a message may be moved into, e.g. `Archive,Receipts,Newsletters,Work/Clients`. `INBOX` is always allowed on top of the list. Leaving it unset allows any folder except Trash and Junk, which is the less safe choice. |
| `NOTION_EXCEPTIONS_TOKEN` | Optional. A read-only Notion integration secret, used to read the "Email Sorting Exceptions" database. Leave it unset and the feature is off: `list_exceptions` reports that it is not configured, and no exception is enforced on moves. See [Sorting exceptions](#sorting-exceptions). |
| `NOTION_EXCEPTIONS_DATA_SOURCE_ID` | Optional. The data source to read those rules from. Defaults to `f2ebf247-9368-498f-86a9-3341260874e1`. |
| `KV_REST_API_URL` | REST URL for the Upstash Redis database used to track moves for undo. Set automatically, under this name, when you connect the Upstash integration to this project in Vercel's Storage tab. |
| `KV_REST_API_TOKEN` | REST token for the same Upstash database. Also set automatically by the Vercel integration. |

See `.env.example` for local development — copy it to `.env` and fill in real values (never commit `.env`).

### 3. Deploy

```bash
npm install
npx vercel deploy --prod
```

Note the deployed URL, e.g. `https://icloud-mcp-yourname.vercel.app`. The MCP endpoint is at `/api/mcp`.

### 4. Add as a Claude custom connector

In Claude's connector settings, add a custom connector pointing at `https://<your-deployment>/api/mcp`. Claude discovers the sign-in step by itself: it gets a 401, reads `/.well-known/oauth-protected-resource`, and sends you to your authorization server to sign in. Leave the bearer token field blank.

OAuth is the only way in. Until `OAUTH_ISSUER` and `OAUTH_AUDIENCE` are both set, the server rejects every request rather than running unprotected, so set them before you deploy.

Test each tool manually before wiring up a scheduled task.

## Authentication

Two separate things are being protected, and they do not use the same mechanism:

- **Your iCloud account** is reached with `ICLOUD_APP_PASSWORD`, an app-specific password from appleid.apple.com. Apple offers no OAuth route into iCloud Mail, Calendar or Reminders, so this stays as it is.
- **This server's public URL** is protected by OAuth, and by nothing else. The server acts as an OAuth 2.1 resource server, as described in the [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization). It validates access tokens but never issues them; signing people in is your authorization server's job.

### Choosing an authorization server

Any provider that issues JWT access tokens and publishes OpenID discovery metadata will work, including Auth0, Clerk, WorkOS, Stytch and Descope. What the provider has to do:

1. Register your MCP URL, e.g. `https://<your-deployment>/api/mcp`, as the thing tokens are issued for. Providers name this differently: Auth0 calls it an API, WorkOS calls it a resource indicator (under Connect → Configuration). That identifier becomes `OAUTH_AUDIENCE`.

   This step is not optional. A token that is not addressed to this server is rejected, and several providers, WorkOS among them, leave the `aud` claim off entirely until you register the URL.
2. Sign tokens with an asymmetric algorithm (RS256 or ES256). The server finds the public keys by reading the issuer's discovery document, so the key address itself needs no configuration.
3. Allow the client registration that Claude needs, or skip it: for a custom connector you can paste a client ID into Claude's advanced settings instead. If you prefer automatic registration, enable Client ID Metadata Documents or Dynamic Client Registration, whichever your provider offers.
4. Register `https://claude.ai/api/mcp/auth_callback` as an allowed callback URL.

### What the server does on each request

On startup the server asks your provider where its signing keys are and what it calls itself, by reading the provider's own discovery document. That covers the differences between providers: WorkOS publishes keys at `/oauth2/jwks` and Auth0 at `/.well-known/jwks.json`, and Auth0 puts a trailing slash on its issuer while most others do not. Nothing about that needs configuring.

Then, per request:

1. No token, or a token it cannot verify, gets a `401` with a `WWW-Authenticate` header naming `/.well-known/oauth-protected-resource`.
2. That document, served by `api/oauth-protected-resource.ts`, names your authorization server. The client signs you in there and comes back with an access token.
3. Every later request is checked for signature, issuer, audience and (if set) scope. A valid token missing a required scope gets a `403` naming the scopes needed, so the client can ask for them.

Tokens still travel in the `Authorization: Bearer` header. The change is that they are short-lived and issued after a sign-in, rather than one fixed string pasted into a settings field.

### Checking your setup

```bash
npm run check:oauth                    # checks the configuration and the issuer
npm run check:oauth -- <access-token>  # also checks a real token end to end
```

It reports what clients will discover, whether the signing keys are reachable, and, given a token, whether the audience lines up. The audience mismatch above is the most common cause of a connector that signs in and then fails.

### No shared secret

There is no `MCP_AUTH_TOKEN` and no other fixed-string route in. A single long-lived secret that unlocks every tool cannot be scoped to a subset of them, attributed to whoever used it, or expired after a leak, and anything that reads it once has the whole mailbox. If you set that variable in an earlier version, delete it from Vercel; it now unlocks nothing.

Anything that cannot open a browser, a scheduled run included, needs a token from your authorization server instead. Most providers issue one to a machine caller directly, usually under a name like "machine to machine" or "client credentials".

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
| `list_messages` | List message headers in a folder (subject, sender, date, unread, UID); subjects are marked untrusted |
| `mark_scanned` | Record how far a folder has been processed; only accepts a UID the server has listed |
| `reconcile_flagged` | Return messages unflagged since the previous call, so they get sorted |
| `get_message` | Get full headers and body for one message (HTML converted to plain text, hidden text removed, body marked untrusted) |
| `mark_message` | Mark a message read/unread |
| `list_exceptions` | List the operator's standing sorting rules, read from Notion |
| `move_message` | Move a message to another folder (Trash/Junk, the destination allowlist and the sorting exceptions are all enforced by the server); returns an `operation_id` you can pass to `undo_move` |
| `flag_message` | Flag/unflag a message |
| `undo_move` | Reverse a previous `move_message` by its `operation_id`, with the same destination checks applied in reverse |
| `list_move_operations` | List recent move operations, most recent first |
| `get_move_operation` | Get the full record for one move operation |

### Calendar (CalDAV)

| Tool | Description |
|---|---|
| `list_calendars` | List event calendars |
| `list_events` | List events in a calendar within a date range (max 366 days); occurrence identifiers are stable and resolve to the exact occurrence |
| `get_event` | Get full details for one event or occurrence (explicit error if the occurrence can no longer be resolved); the description is marked untrusted |
| `create_event` | Create a personal event (no attendees, no invitations) |
| `update_event` | Update fields on an existing event (no attendees, no invitations) |

### Reminders (CalDAV/VTODO)

| Tool | Description |
|---|---|
| `list_reminder_lists` | List reminder lists |
| `list_reminders` | List reminders in a list (title, due date, completed) |
| `get_reminder` | Get full details for one reminder; the notes are marked untrusted |
| `create_reminder` | Create a reminder |
| `complete_reminder` | Mark a reminder completed or reopen it |

## Mailbox safety

`move_message` blocks moves into any folder whose IMAP special-use metadata (or, as a fallback, exact folder name) identifies it as Trash or Junk. This is enforced in the server itself — there is no tool parameter that can override it, and no combination of agent instructions changes it. Moving a message *out of* Trash or Junk (recovery) is always allowed.

To lift the restriction, an operator (not the agent) sets `ALLOW_TRASH_JUNK_MOVES=true` in the deployment's environment variables. Leave it unset for the default, safer behaviour.

### Restricting destinations further

`ALLOWED_MOVE_DESTINATIONS` names the only folders a message may be moved into, as a comma-separated list such as `Archive,Receipts,Newsletters,Work/Clients`. Spaces around the entries are ignored. A move anywhere else is refused, with the allowed folders named in the error.

`INBOX` is always permitted as a destination on top of whatever the list says, so recovering a message and undoing a move keep working. The check applies to `undo_move` as well, in the direction the undo actually moves the message.

Leaving the variable unset allows any folder that is not Trash or Junk. That is the less safe choice: an agent talked into inventing a destination can move mail somewhere you will not think to look. Setting the list is what stops it.

## Sorting exceptions

Some senders have a standing rule: this one always stays in the Inbox, that one always goes to Receipts. Those rules live in a Notion database called **Email Sorting Exceptions**, and the server reads them itself rather than relying on an agent to look them up first. A scheduled sorting task therefore needs no Notion connector of its own.

Each row has a `Sender` (an address, a domain like `example.com`, or a display name), an `Action` of either `Keep in Inbox` or `Move to Folder`, a `Destination Folder` used only by the second action, and free-text `Notes` and `Timing` columns for your own reference.

The rules are enforced in the server, on every `move_message` and on any `undo_move` that would take a message back out of the Inbox. A move that contradicts a rule is refused, whatever the agent was asked to do. Rows are cached for five minutes per running instance, so an edit in Notion takes up to five minutes to take effect. If the list cannot be read at all, moves are refused rather than allowed through unchecked.

### Giving the server read-only access

1. In Notion, open **Settings → Connections → Develop or manage integrations**, and create a new internal integration.
2. Under its capabilities, tick **Read content** and nothing else. It never needs to write.
3. Copy the integration secret and set it as `NOTION_EXCEPTIONS_TOKEN` in Vercel's Project Settings → Environment Variables.
4. Open the Email Sorting Exceptions database in Notion, use the **`...`** menu → **Connections**, and add your new integration. Share only this database with it.
5. In that same Connections list, remove the Claude connector from this database. The server reads the rules now, so Claude no longer needs its own access to them.

If you keep the rules in a different database, put its data source id in `NOTION_EXCEPTIONS_DATA_SOURCE_ID`; otherwise leave it unset.

`Notes` and `Timing` are written by a human, but the server still labels them as untrusted when handing them to an agent, for the same reason it labels message bodies: text that reaches a model as content should never read as an instruction.

## Untrusted content

Everything an outsider wrote arrives labelled. Message bodies, calendar descriptions and reminder notes come back wrapped in a marked block saying the content is data to be read or sorted, never instructions; subjects and the exceptions list's free-text columns get a shorter inline tag. Anything in the content that imitates one of those markers is replaced, so a message cannot close the block early and carry on as though it were trusted.

This makes an agent less likely to act on an instruction buried in a message. It does not make it impossible, which is why the refusals above (Trash and Junk, the destination allowlist, the sorting exceptions, the scan marker) are enforced in the server, where no amount of persuasion reaches them.

## The scan marker

`list_messages` with `since_last_run` skips everything past the folder's mark, and `mark_scanned` moves that mark forward. A mark set too far ahead is a quiet way to make mail disappear: the messages stay where they are, but no future scan ever looks at them again.

So the server only accepts a UID it has itself returned from `list_messages` for that folder in the last 24 hours. Anything higher is refused, naming the highest it did return. A second check refuses a UID beyond what exists in the folder at all, in case the recorded value is ever wrong.

## Hidden text in messages

A message can carry text a person never sees: white-on-white or zero-height blocks, a `display:none` div, the preheader that sets the preview line, or invisible characters such as zero-width spaces and the Unicode tag block. None of that is visible in a mail client, but all of it reaches anything reading the message automatically.

`get_message` drops it. HTML is converted with those elements skipped entirely, and invisible characters are removed from the result whichever part the body came from. Calendar descriptions and reminder notes get the same character stripping.

The style rules match a whole value rather than the start of one, so small print survives: `font-size:0` is hidden text and is dropped, while `font-size:0.9em` is just small and is kept.

Where a message has both a plain-text and an HTML part, the plain-text part is used as before, unless it is very short next to a much longer HTML part. A one-line text part beside a full HTML message is usually a stub, and occasionally a decoy, so the HTML conversion is used instead.

## Recovering from a move

Every `move_message` call is durably logged in Upstash Redis for 7 days, independently of the mail server itself. `undo_move` reverses a logged move, but only after re-verifying that the message is still where it was left: it checks the destination folder's UIDVALIDITY hasn't changed and that the message's identity (Message-ID, date, and subject) still matches what was originally moved, before moving anything back. The same Trash/Junk destination policy applies to undo as to the original move.

Use `list_move_operations` to see recent moves and their status, or `get_move_operation` with an `operation_id` to inspect one in detail. A move can be in one of five states: `pending` (in progress), `confirmed` (completed and undoable), `failed` (didn't happen — nothing to undo), `uncertain` (the mail server's response was ambiguous, so the outcome couldn't be confirmed), or `undone`. Calling `undo_move` on an `uncertain` operation automatically attempts to reconcile it first, by checking both the source and destination folders for the message; if that reconciliation is itself ambiguous, `undo_move` refuses and asks for manual verification rather than guessing.

## v1 scope

Deliberately out of scope: sending mail, permanently deleting mail/emptying trash, calendar invitations or attendees, deleting events or reminders. Reminders reflect iCloud's legacy CalDAV/VTODO data model, not everything the current Reminders app supports — this is an Apple platform limitation.
