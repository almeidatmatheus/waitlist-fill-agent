# Business rules (deterministic, never decided by the LLM)

Implemented in `src/services/cancellation-detector.ts`, `src/services/waitlist-matching.ts`, `src/services/booking-service.ts` and `src/agents/guardrails.ts`.

## Cancellation detection

A cancellation is concluded only from a listing of the clinic calendar, for scheduled appointments in the next `CANCELLATION_LOOKAHEAD_DAYS`.

- A listing that failed (calendar outage, authentication, timeout) or came back truncated concludes nothing.
- An event marked as cancelled is a cancellation at once.
- A missing event is a cancellation after `CANCELLATION_CONFIRMATIONS` listings in a row without it. An event that reappears resets the count.
- A missing event that Microsoft Graph also reported as deleted (change notification, valid for 10 minutes) is a cancellation on the first listing without it.
- A notification alone is never a cancellation: the event must also be missing from a listing. Notifications without the shared secret are ignored.
- If 3 or more events, and more than half of the expected ones, are missing at once, it is treated as an anomaly (wrong calendar, permissions, partial data) and nothing is cancelled.
- An event is matched by its `AAR-` reference in the title or by its stored Graph id, so a renamed event is not a cancellation.
- One cancellation starts one recovery workflow per appointment (unique constraint), whatever detected it.

## Waitlist eligibility (all must pass)

| Rule | Meaning |
|---|---|
| R1 | waitlist entry status is `waiting` |
| R2 | same treatment as the cancelled appointment. No "compatible treatment" guessing |
| R3 | treatment duration fits inside the freed slot |
| R4 | `patients.contact_allowed = true` and the patient has a WhatsApp-capable number |
| R5 | slot starts at least `MIN_LEAD_TIME_MINUTES` from now |
| R6 | slot lies entirely inside the patient's preferred window, when one is set |
| R7 | if the patient already holds a scheduled appointment for this treatment, the slot must be earlier |
| R8 | not the patient whose appointment was cancelled |
| R9 | this waitlist entry was not already offered this slot (declined, expired, failed) |
| R10 | the patient has no other live offer and no open human handoff |
| R11 | the patient has no other scheduled appointment overlapping the slot |

Every rejection is recorded with its rule codes in `workflow_events` (`waitlist_searched`).

## Priority policy (total order)

1. **P1** longest waiting first (`waitlist.created_at` ascending)
2. **P2** largest wait reduction (current appointment start minus slot start; patients with no appointment count as the largest)
3. **P3** waitlist id, so ties always break the same way

## Offers

- Offer cascade: at most `OFFER_CASCADE_SIZE` live offers per slot, and at most one live offer per patient (partial unique index).
  - With `OFFER_WIDEN_AFTER_MINUTES > 0`, the first patient is offered the slot alone and one more patient is added each time that many minutes pass without a booking. With `0`, the whole cascade is contacted at once. With `OFFER_CASCADE_SIZE=1`, patients are contacted one at a time.
  - Patients are added in priority order (P1 to P3), so the patient who has waited longest is always contacted first.
  - The first acceptance that reserves the slot wins. Every other live offer becomes `superseded`, and those patients get a fixed "booked by another patient" message and keep their waiting-list entry.
  - When the cascade is larger than one, the offer message states that the slot goes to the first patient who confirms.
  - While a handoff is open for the slot, no new offers are created. Offers already sent stay open. When none are left, the slot waits for the staff decision.
- An offer expires after `OFFER_TTL_MINUTES`. The deadline is enforced against the clock, not only the status: inbound routing, the interpretation gate and `reserve()` all check `expires_at`.
- A declined, expired, delivery-failed or ineligible offer frees its place in the cascade for the next candidate. "Already booked elsewhere" sets the waitlist entry to `fulfilled_elsewhere`. "Stop messaging me" sets `contact_allowed=false` and withdraws the entry.
- A clarification is sent at most `MAX_CLARIFICATION_TURNS` times. After that the conversation goes to a human.

## Booking preconditions (in order)

1. Offer is `pending` and `expires_at > now`.
2. Patient still has `contact_allowed` and the waitlist entry is `waiting`.
3. The slot has no other active booking (`bookings_one_active_per_slot_uq`).
4. Outlook availability is re-checked through MCP `ls` on the clinic calendar (events overlapping the slot, except the cancelled appointment's own event).
5. The DB reservation (`bookings` row, `reserved`) is committed before any external call.
6. The event is created with MCP `cr`, without attendees.
7. The event is seen in a fresh listing, then the result is persisted in one local transaction.
8. The offer is marked `confirmed` and the waitlist entry `booked`.
9. Only then is the confirmation message sent.

## Conversation policy

- Clinical words (pain, bleeding, swelling, infection, urgent...) bypass the LLM and go to a human. The reply is a fixed safety template with no advice.
- A request for a call or a person goes to a human. The patient is told the team was notified **only if** the notifier actually succeeded. Otherwise they are asked to call the clinic.
- Critical facts (offer, confirmation, expiry, unavailability) always use fixed templates. LLM-drafted text is used only for clarifications, and only after validation: no claims of a booking, no links, no clinical terms, at most 320 characters.
- An "accept" from a message matching prompt-injection heuristics, or with confidence below 0.6, is treated as ambiguous.
- Unknown numbers are never answered. Other patients' details are never included in any message.

## Patient-initiated changes (cancel / reschedule)

- Only the patient's own `scheduled`, future appointments can be changed. Unknown numbers are never answered.
- Nothing is changed without an explicit "yes" to a concrete proposal. A "yes" inside a message that matches the prompt-injection heuristics does not count.
- Appointments starting within `MIN_LEAD_TIME_MINUTES` cannot be changed over WhatsApp and go to a human.
- New times must be inside `CLINIC_OPENING_HOURS`, on a 30-minute grid (exact requests are checked at 5-minute precision), at least `MIN_LEAD_TIME_MINUTES` ahead, and free in the live calendar. They must also not overlap the patient's other appointments. The duration is the treatment's duration.
- A proposal expires after `PATIENT_REQUEST_TTL_MINUTES`.
- One open request per patient, and one executing request per appointment (unique indexes).
- The freed slot always starts a recovery workflow (`cancellation_events.source = 'patient'`), so it is offered to the waiting list.
