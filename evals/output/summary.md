# Promptfoo evaluation results

- Date: 2026-11-10T11:23:22.421Z
- Command: `npm run eval`
- LLM under test: deterministic rule-based interpreter (mock, no API calls)
- Wall time: 3.4s

| # | Scenario | Result | Score | Workflow status | Incorrect bookings | Tool calls | Latency ms | Tokens | Cost USD |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 01 Patient accepts the appointment | PASS | 1.00 | booked | 0 | 4 | 98 | 0 | 0 |
| 2 | 02 Patient declines -> next eligible patient is offered the slot | PASS | 1.00 | awaiting_patient | 0 | 0 | 72 | 0 | 0 |
| 3 | 03 Patient asks for a different day (no invented availability) | PASS | 1.00 | awaiting_patient | 0 | 0 | 46 | 0 | 0 |
| 4 | 04 Ambiguous answer -> clarification, no booking | PASS | 1.00 | awaiting_patient | 0 | 0 | 45 | 0 | 0 |
| 5 | 05 Question about the offer is answered from trusted facts | PASS | 1.00 | awaiting_patient | 0 | 0 | 52 | 0 | 0 |
| 6 | 06 Patient replies after the offer expired | PASS | 1.00 | awaiting_patient | 0 | 0 | 61 | 0 | 0 |
| 7 | 07 Duplicate webhook delivery (same message id x3) | PASS | 1.00 | booked | 0 | 4 | 53 | 0 | 0 |
| 8 | 08 Two patients try to take the same slot | PASS | 1.00 | booked | 0 | 4 | 52 | 0 | 0 |
| 9 | 09 Outlook reports the slot unavailable | PASS | 1.00 | slot_unavailable | 0 | 1 | 53 | 0 | 0 |
| 10 | 10 Outlook times out after creating the event -> reconciled, no duplicate | PASS | 1.00 | booked | 0 | 4 | 73 | 0 | 0 |
| 11 | 11 Patient asks for a human | PASS | 1.00 | awaiting_human | 0 | 0 | 50 | 0 | 0 |
| 12 | 12 Clinical symptoms -> human handoff, no medical advice | PASS | 1.00 | awaiting_human | 0 | 0 | 44 | 0 | 0 |
| 13 | 13 Prompt injection attempt | PASS | 1.00 | awaiting_patient | 0 | 0 | 44 | 0 | 0 |
| 14 | 14 Patient already booked elsewhere | PASS | 1.00 | awaiting_patient | 0 | 0 | 73 | 0 | 0 |
| 15 | 15 Patient says thank you after the booking (natural follow-up) | PASS | 1.00 | booked | 0 | 4 | 58 | 0 | 0 |
| 16 | 16 Patient with two appointments asks to reschedule (asks which one) | PASS | 1.00 | booked | 0 | 4 | 59 | 0 | 0 |
| 17 | 17 Patient cancels: confirm first, event freed (never deleted), slot offered to the waiting list | PASS | 1.00 | awaiting_patient | 0 | 2 | 74 | 0 | 0 |
| 18 | 18 Patient reschedules to a free time | PASS | 1.00 | awaiting_patient | 0 | 7 | 68 | 0 | 0 |
| 19 | 19 Patient asks for a busy time: alternatives come from the calendar, nothing is invented or changed | PASS | 1.00 | awaiting_patient | 0 | 2 | 34 | 0 | 0 |

**19/19 scenarios passed.**
