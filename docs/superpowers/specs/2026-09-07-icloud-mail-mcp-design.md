# iCloud Mail, Calendar & Reminders MCP Server — Design

## Purpose

A remote MCP server exposing iCloud Mail (IMAP), Calendar (CalDAV), and Reminders (CalDAV/VTODO) as tools Claude can call from Claude Cowork scheduled tasks. Replaces a paid third-party MCP service with a self-hosted equivalent on the user's own Vercel account and iCloud credentials.

The server is a **tool provider only** — no LLM calls, no classification or decision logic inside the server. All reasoning happens in Claude when a scheduled task invokes these tools.

Repo: [github.com/ireves/icloud-mcp](https://github.com/ireves/icloud-mcp)

## Architecture

```
Claude (Cowork scheduled task)
      │  HTTPS + Bearer token
      ▼
Vercel Function (Node.js runtime, /api/mcp)
      │  MCP SDK HTTP transport
      ▼
Tool router ── dispatches to:
      ├─ IMAP client (imapflow)   → imap.mail.me.com:993 (TLS)
      └─ CalDAV client (tsdav)    → caldav.icloud.com (service-discovery)
                                      ├─ VEVENT calendars
                                      └─ VTODO calendars (reminder lists)
```

- **Host:** Vercel, Node.js serverless runtime (not Edge) — required for native `net`/`tls` used by IMAP.
- **MCP transport:** HTTP via `@modelcontextprotocol/sdk`, single endpoint, added to Claude as a custom connector.
- **No database.** Every call goes live to iCloud; nothing is cached or persisted between invocations.
- **Single set of iCloud credentials** (`ICLOUD_EMAIL` + `ICLOUD_APP_PASSWORD`, an app-specific password) authenticates both IMAP and CalDAV — no separate calendar credential.

## Components

### `lib/imap.ts` — IMAP client wrapper
Thin wrapper around `imapflow`. Opens a connection per request (no persistent pool, since serverless functions are short-lived and stateless between invocations), authenticates with the app-specific password, and exposes functions matching the 6 mail tools. Always closes the connection in a `finally` block.

### `lib/caldav.ts` — CalDAV client wrapper
Wrapper around `tsdav`. Performs service discovery against `caldav.icloud.com` (principal URL lookup — never hardcode account-specific paths). Exposes functions for the 5 calendar tools and 5 reminder tools. Calendars and reminder lists are fetched through the same discovery call and distinguished by whether their components include `VEVENT` or `VTODO`.

### `lib/auth.ts` — Bearer token check
Compares the `Authorization: Bearer <token>` header against `MCP_AUTH_TOKEN` using constant-time comparison. Rejects (401) before any IMAP/CalDAV call is made if missing or wrong.

### `api/mcp.ts` — MCP HTTP handler
Vercel function wiring: auth check → MCP SDK server instance with all 16 tools registered → request handled. Node.js runtime explicitly set via Vercel config.

### Tools (16 total, per the brief)

**Mail (IMAP):** `list_folders`, `list_messages`, `get_message`, `mark_message`, `move_message`, `flag_message`
**Calendar (CalDAV):** `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`
**Reminders (CalDAV/VTODO):** `list_reminder_lists`, `list_reminders`, `get_reminder`, `create_reminder`, `complete_reminder`

Each tool's Zod input schema and description live next to its handler so the MCP SDK can derive the schema Claude sees. Descriptions are written for Claude as the reader — clear about what the tool does and its parameters — since tool selection depends on them.

Out of scope for v1 (enforced by simply not building them, not by a flag): sending mail, permanent delete/empty trash, calendar invitations/attendees, deleting events or reminders.

### `scripts/test-imap.ts`, `scripts/test-caldav.ts`
Standalone local scripts (run with `tsx`) that exercise the two wrappers directly against real iCloud credentials from `.env`, independent of the MCP layer and of each other. Used to isolate connection problems from tool-logic problems before wiring up `api/mcp.ts`.

## Data flow (example: `list_messages`)

1. Claude calls `list_messages` with `{ folder, limit, unread_only, since_date, from_address }`.
2. `api/mcp.ts` validates the bearer token.
3. Tool handler calls `lib/imap.ts`, which opens an IMAP connection, selects the folder, runs a search/fetch limited to headers (not full bodies), and closes the connection.
4. Handler maps the raw IMAP result to a small JSON structure (subject, from, date, unread, uid) and returns it as the tool result.

Calendar/reminder tools follow the same shape: open (or reuse discovery) → CalDAV request → map to plain JSON → return.

## Error handling

- IMAP/CalDAV errors are caught at the tool-handler level and returned as MCP tool errors with a human-readable message — never a raw stack trace, and never credential values.
- Auth failures (bad bearer token) return 401 before touching iCloud.
- iCloud-side auth failures (bad app-specific password) are surfaced clearly ("iCloud authentication failed — check ICLOUD_APP_PASSWORD") so it's not confused with the bearer-token check.
- Nothing is logged to Vercel's console that includes the app-specific password or bearer token.
- Per the brief: IMAP/CalDAV quirks, discovery surprises, or incomplete reminder data are reported back to the user as observations, not silently worked around.

## Testing

- `scripts/test-imap.ts` and `scripts/test-caldav.ts` for local, credential-based smoke tests of each protocol independently.
- After deploy, manual verification: add the Vercel URL as a Claude custom connector and invoke each of the 16 tools once before wiring any scheduled task.
- No automated unit/integration test suite for v1 — the brief's testing expectations are connection-level smoke tests plus manual tool verification, not a CI test suite.

## Deployment & config

- `.env.example` with `ICLOUD_EMAIL`, `ICLOUD_APP_PASSWORD`, `MCP_AUTH_TOKEN` placeholders — real values set in the Vercel dashboard, never committed.
- `vercel.json` (or function-level config) pins the Node.js runtime for `api/mcp.ts`.
- README covers: env vars, generating an iCloud app-specific password, adding the connector URL in Claude, and a short description of each tool.

## Open items the brief flags as "tell me, don't silently fix"

- IMAP folder-name or UID quirks on iCloud.
- Unexpected CalDAV discovery behavior, or reminder data that's incomplete due to the legacy VTODO model.
- If bearer-token auth turns out insufficient for how Claude custom connectors expect auth (e.g. OAuth becomes required) — flag before building a workaround.

These will be reported when encountered during implementation/testing rather than resolved unilaterally.
