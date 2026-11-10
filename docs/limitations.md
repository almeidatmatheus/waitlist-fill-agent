# Known limitations

What this project does not do, has not verified, or has only measured under assumptions.

- **Outlook was verified with one real personal account, not with a work or school tenant.** A reschedule and subscription lifecycle notifications were only run against a *fake* Graph with the real MCP server process. WhatsApp (WA-AKG), OpenAI and Jev were verified live. See [docs/implementation-progress.md](implementation-progress.md).
- MCP `ls` output has no year (it is inferred inside the requested range) and truncates titles at 60 characters (the ref goes first). `find` and `free` only look at the default calendar, so availability is checked with `ls` on the dedicated calendar. `ls` also identifies whose event each busy block is, so a patient's own appointment is ignored when moving it.
- Events are never deleted automatically, because MCP `rm` always asks for human confirmation. Cancelled/rescheduled events are edited to `[CANCELLED]` and shown as free; staff can delete them later. Releasing a patient's *later* appointment after an earlier one is booked is flagged for staff (`later_appointment_needs_release`).
- Messaging is at-least-once around a crash between the gateway accepting a message and the DB recording it. Idempotency keys prevent every other duplicate.
- Without Graph change notifications, polling detects cancellations with up to `CANCELLATION_POLL_MS × CANCELLATION_CONFIRMATIONS` delay. Notifications need a stable public HTTPS address. The app also reacts to its own calendar writes: each one causes one extra listing.
- With the offer cascade, a patient can accept an offer and be told the slot has just gone to someone else.
- The fill simulation uses assumed patient behaviour and a slot that is a day away. The clinic is fictional, so there are no real reply rates or delays to measure against. The time from cancellation to first offer with notifications (about 7 seconds) was measured once.
- In a waiting-list offer, a request for another day is answered, but no other slot is searched: the offer is for one specific slot. (Patients rescheduling their own appointment do get real free times.)
- No rate limiting, and one shared admin token instead of user accounts. The API is meant to run on localhost, with only the webhooks reachable from outside.
- `npm audit` reports a high-severity advisory in `zod` 3.x (memory use when validating oversized collections, GHSA-mrhx-c7xc-m3w5). It comes in through `@langchain/core` and the `openai` SDK, and the fix needs their next major versions. The app does not validate patient input with zod, and request bodies are capped at 256 KB.
- English only.
- Multi-instance deployment is designed for (DB leases, unique constraints) but was only tested in a single process. The subscription state and the "deleted" hints of the change notifications are kept in memory, per process.
