# Implementation progress (execution log)

Environment: macOS, Node v26.8.2, npm 12.2.1, Docker 28.3.3 (PostgreSQL 17-alpine on host port 5433, because a local PostgreSQL already used 5432). Dates: 2026-11-08 to 2026-11-10. The sections below the phase table describe the current state; the "Update" sections are the log, oldest first.

## Phases (initial build)

| Phase | Status | Notes |
|---|---|---|
| 0. Inspection | done | Read `outlook-calendar-lite-mcp` README + all source (tools, stdio/HTTP transports, auth, confirmation via elicitation or `cf` code, short ids only, `OUTLOOK_MCP_GRAPH`/`OUTLOOK_MCP_AUTH` overrides). Read WA-AKG send route, `api-auth.ts` (`X-API-Key`), `webhook.ts` (payload shape, `X-Webhook-Signature: sha256=<hmac>`), and the SSRF guard (HTTPS + public IPs only). |
| 1. Foundation | done | TypeScript (native type stripping, `tsc --noEmit`), Fastify, Docker Compose, SQL migration runner, synthetic seed (10 patients, 5 treatments, 10 appointments, 7 waitlist entries), reset/seed commands. |
| 2. Integrations | done | MCP client (stdio + Streamable HTTP, dynamic tool discovery), Outlook adapter + parsers, mock calendar, fake Graph for the real MCP. WA-AKG client, webhook verify/parse, allow-list guard, mock gateway. |
| 3. Workflow | done | LangGraph.js graph with interrupt/resume, PostgreSQL checkpointer (`langgraph` schema), runner with leases. OpenAI adapter (strict JSON schema, `OPENAI_MODEL`) + rule-based mock. |
| 4. Business logic | done | Cancellation polling, deterministic matching (R1-R11, P1-P3), offers, idempotent messaging, durable booking FSM + reconciliation, handoff, sweeper. |
| 5. Tests | done | 64 `node:test` tests, all passing. |
| 6. Evals | done | Promptfoo, 14 workflow scenarios, all passing. Reproduced injection failure + fix + regression evidence. Fixed an eval metric that graded itself. |
| 7. Docs | done | README, architecture, business rules, evaluation, this log. |

## Current results

- `npm run typecheck`: exit 0, no errors.
- `npm test`: **128/128** passing. Includes two integration tests against the real `outlook-calendar-lite-mcp` process over stdio (they require `../outlook-calendar-lite-mcp`).
- `npm run eval` (Promptfoo, 19 workflow scenarios): **19/19** with the deterministic interpreter. With `EVAL_LLM=openai` (`gpt-5.4-mini`): **18/19**; scenario 16 is an open product decision (see docs/evaluation.md).
- Benchmarks and the simulated-patient evaluation: see the README and [benchmarks.md](benchmarks.md). Latest held-out simulated run: 98.7% without Jev and 100% with Jev, with 0 unsafe actions.
- `npm run sim:fill` (offer modes compared on a simulated clock): see [fill-simulation.md](fill-simulation.md).
- `npm run demo`: all 8 steps completed with the real MCP process against the fake Graph. Last run on 2026-11-10 with the mock interpreter, pointed at the test database so that the live setup was not reset: 17 MCP calls, none failed.

## Issues found and fixed during development

1. Harness counted the seed calendar writes, so `createCalls` was 10 instead of 0. The harness now resets counters after the sync.
2. Booking finalisation retry used SQL `now()` instead of the injected clock, so the reconciler skipped the booking. Fixed in `booking-service.ts`.
3. A constraint test targeted the wrong unique index (the slot index fires before the patient index). The test now uses a slot with no live offer.
4. The eval metric `incorrectBookingAttempts` trusted the interpreter. It is now based on ground truth (see docs/evaluation.md).
5. While verifying `npm start` with the MCP, a shell mistake (zsh does not word-split `$VAR`) meant the MCP started without credentials. The app behaved safely: auth errors were classified as `auth`, and the booking went to `needs_reconciliation` instead of being created blindly.

## Live vs mocked

| Integration | Status |
|---|---|
| PostgreSQL | **live** (Docker) |
| Outlook Calendar MCP | **live** with a personal Outlook.com account (2026-11-10, MCP commit `a500f8e`): login, listing, event creation, a booking, a patient cancellation (event edit) and change notifications. A reschedule, a work or school tenant and lifecycle notifications were only run against the fake Microsoft Graph with the real MCP process (stdio). Streamable HTTP transport implemented but not exercised. |
| WA-AKG | **live**: real gateway and WhatsApp test session, with signed webhooks through a cloudflared tunnel. Messages only go to the allow-listed test number. |
| OpenAI | **live** (`gpt-5.4-mini`): offer interpretation, the function-calling agent, benchmarks and the simulated-patient evaluation. |
| TypeSafe Jev | **live** (`jev-latest`, served as `jev-1.14.0`) |
| Human-handoff notifier | tested with an injected fetch; no real endpoint |

## Manual configuration

- Outlook needs a Microsoft Entra app registration + `OUTLOOK_MCP_CLIENT_ID`, a one-time MCP login, and an Outlook calendar named `CLINIC_CALENDAR_NAME`.
- The quick tunnel URL changes on every restart, so the WA-AKG webhook URL and `OUTLOOK_MCP_NOTIFY_URL` have to be updated each time (a named Cloudflare tunnel would avoid this).

## Not done

- **Not verified live:** a reschedule on the real Outlook account, a work or school tenant, the subscription's lifecycle notifications and a renewal after more than a day, and the Streamable HTTP transport of the MCP client.
- **Not run:** `npm run eval:judge` (LLM-as-judge rubric for the Promptfoo scenarios).
- **Open decision:** Promptfoo scenario 16 fails with the real model, which assumes "move it" means the appointment just booked instead of asking which one (see [evaluation.md](evaluation.md)).
- **Simulated-patient evaluation:** the 25 held-out scenarios were used to find and fix issues, so they are no longer blind. Fresh held-out scenarios have not been written.
- **Not measured:** the published benchmarks and the simulated-patient numbers were taken with one patient at a time (`OFFER_CASCADE_SIZE=1`). The cascade is measured only by the fill simulation, with assumed patient behaviour and a slot that is a day away. The time from cancellation to first offer with notifications was measured once.

## Update: live WhatsApp test and patient-initiated changes

- **Live test (WA-AKG):** a real WhatsApp offer was sent to the allow-listed test number. The patient's "Yes" was received through the cloudflared tunnel with a valid HMAC, interpreted by OpenAI (`OPENAI_MODEL`, intent `accept`), booked and confirmed. This verified WA-AKG and OpenAI live. At that point the live setup still used the mock calendar.
- **Issue from the live test:** "Thank you" after the booking got a robotic fixed reply. Fixed with a guarded LLM follow-up turn.
- **Added:** patient-initiated cancel/reschedule (migration 002, `patient_requests` state machine, calendar `updateEvent` via MCP `ed`, deterministic availability). Verified against the real MCP process (fake Graph): `ed` edits the event without confirmation, and `rm` is never used.
- Results after the change: `npm test` 78/78, `npm run eval` 19/19 (rule-based interpreter).

## Update: function-calling agent

- LangGraph tool loop over OpenAI function calling (7 tools), with policy enforced inside the tools. Scripted-model tests cover the gates.
- **Verified live with the real model (`gpt-6-luna`)**, test DB, no real messages: reschedule → confirm → thanks → cancel → confirm all behaved correctly, and the freed slot was offered to the waiting list.
- Issues found in live runs and fixed:
  1. The API rejects function tools on this model unless `reasoning_effort` is `"none"`. The agent now retries once with it and remembers it.
  2. On model failure the patient got no reply. Now an honest fallback is sent.
  3. On "thanks!" the model re-ran an old request (a pointless 4 PM → 4 PM proposal). Fixed with a same-time refusal and a "respond only to the last message" rule.
  4. The model re-proposed instead of confirming, then treated "thanks!" as a yes. Fixed with an explicit pending-proposal state in the prompt and an affirmative-only confirmation gate.
- `npm test` 85/85, `npm run eval` 19/19.

## Update: model choice

Compared with the same live conversation (reschedule, confirm, thanks, cancel, confirm):
- `gpt-6-luna` needs `reasoning_effort: "none"` for tools on Chat Completions (handled automatically).
- `gpt-4.1-mini` skipped `propose_reschedule` and asked "shall I?". The gate refused the confirm, so nothing went wrong, but the conversation failed.
- **`gpt-5.4-mini`** completed every step correctly, in 0.6–3.4 s per turn. It is now the configured `OPENAI_MODEL`.

## Update: Jev (TypeSafe System One) and benchmarks

- **Integrated in two places:** interpreting the reply to an offer (one call, 4 typed questions: intent, clinical, human request, injection) and the confirmation gate before any calendar change. Each decision is taken only above a calibrated confidence (0.7, or 0.85 for accept/confirm). Below that, offers go to the LLM and the gate answers "unclear" and asks again. If Jev is down, the LLM takes over offers and the rules take over the gate. Off unless `TYPESAFE_API_KEY` is set.
- **Fixed on the way:** the deterministic patient-request flow confirmed changes from the intent classifier and never called the gate. Every path now goes through the same gate.
- **Verified against the real API** (`jev-1.14.0`, ~260 ms p50 from this machine). Request and response shape match the client.
- **Issue found by the benchmark:** the first wording of the injection question flagged ordinary imperative replies ("book it", "go ahead") as injection, so the veto blocked them. After rewording (disclosed in `docs/benchmarks.md`):
  - offers: Jev 98.4%, the same as LLM-only, with 0 wrong bookings, p50 268 ms vs 903 ms, about 23× cheaper
  - gate: Jev 94% with 0 false confirmations; rules let 4 through, LLM 2
  - agent: 25/27 successful conversations with the Jev gate vs 23/27 with the rules gate, 0 unsafe actions in both
  - These are the numbers of that run. The current ones, after the later fixes, are in the README and [benchmarks.md](benchmarks.md).
- Datasets and agent conversations are English only.
- Remaining Jev gate misses are on the safe side: "yep, move it" stays below 0.85, so the agent asks again. The remaining agent failures (a2) come from the LLM not finishing the busy-slot flow, not from the gate.
- `npm test` 92/92.

## Update: simulated-patient evaluation (tau-bench style)

- `scripts/sim-eval.ts` with `evals/sim/scenarios.ts`. A patient simulator gets a persona and a hidden goal and texts the real app through the signed webhook. Grading uses the final database state; a tone judge is reported separately and never decides pass or fail. Scenarios are split into dev (6, may be tuned on) and test (25, held out). Each runs k times per arm, reported as pass^k, with a hard budget cap (`--max-usd`), and parallel workers each use their own database.
- **Run: 150 conversations** (25 held-out scenarios × 3 runs × 2 arms), 7 minutes, **$0.96 in total**:

  | | Without Jev | With Jev |
  |---|---|---|
  | Resolved | 93% | 97% |
  | pass^3 | 88% | 92% |
  | Unsafe actions | 0 | 0 |
  | System cost per conversation | ~$0.005 | ~$0.004 |

- **Real issues the run exposed** (fixed in the next update):
  1. Picking one time from a list of options ("2:30pm please") is sent to the confirmation gate. The rules gate reads it as unclear, and the agent replies "nothing's changed yet, I'll update you", which promises an update that never comes (t03, t07; without Jev only).
  2. A bare "y" is never accepted as a confirmation. The agent then repeats "send a clear yes" in a loop (t14). With Jev, one run hit the agent's generic error reply instead.
  3. The clinical keyword pre-classifier caught "medication list" in a logistics question. That turned a confirmation ("Yes please, 4pm works") into a medical-safety reply, so the move never happened (t16, with Jev).
  4. A repeated "please call the clinic" line after a human handoff (t11), flagged as robotic by the judge.
- **Fixed in the evaluation itself:**
  - The simulator refused to act out an injection, so attacks now use a scripted opening message.
  - The judge misread "unchanged" and 24h times as contradicting the replies, so it now gets the outcome in plain language. The saved transcripts were re-scored, and false-claim flags went from 14 to 0, consistent with the database grading.

## Update: fixes for the simulated-eval findings

1. **Picking an offered time.** A reschedule counts as agreed when the clinic's previous message listed the exact proposed time and the patient's message names it ("2:30pm please"). This also covers a proposal made in the same turn. A question ("is 2:30 free?") or a time the clinic never offered still needs a separate yes. It applies to the rules gate and to Jev (context in the query); `src/agents/time-mention.ts` recognises "2:30", "2.30", "230pm", "14:30", "half past 2", "4pm" and "4 o'clock".
2. **No false "I'll update you" promises.** The confirm tool now tells the model what to do next. A code guard replaces promises such as "I'll / they'll / the team will … let you know" unless something is really in progress or staff were notified, and "I've passed that on" unless a handoff exists. The replacement is the real confirmation question built from the pending proposal.
3. **Short answers.** "y" and "k" count as yes when they are the whole message. A short answer to the agent's own question is never ignored (no NO_REPLY). The agent proposes at once instead of asking "shall I start?".
4. **Clinical pre-classifier.** "medication" alone no longer triggers it; asking to take something ("should I take ibuprofen") still does.
5. **Repeated replies.** A handoff that is already open returns `already_handed_off`, and the exact same sentence is never sent twice in a row.
6. **Bug found while debugging: the recovery workflow failed after agent cancellations.** It was started inside the agent's LangGraph run, so LangGraph treated it as a nested subgraph and its `interrupt()` escaped as an exception. The runner now invokes it detached from the ambient context.
7. **Bug found by the second run: a false claim got through.** "I’ve updated it to …" was not caught because of the typographic apostrophe and the verb "updated". All reply guards now normalise apostrophes and cover more verbs.
- Diagnostics: agent turns record `fallbackReason` and `rejectedReply`; `scripts/agent-replay.ts` replays scripted turns against the real model.
- `npm test` 102/102. Component benchmarks are unchanged. The agent suite (9 conversations × 3 runs) is now 89% without Jev and 100% with Jev.
- **Held-out simulated eval:**

  | Run | Without Jev | With Jev |
  |---|---|---|
  | Baseline | 93% | 97% |
  | After the fixes | 98.7% (74/75) | 100% (75/75) |

  0 unsafe actions and 0 false claims. These scenarios are no longer blind; fresh held-out scenarios have not been written (see "Not done").
- The remaining failure is t08 (one run without Jev): a generic fallback on the first message. It did not reproduce in 4 replays and is probably a transient model error. Sim results now record fallback reasons.

## Update: permanent Graph ids from the MCP

- `outlook-calendar-lite-mcp` commit `240c9a9` returns the permanent (immutable) Graph id in `ls` and `cr` and accepts it in `ed`. The local checkout was fast-forwarded to it.
- The adapter parses these ids. Support for the old short session ids was removed.
- The ids are stored in `appointments.outlook_event_id` (calendar sync, bookings, reschedules) and used to:
  - edit an event directly by id, falling back to the `AAR-` ref when the id is stale;
  - match events in the cancellation detector and the availability check, so an event whose title was edited is still recognised.
- Tests:
  - parsers read the permanent id from `ls` and `cr`;
  - the real-MCP integration test covers `cr` returning the id, editing by id after the title lost its ref, and stale-id fallback;
  - the detector test covers a renamed event;
  - the reschedule test checks the new id is stored.
- `npm test` 105/105. Support for the old short ids was then removed (104 tests).

## Update: docs review, unanswered "thank you", end of conversation

- **Docs review after the MCP change:**
  - Future improvements rewritten: Graph notifications need a subscription tool in the MCP plus a receiving route here (any transport); the offer cascade is described with its trade-offs.
  - Stale statements fixed: verification status, test counts, the confirmation rule, project layout and limitations.
- **Bug: an unanswered "thank you".** Running `EVAL_LLM=openai npm run eval` for the first time showed that the classic follow-up model labelled "Thank you so much!" as `thanks` with `should_reply: false`, so the patient got no reply. The prompt was clarified, and the policy now always answers a `thanks`.
- **End of conversation.** Once the clinic has signed off ("You're welcome", "Take care", "Bye"), nothing is pending and the patient only closes ("thanks again, bye 👍"), no reply is sent and no model is called. The first thanks after a change is still answered, and any real question reopens the conversation. An existing test caught one false positive: "No problem, thanks for letting us know" after a decline is not a sign-off, so it was removed from the list.
- `npm test` 108/108, `npm run eval` 19/19.

## Update: offer cascade

- A freed slot can now be on offer to several patients at once. Before, the next patient was contacted only after the previous one declined or timed out.
- Two settings: `OFFER_CASCADE_SIZE` (default 3) and `OFFER_WIDEN_AFTER_MINUTES` (default 5).
  - Default behaviour: the first patient has the offer alone, and one more patient is added every 5 minutes, up to 3.
  - `OFFER_WIDEN_AFTER_MINUTES=0` contacts the whole cascade at once. `OFFER_CASCADE_SIZE=1` is the old one-at-a-time behaviour.
- How it works:
  - The graph state holds `live`, the open offers of the slot. A resume event names its offer.
  - The first acceptance that reserves the slot supersedes the other offers. Those patients get a fixed message and keep their waiting-list place.
  - Migration `003_offer_cascade.sql` drops the "one live offer per slot" index and adds `recovery_workflows.widen_at`. The sweeper sends a `widen` event when it is due.
  - A handoff ends only that patient's offer and stops new offers. With no offers left, the slot waits for staff as before. Staff can decide while other offers are open.
  - The offer message says the slot goes to the first patient who confirms, when more than one patient can be contacted.
- Tests: 8 new in `tests/offer-cascade.test.ts` (all at once, two simultaneous "yes", widening, widening with nobody left, decline and expiry, a question from one patient, handoff with offers open, staff decisions).
- `npm test` 116/116, `npm run eval` 19/19.
- **Not re-measured:** the test harness, the evals and the offline demo pin `OFFER_CASCADE_SIZE=1`, so the published benchmark and simulated-patient numbers were measured one patient at a time. At this point the cascade had not been run against the live WhatsApp gateway; the live run of 2026-11-10 used the default cascade, but only one patient had a real number.

## Update: Graph change notifications

- The calendar MCP gained the `ntf` tool (`info`, `ligar`, `desligar`), which creates and renews the Microsoft Graph subscription. This app now uses it.
- New in the app:
  - `POST /webhooks/graph` answers Graph's validation handshake and receives change and lifecycle notifications. It returns 404 unless `OUTLOOK_MCP_NOTIFY_URL` and `OUTLOOK_MCP_NOTIFY_SECRET` are set.
  - `services/calendar-notifications.ts` keeps the subscription alive (created at start, renewed one day before expiry, back-off on failure) and checks `clientState` on every notification.
  - A notification only triggers a calendar listing. A missing event that Graph also reported as deleted is confirmed by that one listing; every other rule of the detector is unchanged.
  - Polling stays. It runs at `CANCELLATION_FALLBACK_POLL_MS` while the subscription is healthy and at `CANCELLATION_POLL_MS` otherwise.
  - `GET /health` reports `calendarNotifications`: `off`, `active` or `degraded`.
- No migration. `cancellation_events.source` stays `calendar_poll`, with `details.deletedNotification = true` when a notification sped it up.
- The fake Graph now implements `/subscriptions`, validates the notification URL and sends "deleted" notifications.
- Tests: 11 new in `tests/calendar-notifications.test.ts`, one of them end to end through the real MCP process and the fake Graph. `npm test` 127/127.
- **Live run, 2026-11-10, real personal Outlook.com account + real WhatsApp test number:**
  - `calendar:sync` created the 10 synthetic events in a dedicated calendar and stored their ids.
  - `ntf acao=ligar` created the subscription in 4.5 s (Graph validated the URL through a quick tunnel). After an app restart the same subscription was renewed, not duplicated.
  - Deleting an event in Outlook: Graph sent an "updated" and then a "deleted" notification about 1 s apart. The deleted id matched the stored one, so the first listing confirmed the cancellation (`deletedNotification: true`). Notification to WhatsApp offer: about 7 s.
  - The patient's "yes" was booked in 4.5 s: availability check, event created, event seen in a fresh listing, confirmation sent.
  - Seen in the logs: right after start the app listed the calendar 5 times in 20 s, probably "updated" notifications for the events it had just created (arrivals were not logged yet; an info log line was added). The app's own booking also triggered one extra listing.
  - Unrelated to notifications: the first attempt sent nothing because the WA-AKG session was disconnected, and the first reply was lost because the WA-AKG webhook still pointed at an old tunnel address.
  - Patient cancellation over WhatsApp: "I need to cancel" got a proposal in 4 s. After "yes", the event was edited through MCP `ed` in 1.1 s (`[CANCELLED]` title, shown as free, not deleted), the patient was told 5 s after the "yes", and the freed slot started a new recovery workflow.
  - Subscription lifetime: `ntf acao=ligar dias=3` was accepted by the real Graph (expiry exactly 3 days ahead), so the MCP's maximum is within the limit for this account type.
- **Still not verified live:** a reschedule, a work or school tenant, lifecycle notifications and a renewal after more than a day.
- **Docs review after the live run:** the architecture diagram and notes, the business rules (new "Cancellation detection" section), the technology table (MCP commit `a500f8e`), the integration status table above and the README setup notes now describe the notifications. The offline demo pins notifications off.

## Update: fill simulation (offer modes compared)

- New `scripts/fill-sim.ts` (`npm run sim:fill`): 500 simulated cancellations per offer mode, run through the real workflow, sweeper and webhook endpoint on a simulated clock, with scripted patients (yes / no / silent, with a reply delay). No network and no API cost; it uses the test database.
- Result with the assumed behaviour (30% yes, 20% no, 50% silent, median reply delay 6 minutes, 6 eligible patients):
  - one at a time: median 35 minutes to fill, 29% filled within 15 minutes;
  - widening (default): median 12 minutes, 53% within 15 minutes, 1.37 patients per filled slot told it went to someone else;
  - all at once: median 6 minutes, 64% within 15 minutes, 1.93 patients told it went to someone else.
- All three modes filled the same 86% of slots, because the simulated slot is a day away and no mode runs out of time.
- The slot went to the longest-waiting patient who wanted it in 100% / 93% / 82% of filled slots.
- **Limits:** the behaviour is an assumption, not clinic data. Same-day slots, questions and handoffs are not simulated. Full table and method: [fill-simulation.md](fill-simulation.md).

## Update: pre-publication review

- **Secrets and personal data.** Every value in the local `.env` was searched for in the tracked files and in the whole git history: none of the keys, tokens, secrets, the test phone number or the tunnel address appears. Pattern searches (API keys, private keys, phone numbers outside the fictional range, e-mail addresses, local paths) found nothing either. `.env` and `.data/` are ignored.
- **Fixed:**
  - Docker Compose published PostgreSQL on every network interface with a public development password. It now binds to `127.0.0.1`.
  - The `.env.example` placeholders for `ADMIN_API_TOKEN` and `WA_AKG_WEBHOOK_SECRET` were long enough to be accepted as real values. They are now refused once the app is reachable (production, non-loopback host, real WhatsApp gateway, change notifications).
  - The README said the licence is MIT but there was no `LICENSE` file.
  - Docs: the evaluation scenario table listed 14 of the 19 scenarios; this log still said 116 tests.
- **Reviewed, no change needed:** SQL uses bound parameters; both webhooks compare their secret in constant time; the MCP child process only receives `OUTLOOK_MCP_*`; logs redact secrets and mask phone numbers; dev routes do not exist in production.
- **Known and documented:** no rate limiting; `npm audit` reports a `zod` 3.x advisory that needs the next major versions of the LangChain and OpenAI packages.
- `npm test` 128/128.

## Update: final documentation pass

- **Architecture notes corrected.** They said checkpoints never hold message bodies. They do hold the patient message being processed and the drafted reply; only phone numbers never enter them. The notes also gained the patient assistant (inbound routing, the agent graph and its 7 tools), the missing components, five graph transitions and the `patient_requests` table.
- **README.** The "Future improvements" section was removed. What it listed is now under known limitations ([limitations.md](limitations.md)) and under "Not done" in this log.
- **This log.** "Still to do" was split into "Manual configuration" and "Not done", which is now the single list of what is unverified, unmeasured or undecided.
- **Demo re-run** after the offer cascade and the notifications (it had not been run since the initial build): all 8 steps completed with the real MCP process against the fake Graph.
- **Benchmark wording.** The README said the held-out simulated-patient scenarios "are never tuned on". The published numbers are from the run after fixes that the first run on those scenarios prompted, so the README, [benchmarks.md](benchmarks.md) and the report generator now say that the set is no longer blind and give the first-run numbers.

## Update: project renamed to Waitlist Fill Agent

- The project was called "Agentic Appointment Recovery" (`agentic-appointment-recovery`). It is now "Waitlist Fill Agent" (`waitlist-fill-agent`): README title, package name, diagram label, demo banner, the eval configuration, the MCP client name and the description written into booked calendar events.
- Not renamed, on purpose: the `AAR-xxxxxxxx` reference in calendar event titles (database constraints and existing events depend on it), and the `aar` database, user and container names.

## Update: shorter README

- The README went from about 400 lines to about 200. Nothing was deleted; the detail moved to pages under `docs/`:
  - [setup.md](setup.md): running the server, HTTP endpoints, environment variables, connecting the real integrations, what to do before exposing the app;
  - [patient-requests.md](patient-requests.md): patient-initiated cancel and reschedule, and the function-calling agent;
  - [architecture.md](architecture.md): the reliability table and the project layout;
  - [evaluation.md](evaluation.md): the eval commands and what the native test suite covers;
  - [benchmarks.md](benchmarks.md): the component benchmark charts (the README keeps the key findings and the simulated-patient results).
  - [limitations.md](limitations.md): the full list of known limitations (the README keeps a three-sentence summary).
- The report generator writes the shorter README block, so a new benchmark run does not bring the long version back.
