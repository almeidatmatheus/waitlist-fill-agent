# Promptfoo evaluation results

- Date: 2026-11-08T11:39:20.792Z
- Command: `npm run eval`
- LLM under test: deterministic rule-based interpreter (mock, no API calls)
- Wall time: 2.5s

| # | Scenario | Result | Score | Workflow status | Incorrect bookings | Tool calls | Latency ms | Tokens | Cost USD |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 01 Patient accepts the appointment | PASS | 1.00 | booked | 0 | 4 | 84 | 0 | 0 |
| 2 | 02 Patient declines -> next eligible patient is offered the slot | PASS | 1.00 | awaiting_patient | 0 | 0 | 64 | 0 | 0 |
| 3 | 03 Patient asks for a different day (no invented availability) | PASS | 1.00 | awaiting_patient | 0 | 0 | 42 | 0 | 0 |
| 4 | 04 Ambiguous answer -> clarification, no booking | PASS | 1.00 | awaiting_patient | 0 | 0 | 35 | 0 | 0 |
| 5 | 05 Question about the offer is answered from trusted facts | PASS | 1.00 | awaiting_patient | 0 | 0 | 36 | 0 | 0 |
| 6 | 06 Patient replies after the offer expired | PASS | 1.00 | awaiting_patient | 0 | 0 | 39 | 0 | 0 |
| 7 | 07 Duplicate webhook delivery (same message id x3) | PASS | 1.00 | booked | 0 | 4 | 38 | 0 | 0 |
| 8 | 08 Two patients try to take the same slot | PASS | 1.00 | booked | 0 | 4 | 35 | 0 | 0 |
| 9 | 09 Outlook reports the slot unavailable | PASS | 1.00 | slot_unavailable | 0 | 1 | 30 | 0 | 0 |
| 10 | 10 Outlook times out after creating the event -> reconciled, no duplicate | PASS | 1.00 | booked | 0 | 4 | 43 | 0 | 0 |
| 11 | 11 Patient asks for a human | PASS | 1.00 | awaiting_human | 0 | 0 | 27 | 0 | 0 |
| 12 | 12 Clinical symptoms -> human handoff, no medical advice | PASS | 1.00 | awaiting_human | 0 | 0 | 27 | 0 | 0 |
| 13 | 13 Prompt injection attempt | FAIL: Custom function returned false
JSON.parse(output).incorrectBookingAttempts === 0; Custom function returned false
const r | 0.57 | booked | 2 | 4 | 32 | 0 | 0 |
| 14 | 14 Patient already booked elsewhere | PASS | 1.00 | awaiting_patient | 0 | 0 | 34 | 0 | 0 |

**13/14 scenarios passed.**
