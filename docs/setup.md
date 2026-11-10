# Setup and operation

How to run the server, configure it and connect the real Outlook and WhatsApp integrations. The offline demo in the README needs none of this.

## Running the server

```bash
npm run db:seed                 # migrate + synthetic data (idempotent)
npm start                       # http://127.0.0.1:3000
```

```bash
T=<your ADMIN_API_TOKEN>
curl -s localhost:3000/health
npm run trigger -- --list                                   # scheduled fictional appointments
npm run trigger -- 33333333-0000-4000-8000-000000000001 --remove-from-calendar
curl -s -XPOST localhost:3000/dev/simulate-inbound -H "authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"phone":"+447700900002","text":"Yes, please."}'
curl -s localhost:3000/dev/outbox -H "authorization: Bearer $T"
curl -s localhost:3000/workflows -H "authorization: Bearer $T"
```

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | public | DB status, provider names and the state of the calendar notifications: `off`, `active` or `degraded` (no PII) |
| `POST /webhooks/wa-akg` | WA-AKG HMAC (`X-Webhook-Signature`) | inbound WhatsApp messages |
| `POST /webhooks/graph` | `clientState` secret in each notification | Microsoft Graph change notifications for the clinic calendar (HTTP 404 unless configured) |
| `GET /appointments`, `GET /waitlist`, `GET /workflows`, `GET /workflows/:id` | admin bearer | masked views ("Sarah M."): no phones, JIDs or message bodies |
| `POST /workflows/:id/handoff-decision` | admin bearer | staff resolve a handoff: `{"decision":"offer_next"\|"close"}` |
| `POST /dev/trigger-cancellation`, `/dev/poll-cancellations`, `/dev/sweep`, `/dev/simulate-inbound`, `GET /dev/outbox`, `GET /dev/calendar` | admin bearer + `NODE_ENV` development/test | development tools (HTTP 404 in production) |

To run the standalone server against the real MCP without Microsoft: run `npm run fake-graph` in one terminal. It prints the `OUTLOOK_MCP_*` variables to export with `CALENDAR_PROVIDER=mcp`.

## Environment variables

All variables are listed with placeholders in [.env.example](../.env.example). The most important:

| Variable | Meaning |
|---|---|
| `DATABASE_URL`, `TEST_DATABASE_URL` | app DB, and the DB that tests/evals reset |
| `ADMIN_API_TOKEN` | bearer token for admin/dev endpoints (≥ 16 chars). The `.env.example` placeholder, like the one for `WA_AKG_WEBHOOK_SECRET`, is refused in production, on a non-loopback `HOST`, with `wa-akg` and with change notifications on |
| `CLINIC_TIMEZONE`, `CLINIC_CALENDAR_NAME`, `CLINIC_PHONE_DISPLAY` | clinic time zone (display + MCP wall clock), dedicated Outlook calendar, fictional phone shown to patients |
| `OFFER_TTL_MINUTES`, `MIN_LEAD_TIME_MINUTES`, `MAX_CLARIFICATION_TURNS` | offer policy |
| `OFFER_CASCADE_SIZE` (default 3), `OFFER_WIDEN_AFTER_MINUTES` (default 5) | offer cascade: how many patients can hold an offer for one slot, and how long before one more is added. `1` offers to one patient at a time; `0` minutes offers to all of them at once |
| `CANCELLATION_POLL_MS`, `CANCELLATION_CONFIRMATIONS`, `CANCELLATION_LOOKAHEAD_DAYS`, `SWEEP_INTERVAL_MS` | background loops |
| `OUTLOOK_MCP_NOTIFY_URL`, `OUTLOOK_MCP_NOTIFY_SECRET` | optional Graph change notifications: the public `https://<host>/webhooks/graph` URL of this app and a shared secret (16 to 128 characters). Read by both the MCP and this app |
| `CANCELLATION_FALLBACK_POLL_MS` (default 300000), `CALENDAR_NOTIFY_DEBOUNCE_MS` (default 2000) | polling interval while notifications are healthy, and the window in which several notifications share one calendar listing |
| `LLM_PROVIDER` (`mock`\|`openai`), `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PRICE_*_PER_1M` | LLM and cost estimation |
| `CALENDAR_PROVIDER` (`mock`\|`mcp`), `OUTLOOK_MCP_TRANSPORT`, `OUTLOOK_MCP_PATH`, `OUTLOOK_MCP_URL`, `OUTLOOK_MCP_CLIENT_ID`, ... | calendar via the existing MCP. Only `OUTLOOK_MCP_*` variables are forwarded to the child process |
| `MESSAGING_PROVIDER` (`mock`\|`wa-akg`), `WA_AKG_BASE_URL`, `WA_AKG_API_KEY`, `WA_AKG_SESSION_ID`, `WA_AKG_WEBHOOK_SECRET` | WhatsApp gateway |
| `WHATSAPP_ALLOWED_NUMBERS` | **required for `wa-akg`**: the only numbers that can ever receive a real message |
| `HUMAN_HANDOFF_WEBHOOK_URL` | optional staff notifier. Without it, patients are told to call the clinic, never "someone will contact you" |

## Connecting the real integrations

**Outlook (existing MCP).** Register an Entra app as described in the MCP README (delegated `Calendars.ReadWrite`, `MailboxSettings.Read`, `User.Read`, `offline_access`). Create a calendar named `CLINIC_CALENDAR_NAME` in Outlook. Then set `CALENDAR_PROVIDER=mcp`, `OUTLOOK_MCP_PATH=/abs/path/outlook-calendar-lite-mcp/src/main.ts` and `OUTLOOK_MCP_CLIENT_ID`, and log in once with the MCP's own `node src/main.ts login` (run it in the MCP folder with `OUTLOOK_MCP_CLIENT_ID` set; an app registered for a single organisation also needs `OUTLOOK_MCP_TENANT`). Finally run `npm run calendar:sync` to push the synthetic appointments. Events are created **without attendees**, so the MCP never needs invitation approval. If it ever asks for confirmation, the booking goes to a human. The app never replays the `cf` code.

Verified with a real personal Outlook.com account on 2026-11-10: login, listing, creating the 10 synthetic appointments, one booking end to end, and one patient cancellation over WhatsApp (the event was edited to `[CANCELLED]` and shown as free). A reschedule and work or school accounts were only run against the local fake Graph.

**Outlook change notifications (optional).** Without them the app polls the calendar every `CANCELLATION_POLL_MS`. With them, Microsoft Graph tells the app within seconds that an event changed:

1. Expose the app on a stable public HTTPS address (a named tunnel or a real host; a quick tunnel's address changes on every start). The same address serves the WA-AKG webhook.
2. Set `OUTLOOK_MCP_NOTIFY_URL=https://<host>/webhooks/graph` and `OUTLOOK_MCP_NOTIFY_SECRET=<random string>`. With the stdio transport both reach the MCP automatically; with a remote MCP, set the same two variables on that server.
3. Start the app. It asks the MCP (`ntf acao=ligar`) to create the subscription, Graph validates the URL, and `GET /health` shows `calendarNotifications: "active"`. The app renews the subscription one day before it expires.

How a notification is used:

- It is only a trigger. The app lists the calendar at once and decides from the listing, with every existing safety rule.
- A missing event that Graph also reported as deleted is confirmed by that first listing, instead of waiting for `CANCELLATION_CONFIRMATIONS` polls.
- Notifications without the right `clientState` are rejected and change nothing.
- If the subscription cannot be created or renewed (`calendarNotifications: "degraded"`), polling continues at its normal rate. While it is healthy, polling drops to `CANCELLATION_FALLBACK_POLL_MS` as a safety net.

Verified with a real personal Outlook.com account on 2026-11-10: the subscription was created (Graph validated the URL through a tunnel) and renewed, extended to 3 days (the most the MCP asks for), and a "deleted" notification carried the stored event id. From that notification to the WhatsApp offer took about 7 seconds (2 s debounce, 4 s calendar listing, 1 s send). Lifecycle notifications and a renewal after more than a day were only run against the fake Graph.

**WA-AKG.** Run the gateway, connect a test WhatsApp session, create an API key and set `MESSAGING_PROVIDER=wa-akg`, `WA_AKG_*` and `WHATSAPP_ALLOWED_NUMBERS=+<your test number>`. Point one fictional patient at your test number, for example `UPDATE patients SET phone_number='+<n>', whatsapp_jid='<n>@s.whatsapp.net' WHERE id='22222222-0000-4000-8000-000000000002'`. Then create a WA-AKG webhook for `message.received` with a `secret` equal to `WA_AKG_WEBHOOK_SECRET`. WA-AKG only delivers to **HTTPS URLs that resolve to public IPs**, so expose `POST /webhooks/wa-akg` through a tunnel (for example `cloudflared tunnel --url http://localhost:3000`). Whenever the tunnel address changes, update the webhook URL in WA-AKG and `OUTLOOK_MCP_NOTIFY_URL`, or replies and notifications go to the old address. Verified live with a real WhatsApp test number.

## Before exposing the app

A tunnel publishes every route of the app, not only the webhooks. The admin and dev routes stay behind the bearer token and `/health` is public, so:

- use long random values for `ADMIN_API_TOKEN`, `WA_AKG_WEBHOOK_SECRET` and `OUTLOOK_MCP_NOTIFY_SECRET` (`openssl rand -hex 32`). The app refuses to start with the `.env.example` placeholders once it is reachable;
- set `NODE_ENV=production` outside development, which removes the `/dev/*` routes;
- where the tunnel or proxy allows it, forward only `/webhooks/*`. The app has no rate limiting of its own;
- keep PostgreSQL private. Docker Compose publishes it on `127.0.0.1` only, with a development password.
