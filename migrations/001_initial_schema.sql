-- 001: core schema of the fictional Clinic Management System + recovery workflow state.
-- All timestamps are timestamptz (stored as UTC). Display conversion happens in the application.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE patients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name        text NOT NULL,
  phone_number     text NOT NULL UNIQUE CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_jid     text UNIQUE,
  contact_allowed  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE treatments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appointments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id              uuid NOT NULL REFERENCES patients(id),
  treatment_id            uuid NOT NULL REFERENCES treatments(id),
  -- Stable Microsoft Graph event id, when the calendar integration can provide one (see docs/architecture.md).
  outlook_event_id        text UNIQUE,
  -- Stable correlation token embedded in the calendar event title ("AAR-xxxxxxxx").
  -- The existing MCP only exposes short, session-scoped display ids, which are never persisted.
  calendar_ref            text UNIQUE CHECK (calendar_ref ~ '^AAR-[0-9a-f]{8}$'),
  starts_at               timestamptz NOT NULL,
  ends_at                 timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled', 'cancelled', 'completed', 'no_show')),
  source                  text NOT NULL DEFAULT 'clinic' CHECK (source IN ('clinic', 'recovery')),
  -- Cancellation polling bookkeeping
  calendar_missing_count  integer NOT NULL DEFAULT 0,
  last_calendar_check_at  timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX appointments_status_starts_idx ON appointments (status, starts_at);
CREATE INDEX appointments_patient_idx ON appointments (patient_id);

CREATE TABLE waitlist (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  treatment_id     uuid NOT NULL REFERENCES treatments(id),
  preferred_start  timestamptz,
  preferred_end    timestamptz,
  status           text NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting', 'offered', 'booked', 'withdrawn', 'fulfilled_elsewhere')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (preferred_end IS NULL OR preferred_start IS NULL OR preferred_end > preferred_start)
);
-- A patient waits at most once per treatment.
CREATE UNIQUE INDEX waitlist_active_patient_treatment_uq
  ON waitlist (patient_id, treatment_id) WHERE status IN ('waiting', 'offered');
CREATE INDEX waitlist_treatment_status_idx ON waitlist (treatment_id, status, created_at);

-- Confirmed cancellations. UNIQUE(appointment_id) guarantees one recovery per cancelled appointment.
CREATE TABLE cancellation_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL UNIQUE REFERENCES appointments(id),
  source          text NOT NULL CHECK (source IN ('calendar_poll', 'manual')),
  observation     text NOT NULL CHECK (observation IN ('missing', 'cancelled', 'manual')),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- One recovery workflow per cancelled slot. id doubles as the LangGraph thread id.
CREATE TABLE recovery_workflows (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cancelled_appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id),
  slot_reference           text NOT NULL UNIQUE,
  treatment_id             uuid NOT NULL REFERENCES treatments(id),
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'awaiting_patient', 'awaiting_human', 'awaiting_reconciliation',
                                             'booked', 'exhausted', 'slot_unavailable', 'closed', 'failed')),
  current_state            text NOT NULL DEFAULT 'cancellation_detected',
  -- Lease used to serialise graph executions without holding DB locks during external calls.
  lease_owner              text,
  lease_expires_at         timestamptz,
  last_error               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_workflows_status_idx ON recovery_workflows (status);

CREATE TABLE appointment_offers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_slot_reference  text NOT NULL REFERENCES recovery_workflows(slot_reference),
  workflow_id                 uuid NOT NULL REFERENCES recovery_workflows(id),
  waitlist_id                 uuid NOT NULL REFERENCES waitlist(id),
  patient_id                  uuid NOT NULL REFERENCES patients(id),
  status                      text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'accepted', 'confirmed', 'declined', 'expired',
                                                'send_failed', 'handoff', 'slot_unavailable', 'failed', 'superseded')),
  expires_at                  timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  responded_at                timestamptz
);
-- One-patient-at-a-time: at most one live offer per slot.
CREATE UNIQUE INDEX offers_one_live_per_slot_uq
  ON appointment_offers (appointment_slot_reference) WHERE status IN ('pending', 'accepted');
-- A waitlist entry is offered a given slot at most once (idempotent offer creation).
CREATE UNIQUE INDEX offers_slot_waitlist_uq ON appointment_offers (appointment_slot_reference, waitlist_id);
-- A patient never has two live offers at once.
CREATE UNIQUE INDEX offers_one_live_per_patient_uq
  ON appointment_offers (patient_id) WHERE status IN ('pending', 'accepted');
CREATE INDEX offers_pending_expiry_idx ON appointment_offers (expires_at) WHERE status = 'pending';

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  active_offer_id  uuid REFERENCES appointment_offers(id),
  thread_id        uuid REFERENCES recovery_workflows(id),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'handoff')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX conversations_one_open_per_patient_uq
  ON conversations (patient_id) WHERE status IN ('open', 'handoff');

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid REFERENCES conversations(id),
  patient_id           uuid REFERENCES patients(id),
  offer_id             uuid REFERENCES appointment_offers(id),
  external_message_id  text,
  direction            text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- Outbound idempotency key, e.g. "offer:<offer id>" or "confirmation:<booking id>".
  idempotency_key      text UNIQUE,
  content              text NOT NULL,
  delivery_status      text NOT NULL DEFAULT 'received'
                       CHECK (delivery_status IN ('received', 'pending', 'sent', 'failed')),
  error                text,
  attempts             integer NOT NULL DEFAULT 0,
  correlation_id       text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_external_direction_uq ON messages (direction, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

-- Raw webhook deliveries: deduplication + durable processing (survives restarts).
CREATE TABLE inbound_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL,
  external_message_id  text NOT NULL,
  payload              jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'processed', 'ignored', 'failed')),
  attempts             integer NOT NULL DEFAULT 0,
  last_error           text,
  correlation_id       text NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  UNIQUE (provider, external_message_id)
);
CREATE INDEX inbound_events_pending_idx ON inbound_events (received_at) WHERE status = 'pending';

-- Durable booking state machine. Calendar side effects cannot share a DB transaction, so every
-- step is recorded and a reconciler finishes or compensates partially completed bookings.
CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id            uuid NOT NULL UNIQUE REFERENCES appointment_offers(id),
  workflow_id         uuid NOT NULL REFERENCES recovery_workflows(id),
  slot_reference      text NOT NULL REFERENCES recovery_workflows(slot_reference),
  patient_id          uuid NOT NULL REFERENCES patients(id),
  treatment_id        uuid NOT NULL REFERENCES treatments(id),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  calendar_ref        text NOT NULL UNIQUE CHECK (calendar_ref ~ '^AAR-[0-9a-f]{8}$'),
  status              text NOT NULL DEFAULT 'reserved'
                      CHECK (status IN ('reserved', 'calendar_pending', 'calendar_created', 'confirmed',
                                        'needs_reconciliation', 'approval_required', 'failed', 'released')),
  attempts            integer NOT NULL DEFAULT 0,
  outlook_event_id    text,
  appointment_id      uuid REFERENCES appointments(id),
  last_error          text,
  next_attempt_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Two patients can never hold an active booking for the same slot.
CREATE UNIQUE INDEX bookings_one_active_per_slot_uq ON bookings (slot_reference)
  WHERE status NOT IN ('failed', 'released');
CREATE INDEX bookings_reconcile_idx ON bookings (status, next_attempt_at)
  WHERE status IN ('reserved', 'calendar_pending', 'calendar_created', 'needs_reconciliation');

CREATE TABLE human_handoffs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      uuid REFERENCES recovery_workflows(id),
  conversation_id  uuid REFERENCES conversations(id),
  patient_id       uuid REFERENCES patients(id),
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  notified         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX human_handoffs_open_idx ON human_handoffs (status) WHERE status = 'open';

CREATE TABLE workflow_events (
  id           bigserial PRIMARY KEY,
  workflow_id  uuid REFERENCES recovery_workflows(id),
  event_type   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_events_workflow_idx ON workflow_events (workflow_id, id);
CREATE INDEX workflow_events_type_idx ON workflow_events (event_type, created_at);
