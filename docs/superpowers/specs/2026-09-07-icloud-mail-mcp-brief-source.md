# iCloud Mail, Calendar & Reminders MCP Server — Build Brief

## What this is

A remote MCP server that connects iCloud Mail, Calendar, and Reminders to Claude, so it can read, search, and organise all three through Claude Cowork scheduled tasks. It replaces the paid Pear MCP service with a self-hosted equivalent.

## What this is NOT

- **No AI reasoning inside the server.** This is a tool provider only. Claude does the thinking, decisions, and any classification logic when the scheduled task runs and calls these tools. Do not add any LLM API calls, prompts, or decision-making code to the server itself.
- **No API key billing.** This uses my existing Claude subscription's scheduled task feature (Cowork), not a pay-per-token API key. Nothing here should require an OpenAI or Anthropic API key.
- **No sending mail yet.** This is a read-and-organise tool for v1. Sending mail (SMTP) is deliberately out of scope until the read/write tools have been tested and trusted.
- **No calendar invitations to other people.** Events created through this tool should not add attendees or trigger invitation emails. Treat that the same way as "sending mail": out of scope for now.
- **Reminders will only see legacy data.** iCloud's CalDAV interface (which this tool uses) only exposes the older reminders data model, not everything the current Reminders app supports. This is a known Apple limitation, not a bug to work around. Flag anything that looks broken here rather than trying to fix it.

## Architecture

- **Host:** Vercel, using the standard Node.js serverless runtime (not the Edge runtime). The Node.js runtime is required because it gives native `net`/`tls` support, needed to speak IMAP directly.
- **Mail protocol:** IMAP over TLS to iCloud's mail server (`imap.mail.me.com`, port 993).
- **Calendar and Reminders protocol:** CalDAV to iCloud's CalDAV server (`caldav.icloud.com`), using service discovery from the well-known URL rather than a hardcoded path, since Apple's principal URLs are account-specific. Reminders are exposed through CalDAV as to-do items (VTODO) inside their own calendars, alongside ordinary event calendars (VEVENT). Treat "reminder lists" and "calendars" as the same underlying object type, distinguished by what they contain.
- **Auth to iCloud:** one app-specific password (not my main Apple ID password), generated at appleid.apple.com, used for both IMAP and CalDAV. I will generate this myself and provide it as an environment variable.
- **MCP transport:** HTTP, using the official MCP SDK (`@modelcontextprotocol/sdk`), so the resulting URL can be added to Claude as a custom connector.
- **No database for v1.** If tracking sync state (e.g. "already processed") becomes necessary later, that's a follow-up, not part of this build.

## Tools to build (v1 scope)

All read operations, plus light, reversible write operations. Nothing destructive, and nothing that contacts other people.

### Mail (IMAP)

1. **list_folders** — return the mailbox's folder/mailbox list.
2. **list_messages** — params: folder, limit, unread_only, since_date, from_address. Returns headers only (subject, sender, date, unread status, message UID), not full bodies, to keep responses small.
3. **get_message** — params: folder, uid. Returns full headers plus the message body. Strip HTML down to readable plain text where the message is HTML-only.
4. **mark_message** — params: folder, uid, read (true/false).
5. **move_message** — params: folder, uid, target_folder.
6. **flag_message** — params: folder, uid, flagged (true/false).

**Explicitly out of scope for v1:** sending mail, permanently deleting mail, emptying trash.

### Calendar (CalDAV)

7. **list_calendars** — return the account's calendars (name, identifier, colour if available).
8. **list_events** — params: calendar_id, start_date, end_date. Returns event summaries (title, start/end time, location, whether it has attendees) for the given range.
9. **get_event** — params: calendar_id, event_id. Returns full event details.
10. **create_event** — params: calendar_id, title, start_time, end_time, location, notes. Must not add attendees or send invitations, this is for personal scheduling only.
11. **update_event** — params: calendar_id, event_id, plus whichever fields are changing. Same no-attendees restriction applies.

**Explicitly out of scope for v1:** deleting events, adding attendees, anything that sends a calendar invitation to another person.

### Reminders (CalDAV, VTODO)

12. **list_reminder_lists** — return the account's reminder lists.
13. **list_reminders** — params: list_id, include_completed (default false). Returns reminder summaries (title, due date, completed status).
14. **get_reminder** — params: list_id, reminder_id. Returns full reminder details.
15. **create_reminder** — params: list_id, title, due_date, notes.
16. **complete_reminder** — params: list_id, reminder_id, completed (true/false).

**Explicitly out of scope for v1:** deleting reminders.

## Tech stack

- **Language:** TypeScript
- **IMAP library:** `imapflow` (mature, promise-based, actively maintained). Don't use a Cloudflare-Workers-specific IMAP library; Vercel's Node.js runtime doesn't need one.
- **CalDAV library:** `tsdav` (TypeScript, actively maintained, has documented support for iCloud specifically). Use it for both calendar and reminder access rather than hand-rolling CalDAV/iCalendar parsing.
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Runtime:** Vercel Functions, Node.js runtime explicitly configured (not Edge)

## Authentication and security

- **iCloud credentials:** stored as Vercel environment variables `ICLOUD_EMAIL` and `ICLOUD_APP_PASSWORD`, shared by both the IMAP and CalDAV connections, no separate credential needed for calendar/reminders. Never hardcoded, never logged, never returned in tool responses.
- **MCP endpoint protection:** this will be a public URL, so it needs its own access control separate from the iCloud credentials. Protect it with a bearer token shared secret, checked on every incoming request, stored as `MCP_AUTH_TOKEN`. This mirrors how my existing YNAB MCP server on Cloudflare Workers authenticates.
- Reject any request missing or presenting the wrong token before it touches IMAP.

## Repository and deployment

- I will create an empty GitHub repository myself and provide the path before you start.
- Deploy via Vercel, connected to that repo.
- Environment variables are set in the Vercel dashboard, never committed to the repo.
- Include a `.env.example` file showing which variables are needed, with placeholder values only.

## Testing expectations

- Include a way to test the IMAP connection and the CalDAV connection locally (a small script or `vercel dev`), separately from each other, before wiring either up to the MCP layer. Keep connection issues and tool logic issues from being debugged at the same time.
- After deployment, I will add the MCP URL as a custom connector in Claude and test each tool manually before setting up any scheduled task.

## Deliverables

- Working Vercel deployment, reachable at a stable HTTPS URL.
- A README covering: which environment variables to set, how to generate an iCloud app-specific password, how to add this as a custom connector in Claude, and a short description of each tool across mail, calendar, and reminders.
- Clean, readable tool names and descriptions, since Claude will read these descriptions to decide when to use each tool.

## Open questions to flag back to me, not decide unilaterally

- If IMAP folder names or UID handling on iCloud turn out to have quirks (they sometimes do), tell me rather than working around them silently, so I understand what changed.
- If CalDAV discovery on iCloud behaves unexpectedly, or reminder data comes back incomplete because of the legacy-data limitation, describe what you're actually seeing rather than guessing at a fix.
- If the bearer token approach turns out to be insufficient for how Claude's custom connectors expect authentication (e.g. if OAuth turns out to be required rather than optional), flag this before building a workaround.
