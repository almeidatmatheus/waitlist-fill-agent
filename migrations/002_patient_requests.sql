-- 002: patient-initiated cancellations and reschedules over WhatsApp.

ALTER TABLE cancellation_events DROP CONSTRAINT cancellation_events_source_check;
ALTER TABLE cancellation_events ADD CONSTRAINT cancellation_events_source_check CHECK (source IN ('calendar_poll', 'manual', 'patient'));
ALTER TABLE cancellation_events DROP CONSTRAINT cancellation_events_observation_check;
ALTER TABLE cancellation_events ADD CONSTRAINT cancellation_events_observation_check CHECK (observation IN ('missing', 'cancelled', 'manual', 'patient_cancel', 'patient_reschedule'));

ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN ('scheduled', 'cancelled', 'rescheduled', 'completed', 'no_show'));
ALTER TABLE appointments DROP CONSTRAINT appointments_source_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_source_check CHECK (source IN ('clinic', 'recovery', 'reschedule'));

-- Durable state machine for one patient request. The LLM only extracts what the patient wants;
-- the target appointment, the free slots and every calendar change are decided here, deterministically.
CREATE TABLE patient_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid NOT NULL REFERENCES patients(id),
  conversation_id     uuid REFERENCES conversations(id),
  kind                text NOT NULL CHECK (kind IN ('cancel', 'reschedule')),
  status              text NOT NULL DEFAULT 'awaiting_selection'
                      CHECK (status IN ('awaiting_selection', 'awaiting_confirmation', 'executing', 'completed',
                                        'declined', 'expired', 'failed', 'handoff', 'superseded')),
  appointment_id      uuid REFERENCES appointments(id),
  -- Options offered to the patient (reschedule) as [{start, end}] in UTC ISO strings.
  options             jsonb NOT NULL DEFAULT '[]'::jsonb,
  chosen_start        timestamptz,
  chosen_end          timestamptz,
  -- Execution progress (idempotent steps): new event ref + new appointment, then release of the old event.
  new_calendar_ref    text UNIQUE CHECK (new_calendar_ref ~ '^AAR-[0-9a-f]{8}$'),
  new_appointment_id  uuid REFERENCES appointments(id),
  step                text NOT NULL DEFAULT 'none' CHECK (step IN ('none', 'new_event_created', 'old_event_released', 'done')),
  workflow_id         uuid REFERENCES recovery_workflows(id),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  next_attempt_at     timestamptz,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- One open request per patient at a time.
CREATE UNIQUE INDEX patient_requests_one_open_uq ON patient_requests (patient_id)
  WHERE status IN ('awaiting_selection', 'awaiting_confirmation', 'executing');
-- One executing request per appointment (two requests cannot move/cancel the same appointment).
CREATE UNIQUE INDEX patient_requests_one_exec_per_appt_uq ON patient_requests (appointment_id) WHERE status = 'executing';
