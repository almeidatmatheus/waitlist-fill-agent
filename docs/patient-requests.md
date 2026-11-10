# Patient-initiated cancellations and reschedules

Patients can also message the clinic on their own: *"I need to cancel"*, *"Can I move it to 4pm?"*, *"Thank you!"*. One LLM call reads the message and extracts the intent, the referenced appointment and the requested date/time. **Deterministic code** does the rest ([src/services/patient-request-service.ts](../src/services/patient-request-service.ts)):

1. It picks the patient's **own** upcoming appointment. If there are several, it asks which one with a numbered list.
2. **Cancel:** it asks *"shall I cancel your … ? Reply yes"*. Nothing changes before an explicit yes.
3. **Reschedule:** it reads the live clinic calendar through the MCP (`ls`) and checks opening hours (`CLINIC_OPENING_HOURS`), the lead time and the patient's other appointments. If the requested time is free, it asks for confirmation. Otherwise it offers up to 3 real alternatives. Availability never comes from the model.
4. **Execution** is a durable, resumable state machine (`patient_requests`). It creates the new event (`cr`, verified by ref) and stores the new appointment. Then it **edits** the old event (`ed`: `[CANCELLED]` title + shown as free), so the slot is released **without deleting it**: the MCP's `rm` always requires human approval, and this app never bypasses that. The patient is told only after the calendar change has been verified. Failures are retried by the sweeper. After 5 attempts the request goes to a human with an honest message.
5. The freed slot **automatically starts a recovery workflow**, so it is offered to the waiting list.
6. If the appointment starts within `MIN_LEAD_TIME_MINUTES`, or the MCP asks for approval, the request goes to a human. Small talk gets a short, guarded LLM reply. "ok/👍" gets no reply, and small talk is capped at 5 replies per patient per 24 h.
7. **End of conversation.** Once the clinic has signed off ("You're welcome!", "Take care"), nothing is pending and the patient only closes ("thanks again, bye 👍"), the conversation is treated as finished. There is no reply and no model call, so the chat never ping-pongs. Any real question reopens it.

## Function-calling agent (OpenAI mode)

With `LLM_PROVIDER=openai`, messages outside a live offer are handled by a **real tool-calling agent** ([src/agents/tool-agent.ts](../src/agents/tool-agent.ts)). It is a LangGraph `agent ↔ tools` loop over OpenAI function calling, and the model decides which tools to call:

| Tool | Backed by |
|---|---|
| `get_my_appointments` | the patient's own upcoming appointments (per-run aliases `appt_1…`; the model never sees DB ids) |
| `check_availability` | live clinic calendar via the Outlook MCP `ls` + opening hours + lead time |
| `propose_reschedule` / `propose_cancellation` | creates a pending `patient_requests` proposal; changes nothing |
| `confirm_pending_change` | runs the durable cancel/reschedule state machine (MCP `cr` / `ed`) |
| `discard_pending_change`, `handoff_to_human` | withdraw a proposal / open a human handoff |

The tools enforce the policy themselves, so a wrong or manipulated tool call is refused:
- Ownership and free-slot checks.
- No "move" to the same time.
- `confirm_pending_change` only works if the proposal was made in an **earlier** message and the latest message is **clearly affirmative** ("yes", "go ahead", "y"…), not a "no", "thanks" or an injection attempt. The confirmation gate uses Jev when `TYPESAFE_API_KEY` is set, and rules otherwise. One exception: picking one of the times the clinic just listed ("2:30pm please") counts as agreement.
- The final text cannot claim a change unless the confirm tool completed in that run. Otherwise it is replaced with an honest message.
- If the model errors, the patient still gets an honest reply.

The live smoke test (`node --env-file=.env scripts/agent-smoke.ts`) runs the conversation against the real model on the test DB, with no real messages sent. With `LLM_PROVIDER=mock`, the deterministic flow above is used instead.
