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
| `MCP_PUBLIC_URL` | The address this server will finally live at, e.g. `https://icloud-mcp.example.com`. Scheme and host only; any path is ignored. Set it before you register a passkey: a passkey is tied to the hostname, and clients reject a server that names itself differently from the address they were given. |
| `BETTER_AUTH_SECRET` | Signs the tokens this server issues. Generate once with `openssl rand -base64 48`. Changing it signs you out and invalidates every connector. |
| `MCP_OWNER_EMAIL` | Your email address. It labels the single owner account; nothing is ever sent to it. |
| `MCP_SETUP_CODE` | Lets you register the first passkey, once. Generate one with `openssl rand -hex 24`. It stops working the moment a passkey exists, so there is nothing to rotate. |
| `POSTGRES_URL` | The Postgres connection string for the sign-in tables. Set automatically when you connect the Supabase integration in Vercel's Storage tab. Use the pooler connection (port 6543), not the direct one: the direct host answers only over IPv6 and a Vercel function has none. `DATABASE_URL` is read instead when the integration is not in use. |
| `CRON_SECRET` | Optional. When set, the daily keep-alive route answers only Vercel's own scheduled request. Generate it like the others. |
| `BLOCKED_MOVE_DESTINATIONS` | Optional. A comma-separated list of extra folders a message may never be moved into, e.g. `Receipts,Work/Clients`. Trash, Junk, Sent and Drafts are always blocked without being listed. If an entry matches no real folder, every move is refused until it is corrected, so a typo cannot quietly leave a folder unprotected. |
| `ALLOWED_MOVE_DESTINATIONS` | Optional. A comma-separated list of folders a message may be moved into, e.g. `Archive,Receipts,Newsletters,Work/Clients`. `INBOX` is always allowed on top of the list. Leaving it unset allows any folder that is not blocked. Can be combined with `BLOCKED_MOVE_DESTINATIONS`; both then apply. |
| `NOTION_EXCEPTIONS_TOKEN` | Optional. A read-only Notion integration secret, used to read the "Email Sorting Exceptions" database. Leave it unset and the feature is off: `list_exceptions` reports that it is not configured, and no exception is enforced on moves. See [Sorting exceptions](#sorting-exceptions). |
| `NOTION_EXCEPTIONS_DATA_SOURCE_ID` | Optional. The data source to read those rules from. Defaults to `f2ebf247-9368-498f-86a9-3341260874e1`. |
| `SUPABASE_URL` | The API URL of the Supabase project used to track moves for undo and to remember mail scanning progress. Set automatically, under this name, by the Vercel integration. |
| `SUPABASE_SECRET_KEY` | The full-access key for the same Supabase project, in the form `sb_secret_...`. Set automatically by the Vercel integration. It bypasses row level security, so it must stay server-side and must never reach a browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | The older name for the same thing, used by a Supabase project set up by hand rather than through Vercel. Set one key or the other; `SUPABASE_SECRET_KEY` wins if both are present. |

See `.env.example` for local development — copy it to `.env.local` and fill in real values (never commit it).

### 3. Create the sign-in tables

The server keeps its accounts, passkeys, signing keys and issued tokens in Postgres. `supabase/migrations/20260919120000_better_auth_icloud_tables.sql` creates the thirteen tables it needs, each named with an `icloud_` prefix so they sit beside anything else in the same database rather than on top of it. Apply that file to your project once.

To regenerate it after a library upgrade, point the schema tool at a database and let it work out the difference:

```bash
npm run auth:migrate
```

Every one of those tables has row level security switched on with no policies at all. The server connects as the table owner and so is unaffected, while Supabase's public REST API, which is not the owner, is left with no way to read a single row.

### 4. Deploy

```bash
npm install
npx vercel deploy --prod
```

The Vercel project must be set to the **Next.js** framework preset, and Vercel Authentication (Project Settings → Deployment Protection) must be off for whichever address you hand to a client. It puts a Vercel sign-in page in front of every request, which a connector cannot get past.

Then open `https://<your-deployment>/api/status`. It answers `200` when the settings are all present and the database actually answers, and `503` with the specific reason when not. It reports names and hostnames only, never values, so it is safe to leave public.

### 5. Register your passkey

Open `https://<your-deployment>/sign-in`, choose **Set up a new deployment**, and enter your `MCP_SETUP_CODE`. That registers one passkey against the deployment's hostname.

This works exactly once. Once a passkey exists the server refuses to register another, whatever code is offered, so the setup code becomes inert rather than remaining a way in. To replace a lost passkey, delete the row from `icloud_passkey` and register again.

### 6. Add as a Claude custom connector

In Claude's connector settings, add a custom connector pointing at `https://<your-deployment>/api/mcp`. Leave every other field blank: there is no client ID to paste, no secret, and no callback URL to register anywhere.

Claude works the rest out by itself. It gets a `401`, reads the discovery documents, identifies itself by the metadata document it publishes, sends you here to sign in with your passkey, shows you what it is asking for, and comes back with a token. `/mcp` works as well as `/api/mcp`, in case you type the short form.

Test each tool manually before wiring up a scheduled task.

## Authentication

Two separate things are being protected, and they do not use the same mechanism:

- **Your iCloud account** is reached with `ICLOUD_APP_PASSWORD`, an app-specific password from appleid.apple.com. Apple offers no OAuth route into iCloud Mail, Calendar or Reminders, so this stays as it is.
- **This server's public URL** is protected by OAuth 2.1, and by nothing else. The server is its own authorization server: it signs you in and issues its own tokens, as described in the [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization).

### No outside provider

Earlier versions pointed at a provider such as Auth0 and only checked the tokens it issued. That is gone. There is no provider dashboard to keep in step with this deployment, no client ID or secret to copy between two places, and no redirect URL to re-register when a client changes one.

What replaced it is a passkey. Signing in is a fingerprint or face check against a key that only works on this exact hostname, so a lookalike site has nothing to collect: there is no password to phish and no code to read out.

### How a client identifies itself

Two ways, both automatic, and neither needs anything typed into a dashboard:

- **Client ID Metadata Documents.** The client publishes a small JSON file describing itself, and the URL of that file is its client ID. This is what the 2026-07-28 revision of the MCP specification asks for, and what Claude and ChatGPT prefer. The server fetches that document over a transport that resolves the hostname once, refuses private addresses and follows no redirects, so a client ID cannot be used to point this server at something on its own network.
- **Dynamic client registration**, left on for clients that predate the above.

Either way, the consent screen names the client and, just as importantly, the address your browser will be sent back to. A local address gets a warning of its own, because any program on your machine could be the one asking.

### Tokens

An access token lasts an hour and is bound to `https://<your-deployment>/api/mcp` as its audience, so a token issued for anything else is refused here. Alongside it comes a refresh token lasting 90 days, which is rotated every time it is used.

One refresh token may be replayed within 30 seconds of its rotation. Claude refreshes both ahead of expiry and again on a `401`, and those two can overlap; a stricter window treats the second as a stolen token, revokes the whole chain, and leaves you reconnecting the server by hand.

### Where the discovery documents live

Clients look in several places, in an order the specification fixes, and all of them answer:

- `/.well-known/oauth-protected-resource`, and the same with the MCP path appended
- `/.well-known/oauth-authorization-server`, bare and with the issuer path appended
- `/.well-known/openid-configuration`, both ways

The document describing the protected resource lives at the site root, while the ones describing the authorization server live under its own prefix at `/api/auth`. They are not in the same place, and that is correct rather than an oversight.

### Checking your setup

```bash
curl https://<your-deployment>/api/status
```

It lists any setting that is missing by name, describes the database connection by host and port, and actually opens a connection and runs a query, reporting the driver's own complaint when that fails. It answers `503` until both halves are right. Nothing in it reveals a value.

### Keeping the database awake

A free Supabase project pauses itself after seven days with no activity, which would break every connector until someone opened the dashboard. `vercel.json` schedules one trivial query a day against `/api/cron/keepalive`, which is well inside the once-a-day limit on Vercel's Hobby plan.

### No shared secret

There is no `MCP_AUTH_TOKEN` and no other fixed-string route in. A single long-lived secret that unlocks every tool cannot be scoped to a subset of them, attributed to whoever used it, or expired after a leak, and anything that reads it once has the whole mailbox. If you set that variable in an earlier version, delete it from Vercel; it now unlocks nothing. The same goes for `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, `OAUTH_REQUIRED_SCOPE` and `OAUTH_JWKS_URI`, which this version no longer reads.

Anything that cannot open a browser still needs a token, which means completing the passkey sign-in once in a browser and letting the client refresh from there.

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
| `list_messages` | List message headers in a folder or sub-folder (subject, sender, date, unread, flagged, UID), with filters for date range, sender, subject and text, and a total match count; subjects are marked untrusted |
| `search_mail` | Search every folder except Trash and Junk at once, on the mail server, so old mail is found as easily as new. Matches each word separately (quotes keep a phrase together), filters by sender, recipient, subject and sent date, returns results newest first with their folder and a short untrusted preview, pages with `next_cursor`, falls back to subjects and senders when the text search finds nothing, and reports any folder it could not search |
| `mark_scanned` | Record how far a folder has been processed; only accepts a UID the server has listed |
| `reconcile_flagged` | Return messages unflagged since the previous call, so they get sorted |
| `get_message` | Get full headers and body for one message (HTML converted to plain text, hidden text removed, body marked untrusted) |
| `mark_message` | Mark a message read/unread |
| `list_exceptions` | List the operator's standing sorting rules, read from Notion: sender rules, themed rules, timing and the read rule |
| `move_message` | Move a message to another folder (Trash/Junk, the destination allowlist and the sorting exceptions are all enforced by the server); returns an `operation_id` you can pass to `undo_move` |
| `save_draft` | Save an email in the Drafts folder for you to review and send yourself. Plain text and/or HTML formatting, up to 4 addresses each in To, Cc and Bcc, and up to 10 attachments totalling 3MB; can be threaded as a reply to an existing message. Nothing is ever sent |
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
| `create_event` | Create a personal event (no attendees, no invitations). Can be all-day, can repeat daily, weekly, monthly or yearly (a repeating event with a start time needs a `time_zone` so it keeps its local time across clock changes), and can carry up to 5 alerts |
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

`move_message` blocks moves into or out of any folder whose IMAP special-use metadata (or, as a fallback, exact folder name) identifies it as Trash or Junk. This is enforced in the server itself — there is no tool parameter that can override it, and no combination of agent instructions changes it. Mail in Trash or Junk can still be read, but only you can take it out, from the Mail app.

To lift the restriction, an operator (not the agent) sets `ALLOW_TRASH_JUNK_MOVES=true` in the deployment's environment variables. Leave it unset for the default, safer behaviour.

### Sent and Drafts

Sent and Drafts can be read and searched, but no message may be moved into or out of either. Like the Trash/Junk rule this is enforced in the server, recognised by special-use metadata or, as a fallback, the exact folder name. Unlike that rule there is no override. Saving a draft with `save_draft` is not a move and is unaffected.

### Blocking destinations

`BLOCKED_MOVE_DESTINATIONS` names extra folders that a message may never be moved into, as a comma-separated list such as `Receipts,Work/Clients`. An entry can be a folder's full path or its name, and case and surrounding spaces are ignored. Every other folder is allowed, including folders created later, so the list does not need updating as folders are added. There is no need to list Trash, Junk, Sent or Drafts, since they are always blocked.

If an entry matches no folder in the account, every move is refused, and the error names the entry and lists the folders that do exist. A typo in a block list would otherwise leave the folder it meant to protect open, with nothing to say so. Renaming or deleting a listed folder has the same effect until the list is updated.

`INBOX` can never be blocked, so moving a message back and undoing a move keep working.

### Restricting destinations to a fixed list

`ALLOWED_MOVE_DESTINATIONS` is the stricter alternative: it names the only folders a message may be moved into, as a comma-separated list such as `Archive,Receipts,Newsletters,Work/Clients`. Spaces around the entries are ignored. A move anywhere else is refused, with the allowed folders named in the error. `INBOX` is always permitted on top of the list. The check applies to `undo_move` as well, in the direction the undo actually moves the message.

The trade-off: a fixed list stops an agent that has been talked into picking an odd destination from using any folder you have not named, but it has to be updated for each new folder. A block list needs no upkeep, but any new folder is a valid destination until you block it. Either way nothing is deleted, every move is logged and can be undone, and Trash, Junk, Sent and Drafts stay blocked.

## Sorting exceptions

Some senders have a standing rule: this one always stays in the Inbox, that one always goes to Receipts. Those rules live in a Notion database called **Email Sorting Exceptions**, and the server reads them itself rather than relying on an agent to look them up first. A scheduled sorting task therefore needs no Notion connector of its own.

Each row has these columns:

| Column | Type | Meaning |
|---|---|---|
| `Title` | Title | The row's name. On a themed rule it describes the kind of mail the rule covers. |
| `Sender` | Email (or text) | An address, a domain like `example.com`, or a display name. Leave it empty for a themed rule. |
| `Action` | Select | `Keep in Inbox` or `Move to Folder`. |
| `Destination Folder` | Select (or text) | Used only by `Move to Folder`. |
| `Timing` | Select (or text) | When a move is due, such as `Immediately` or `After 3 days`. |
| `Read Rule` | Checkbox | When ticked, wait until the message has been read before applying the timing. |
| `Notes` | Text | Free text for your own reference. |

A row with a `Sender` is a **sender rule**. A row with no `Sender` is a **themed rule**: `list_exceptions` passes it to the agent, which decides which messages it fits, but the server cannot match it to a message and so does not enforce it. A row with no usable `Action` is still listed, so the agent can report it as incomplete, but nothing is enforced for it. Timing and the read rule are for the agent to apply; the server enforces only the action and destination.

Sender rules are enforced in the server, on every `move_message` and on any `undo_move` that would take a message back out of the Inbox. A move that contradicts a rule is refused, whatever the agent was asked to do. Rows are cached for five minutes per running instance, so an edit in Notion takes up to five minutes to take effect. If the list cannot be read at all, moves are refused rather than allowed through unchecked.

### Giving the server read-only access

You need to be a workspace owner to create a connection.

1. Open Notion's developer portal at [app.notion.com/developers/connections](https://app.notion.com/developers/connections). Under **Build** in the sidebar, choose **Internal connections**, then **Create a new connection**. Name it and pick your workspace.
2. On the **Configuration** tab, set its capabilities: **Read content** and nothing else. It never needs to write.
3. Copy the token from that same tab (**Installation access token**, shown as **Internal Integration Secret** in some workspaces) and set it as `NOTION_EXCEPTIONS_TOKEN` in Vercel's Project Settings → Environment Variables.
4. Give it access to the exceptions database and nothing else: open that database in Notion, use the **•••** menu → **Connections** → **+ Add connection**, and pick your new connection. The **Content access** tab in the developer portal does the same thing.
5. In that same **Connections** list, remove the Claude connector from this database. The server reads the rules now, so Claude no longer needs its own access to them.

If you keep the rules in a different database, put its data source id in `NOTION_EXCEPTIONS_DATA_SOURCE_ID`; otherwise leave it unset.

`Notes` is written by a human, but the server still labels it as untrusted when handing it to an agent, for the same reason it labels message bodies: text that reaches a model as content should never read as an instruction. `Timing` is passed through unlabelled, since the agent is meant to act on it.

## Untrusted content

Everything an outsider wrote arrives labelled. Message bodies, calendar descriptions and reminder notes come back wrapped in a marked block saying the content is data to be read or sorted, never instructions; subjects and the exceptions list's `Notes` column get a shorter inline tag. Anything in the content that imitates one of those markers is replaced, so a message cannot close the block early and carry on as though it were trusted.

This makes an agent less likely to act on an instruction buried in a message. It does not make it impossible, which is why the refusals above (Trash and Junk, the destination allowlist, the sorting exceptions, the scan marker) are enforced in the server, where no amount of persuasion reaches them.

## The scan marker

`list_messages` with `since_last_run` skips everything past the folder's mark, and `mark_scanned` moves that mark forward. A mark set too far ahead is a quiet way to make mail disappear: the messages stay where they are, but no future scan ever looks at them again.

So the server only accepts a UID it has itself returned from `list_messages` for that folder in the last 24 hours. Anything higher is refused, naming the highest it did return. A second check refuses a UID beyond what exists in the folder at all, in case the recorded value is ever wrong.

## Hidden text in messages

A message can carry text a person never sees: white-on-white or zero-height blocks, a `display:none` div, the preheader that sets the preview line, or invisible characters such as zero-width spaces and the Unicode tag block. None of that is visible in a mail client, but all of it reaches anything reading the message automatically.

`get_message` drops it. HTML is converted with those elements skipped entirely, and invisible characters are removed from the result whichever part the body came from. Calendar descriptions and reminder notes get the same character stripping.

The style rules match a whole value rather than the start of one, so small print survives: `font-size:0` is hidden text and is dropped, while `font-size:0.9em` is just small and is kept.

Where a message has both a plain-text and an HTML part, the plain-text part is used as before, unless it is very short next to a much longer HTML part. A one-line text part beside a full HTML message is usually a stub, and occasionally a decoy, so the HTML conversion is used instead.

## When a folder is renumbered

Mail servers number the messages in a folder, and those numbers are what this server stores to remember how far a folder has been sorted. The numbers only mean anything within one UIDVALIDITY, a value the server reports per folder and changes if it ever resets that folder's numbering, usually after the folder is recreated or restored.

Each stored mark records the UIDVALIDITY it belongs to. When a folder's numbering has changed, a mark from the old numbering reads as absent, so `since_last_run` starts from the beginning of the folder rather than skipping to a number that no longer refers to anything. The replacement mark is written under the new numbering even if it is lower than the old one.

A mark stored with no UIDVALIDITY is one written before this was recorded; it cannot be checked after the fact, so it is used as-is. The limits in `mark_scanned` still apply either way.

## Moving the stored data from Upstash

Earlier versions kept this server's durable state in Upstash Redis. If you are switching an existing deployment to Supabase, copy the data across before you cut over, using the credentials for both:

```
npm run migrate:storage             # report what would be copied
npm run migrate:storage -- --apply  # copy it
```

The script reads from Upstash and writes to Supabase. It changes nothing in Upstash and can be run more than once, since every write replaces the matching row rather than adding to it.

What it carries over, and why each matters:

- **Scan positions** (`scan_progress`), which record how far each folder has been scanned. These never expire, and losing them means the next `since_last_run` scan starts from the beginning of the folder and re-presents mail you have already sorted. This is the one worth caring about.
- **Move records from the last 7 days**, so `undo_move` still works for recent moves. Anything already past its 7 days is left behind.
- **Flagged messages held back** from each folder's last scan, and the listed-UID records that `mark_scanned` is checked against. Both of these repair themselves within a day, so they are copied only for tidiness.

Once a move and an undo work against Supabase, remove the Upstash integration from the project.

## Tool results

Every tool declares an output schema, so results go out as structured data as well as the JSON text that carries the same value. A client that understands structured results gets typed fields; one that does not still reads the text.

The server checks each successful result against its tool's schema before sending it, so a result that no longer matches fails here rather than reaching a client in an unexpected shape. Errors and refusals are exempt and still come back as plain text.

A structured result has to be an object, so the tools that used to return a bare list now name it: `list_folders` returns `{ "folders": [...] }`, `list_calendars` returns `{ "calendars": [...] }`, `list_events` returns `{ "events": [...] }`, `list_reminder_lists` returns `{ "lists": [...] }`, and `list_reminders` returns `{ "reminders": [...] }`. Every other tool's shape is unchanged.

## Recovering from a move

Every `move_message` call is durably logged in Supabase for 7 days, independently of the mail server itself. `undo_move` reverses a logged move, but only after re-verifying that the message is still where it was left: it checks the destination folder's UIDVALIDITY hasn't changed and that the message's identity (Message-ID, date, and subject) still matches what was originally moved, before moving anything back. The same Trash/Junk policy applies to undo as to the original move.

Use `list_move_operations` to see recent moves and their status, or `get_move_operation` with an `operation_id` to inspect one in detail. A move can be in one of five states: `pending` (in progress), `confirmed` (completed and undoable), `failed` (didn't happen — nothing to undo), `uncertain` (the mail server's response was ambiguous, so the outcome couldn't be confirmed), or `undone`. Calling `undo_move` on an `uncertain` operation automatically attempts to reconcile it first, by checking both the source and destination folders for the message; if that reconciliation is itself ambiguous, `undo_move` refuses and asks for manual verification rather than guessing.

## v1 scope

Deliberately out of scope: sending mail (drafts can be saved, but only you can send them; the server only connects to iCloud's IMAP server, which has no command for sending, and `test/lib/no-sending.test.ts` fails if any code that could send mail is added), permanently deleting mail/emptying trash, calendar invitations or attendees, deleting events or reminders. Reminders reflect iCloud's legacy CalDAV/VTODO data model, not everything the current Reminders app supports — this is an Apple platform limitation.
