-- Offer cascade: one freed slot can be on offer to several patients at once.
-- "One booking per slot" is still guaranteed by bookings_one_active_per_slot_uq; the per-patient limit
-- (offers_one_live_per_patient_uq) and the once-per-waitlist-entry rule (offers_slot_waitlist_uq) stay.
DROP INDEX IF EXISTS offers_one_live_per_slot_uq;

-- When the workflow should next widen the offer to one more patient (NULL = nothing scheduled).
ALTER TABLE recovery_workflows ADD COLUMN widen_at timestamptz;
CREATE INDEX recovery_workflows_widen_idx ON recovery_workflows (widen_at) WHERE widen_at IS NOT NULL;
