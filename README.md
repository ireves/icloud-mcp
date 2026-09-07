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
| `MCP_AUTH_TOKEN` | A shared secret this server requires in the `Authorization: Bearer` header. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

See `.env.example` for local development — copy it to `.env` and fill in real values (never commit `.env`).

### 3. Deploy

```bash
npm install
npx vercel deploy --prod
```

Note the deployed URL, e.g. `https://icloud-mcp-yourname.vercel.app`. The MCP endpoint is at `/api/mcp`.

### 4. Add as a Claude custom connector

In Claude's connector settings, add a custom connector pointing at `https://<your-deployment>/api/mcp`, with the `MCP_AUTH_TOKEN` value as the bearer token. Test each tool manually before wiring up a scheduled task.

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
| `move_message` | Move a message to another folder |
| `flag_message` | Flag/unflag a message |

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

## v1 scope

Deliberately out of scope: sending mail, permanently deleting mail/emptying trash, calendar invitations or attendees, deleting events or reminders. Reminders reflect iCloud's legacy CalDAV/VTODO data model, not everything the current Reminders app supports — this is an Apple platform limitation.
