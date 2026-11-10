# Architecture notes

## Components

| Module | Responsibility |
|---|---|
| `integrations/outlook-mcp/mcp-client.ts` | Minimal MCP client (JSON-RPC 2.0, stdio + Streamable HTTP). Discovers tools with `tools/list`. Does **not** advertise `elicitation`, so the server's own confirmation flow (preview + `cf` code) applies, and the app never completes it. |
| `integrations/outlook-mcp/outlook-mcp-calendar.ts` | `CalendarPort` over the MCP tools `ls`, `cr`, `ed` and `ntf` on the dedicated clinic calendar. Parses the MCP's tabular output, infers the year, detects `[cancelado]` and `+mais` (truncated results), and classifies errors as auth, transient or protocol. |
| `integrations/outlook-mcp/fake-graph.ts` | Development fake of the Graph calendar and subscription endpoints, so the **real** MCP can run with no Microsoft account. It validates the notification URL and sends "deleted" notifications like Graph does. It uses the MCP's own `OUTLOOK_MCP_GRAPH`/`OUTLOOK_MCP_AUTH` variables and a pre-provisioned token file. |
| `integrations/wa-akg/*` | REST client (`POST /api/messages/{session}/{jid}/send`, `X-API-Key`), webhook HMAC verification and parsing (`message.received`, ignores `fromMe`, groups and non-text), an allow-list guard and a mock gateway. |
| `integrations/outlook-mcp/instrumented-calendar.ts`, `mock-calendar.ts` | A decorator that logs and counts every calendar call, and the in-memory calendar used by tests, evals and `CALENDAR_PROVIDER=mock`. |
| `integrations/wa-akg/safe-messaging.ts` | Wraps any messaging provider: a real gateway can only reach the numbers in `WHATSAPP_ALLOWED_NUMBERS`. |
| `agents/interpreter.ts`, `guardrails.ts` | Offer-reply pipeline: deterministic pre-classifier (clinical words, request for a person), then the model, then policy (a suspicious or low-confidence "accept" becomes "ambiguous"), then a validated reply or a template. |
| `agents/openai-llm.ts`, `rule-based-llm.ts` | The two `LlmPort` implementations: OpenAI with a strict JSON schema, and the deterministic interpreter used by tests and evals. |
| `agents/jev/*` | TypeSafe Jev client, the offer-reply interpreter (Jev decides when its confidence clears the threshold, otherwise the LLM) and the confirmation gate for patient-initiated changes. Jev returns typed choices, never text. |
| `agents/tool-agent.ts` | The patient assistant: a LangGraph `agent ↔ tools` loop over OpenAI function calling, with 7 tools that enforce the rules themselves. |
| `services/waitlist-matching.ts`, `offer-service.ts` | Eligibility (R1 to R11) and priority (P1 to P3); offer lifecycle and its conversation. |
| `services/messaging-service.ts` | Outbound messages with an idempotency key each, so a retry or a re-run never sends the same message twice. |
| `services/patient-request-service.ts`, `availability.ts` | Patient-initiated cancel and reschedule as a durable state machine (`patient_requests`); bookable times from the live calendar, opening hours and lead time. |
| `services/handoff-service.ts` | Opens a human handoff and reports whether the staff notifier really succeeded. |
| `services/booking-service.ts` | Durable booking state machine with reconciliation. |
| `services/inbound-service.ts` | Durable webhook ingestion (dedupe), then routing to the patient's conversation and workflow thread. |
| `services/cancellation-detector.ts` | Reconciliation of DB appointments against a calendar listing, on a timer and whenever a change notification arrives. |
| `services/calendar-notifications.ts` | Microsoft Graph change notifications: asks the MCP (`ntf`) to create and renew the subscription, checks the `clientState` of what arrives at `/webhooks/graph`, and triggers the detector. A notification never cancels anything by itself. |
| `services/sweeper.ts` | Expiry, booking reconciliation, pending webhooks, stuck runs, failed confirmations. |
| `workflows/recovery-graph.ts` | LangGraph state machine (nodes listed below). |
| `workflows/runner.ts` | Starts and resumes threads. Serialises executions per thread (in-process chain + DB lease with expiry). |
| `api/server.ts`, `config/env.ts`, `app.ts` | HTTP routes; typed, validated configuration; the composition root where every external dependency can be replaced by a double. |

## Recovery graph nodes

The diagram in the README groups these into eight steps. The real LangGraph nodes and transitions are:

| From | To | When |
|---|---|---|
| `cancellation_detected` | `waitlist_search` | always |
| `waitlist_search` | `candidate_selected` | the cascade has a free place and an eligible patient exists |
| | `awaiting_patient_response` | the cascade is full, the next widening is not due, or nobody else is eligible but offers are open |
| | `awaiting_human` / `workflow_exhausted` | a handoff is open and no offers are / nobody is eligible and no offers are open |
| `candidate_selected` → `offer_created` → `message_sent` | `waitlist_search` | offer delivered; the search decides whether to contact one more patient now |
| `offer_created` | `waitlist_search` | the offer could not be created (for example the patient already has another live offer) |
| `message_sent` | `waitlist_search` | delivery failed |
| `awaiting_patient_response` | `patient_response_interpretation` / `offer_expired` | patient message (resume) / expiry sweeper, for the open offer the event names |
| | `waitlist_search` | widening is due (sweeper) |
| | `handoff_resolved` | staff decision while other offers are still open |
| `patient_response_interpretation` | `availability_verification` | accept |
| | `clarification_sent` → `awaiting_patient_response` | question, ambiguous, other day |
| | `offer_declined` → `waitlist_search` | decline, already booked, opt-out |
| | `human_handoff` → `waitlist_search` | clinical concern, asks for a person, too many turns. Only this patient's offer ends |
| | `offer_expired` → `waitlist_search` | deadline passed |
| `availability_verification` | `booking` / `slot_unavailable` | slot reserved (every other open offer is superseded and those patients are told) / taken. If the calendar cannot be read, the booking still starts and its own checks decide |
| | `offer_expired` / `waitlist_search` | the offer expired before it could be reserved / it was no longer valid for another reason |
| `booking` | `confirmation` | event verified in the calendar |
| | `awaiting_booking_reconciliation` → `booking` | unknown outcome; the reconciler retries |
| | `slot_unavailable` / `human_handoff` / `workflow_failed` | slot taken / MCP asks for approval / retries exhausted |
| `awaiting_human` | `handoff_resolved` → `waitlist_search` or end | staff decision |
| `confirmation` | end / `workflow_failed` | confirmation sent / no confirmed booking found (never tell the patient) |
| `slot_unavailable`, `workflow_failed`, `workflow_exhausted` | end | the patient with the reserved slot is told when it was taken or failed |

`awaiting_*` nodes call `interrupt()`: the state is checkpointed and the run ends until a webhook, the sweeper or a staff action resumes it.

**Offer cascade.** The graph state keeps `live`, the list of open offers for the slot. A resume event names its offer, and `awaiting_patient_response` loads that offer into the "current offer" fields the other nodes work on. The slot is still one thread, so events are handled one at a time: two "yes" replies cannot both reserve it. The next widening time is stored in `recovery_workflows.widen_at`, and the sweeper resumes the thread with a `widen` event when it is due.

## Inbound routing and the patient assistant

Every WhatsApp message is stored once (`inbound_events`), then processed in the background:

- An unknown number is never answered.
- A reply while the patient has a live offer resumes that slot's recovery workflow.
- Anything else is a patient-initiated conversation. With `LLM_PROVIDER=openai` it goes to the function-calling agent; with the mock provider, to the deterministic flow in `patient-request-service.ts`.

The agent is a second LangGraph graph with two nodes, `agent` (one model call) and `tools`, looping until the model answers without a tool call. Its 7 tools are `get_my_appointments`, `check_availability`, `propose_reschedule`, `propose_cancellation`, `confirm_pending_change`, `discard_pending_change` and `handoff_to_human`. The model chooses the tool and the wording; the tools decide what is allowed:

- a change is only proposed for the patient's own future appointment, at a time that is free in the live calendar;
- `confirm_pending_change` runs only for a proposal made in an earlier message and a clearly affirmative reply (Jev when configured, rules otherwise);
- the final text may not claim a change that the confirm tool did not complete in that run.

A confirmed change runs the `patient_requests` state machine. A reschedule creates the new event first; then, as in a cancellation, the old event is edited to `[CANCELLED]` and shown as free (it is never deleted). The freed slot starts a recovery workflow.

## Cancellation detection and change notifications

Every conclusion about a cancellation comes from a calendar listing (`ls`). Two things can cause a listing:

- **The timer.** Every `CANCELLATION_POLL_MS`, or every `CANCELLATION_FALLBACK_POLL_MS` while the Graph subscription is healthy.
- **A change notification.** Optional; on when `OUTLOOK_MCP_NOTIFY_URL` and `OUTLOOK_MCP_NOTIFY_SECRET` are set.

How the notification path works:

1. At start, and again one day before expiry, the app calls the MCP tool `ntf acao=ligar`. The MCP creates or extends the Graph subscription for the clinic calendar (`updated,deleted`, 2 days). Graph validates the URL by calling `POST /webhooks/graph?validationToken=…`, which the app echoes as plain text.
2. Graph posts notifications to `/webhooks/graph`. Items without the shared secret as `clientState` are dropped. The app answers `202` at once.
3. A `deleted` item leaves a hint for that event id in the detector (kept for 10 minutes). Any accepted item schedules one listing after `CALENDAR_NOTIFY_DEBOUNCE_MS`, so a burst shares it.
4. The detector applies its usual rules to the listing. The only difference: an event that is missing **and** has a hint is confirmed at once, without waiting for `CANCELLATION_CONFIRMATIONS` listings.
5. Lifecycle notifications: `reauthorizationRequired` and `subscriptionRemoved` renew or recreate the subscription; `missed` causes a listing.

If the subscription cannot be created or renewed, the app retries with a back-off (1 to 15 minutes) and the timer keeps its normal rate. The subscription state and the hints are in memory: after a restart the app renews the subscription and relies on the timer for anything it missed. The cancellation is recorded with `source = 'calendar_poll'` and `details.deletedNotification = true` when a notification sped it up; there is no schema change.

## Data model highlights

- Business tables live in `public`. LangGraph checkpoints live in the separate schema `langgraph`, created by `PostgresSaver.setup()`.
- Checkpoints hold ids, patients' first names, the slot snapshot, counters, and the event being processed: for a patient reply that includes the message text and the drafted answer. Phone numbers are never in a checkpoint.
- Added tables beyond the brief: `cancellation_events` (one per appointment), `recovery_workflows` (one per cancelled appointment, also the LangGraph thread id), `inbound_events` (dedupe and durable processing), `bookings` (state machine), `human_handoffs`, `patient_requests` (patient-initiated changes), `schema_migrations`.
- Added columns: `appointments.calendar_ref` (stable `AAR-xxxxxxxx` correlation token), `calendar_missing_count`, `last_calendar_check_at`, `source`; `recovery_workflows.widen_at` (offer cascade); `messages.idempotency_key`, `delivery_status`, `attempts`, `offer_id`; `appointment_offers.workflow_id`.

## Event identity: Graph ids plus `calendar_ref`

`outlook-calendar-lite-mcp` returns the **permanent Microsoft Graph id** of every event. It requests immutable ids (`Prefer: IdType="ImmutableId"`), so the id survives edits and moves between calendars. `ls` shows the id in its `id` column, `cr` returns it as `criado:<id>|…`, and `ed` accepts it as the target. The app stores it in `appointments.outlook_event_id` and `bookings.outlook_event_id`, and:

- edits an event directly by its id, with no listing first;
- matches events in the cancellation detector and the availability check by id as well as by ref, so a staff member who edits the title and removes the `AAR-` code no longer breaks the link.

The `AAR-xxxxxxxx` token in the title (`calendar_ref`) stays as a second key. A booking writes it before the event exists, so a retry first looks for its own token and never creates a duplicate; the Graph id only exists after creation. The token is also the fallback when a stored id is unknown to Graph.

## Observability

Structured JSON logs (`src/shared/logger.ts`) with `workflowId`, `conversationId`, `correlationId`, `state`, `durationMs`, MCP calls (`mcp.call`), WhatsApp calls (`whatsapp.send`), LLM calls (`llm.call` with tokens and cost), retries (`booking.needs_reconciliation`), calendar notifications (`calendar.notification`, `calendar.subscription_ready`, `calendar.subscription_failed`) and errors. Keys that look like secrets are redacted. Phone numbers are masked to their last 4 digits, and message text and names are replaced by their length. Every webhook gets a correlation id that is carried into the graph resume and every log line and outbound message it causes. The `workflow_events` table is the durable audit trail.

## Security

- Admin endpoints use a bearer token (constant-time compare). Dev endpoints return 404 outside development/test.
- The app binds to `127.0.0.1` by default. The `.env.example` placeholders for the admin token and the webhook secret are refused in production, on a non-loopback host, with the real WhatsApp gateway and with change notifications on.
- Docker Compose publishes PostgreSQL on `127.0.0.1` only. All SQL uses bound parameters.
- There is no rate limiting: see [Before exposing the app](setup.md#before-exposing-the-app).
- WA-AKG webhooks require HMAC-SHA256 over the raw body (`X-Webhook-Signature`) and must match the configured session id.
- Graph notifications must carry the shared secret as `clientState` (constant-time compare). The receiving URL and the secret are server configuration of the MCP, not tool arguments, so a model cannot redirect them. A valid notification only triggers a calendar listing.
- Real messaging is limited to `WHATSAPP_ALLOWED_NUMBERS`. Configuration refuses `wa-akg` without an allow-list.
- The MCP child process gets a minimal environment (PATH, HOME, `OUTLOOK_MCP_*` only), so OpenAI and WA-AKG secrets never leak to it.
- API responses are masked: "Sarah M.", no phone numbers, JIDs or message bodies.

## Reliability design

| Risk | Protection |
|---|---|
| Duplicate webhooks | `inbound_events UNIQUE(provider, external_message_id)`, so the HTTP handler persists once and later deliveries return `duplicate` |
| Duplicate / concurrent "yes" | per-thread serialisation (in-process chain + DB lease), idempotent `reserve()` (`bookings.offer_id UNIQUE`), compare-and-set booking claim |
| Two patients, one slot | several patients can hold an offer (offer cascade), but only one booking per slot can exist (partial unique index). Events for one slot run one at a time, and the first acceptance to reserve the slot ends the other offers |
| Outlook failure / timeout | booking FSM `reserved → calendar_pending → calendar_created → confirmed`. Unknown outcomes go to `needs_reconciliation` with backoff, and every retry **looks for the booking's `AAR-xxxxxxxx` ref before creating**, so there are no duplicate events. Once created, the event's permanent Graph id is stored and used for later edits and checks |
| DB failure after the calendar write | the booking stays `calendar_created`, and the reconciler finalises it idempotently (`appointments.calendar_ref UNIQUE`) |
| Restarts | LangGraph checkpoints in PostgreSQL (schema `langgraph`). The sweeper re-processes pending webhooks, stuck runs, due bookings and failed confirmations |
| Late replies | the deadline is checked against the clock at three points: inbound routing, the interpretation gate and `reserve()` |
| False confirmations | the confirmation is sent only from the `confirmation` node, which re-checks `bookings.status = 'confirmed'`, and only after the event is seen in a fresh calendar listing |
| False cancellations | any listing error, truncated listing or mass disappearance means no conclusion. A missing event needs N consecutive misses, or one miss plus a Graph "deleted" notification for that event |
| Forged or lost Graph notifications | each notification must carry the shared secret (constant-time compare), and none is trusted on its own: it only triggers a calendar listing. Polling continues as a safety net and returns to its normal rate when the subscription is not healthy |
| Prompt injection | the message is treated as untrusted data, output is schema-validated, an "accept" from a suspicious message is downgraded, and booking decisions are deterministic anyway |
| Locks on external calls | none. Only short local transactions. Calendar calls happen between them |

## Project layout

```
src/
  agents/          prompts, guardrails, interpreter, OpenAI + rule-based LLM adapters, function-calling agent
    jev/           TypeSafe Jev client, offer-reply interpreter, confirmation gate
  api/             Fastify server (WA-AKG and Graph webhooks, admin, dev endpoints)
  config/          typed env loading + validation
  database/        pool, migration runner, seed loader
  integrations/
    outlook-mcp/   MCP client (stdio/HTTP), Outlook adapter + parsers, mock calendar, fake Graph
    wa-akg/        REST client, webhook verify/parse, allow-list guard, mock gateway
  services/        matching, offers, booking FSM, messaging, inbound, detector, calendar notifications, sweeper, handoff
  workflows/       LangGraph state, graph, runner (leases, resume)
  shared/          logger (redaction), errors, validation, time zones, ids, task tracker
migrations/  seeds/  tests/  docs/
evals/         Promptfoo scenarios, benchmark datasets (bench/), simulated-patient scenarios (sim/)
scripts/       demo, seed, sync, bench + bench-report, sim-eval, fill-sim, agent-replay, draw-diagrams
```
