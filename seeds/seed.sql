-- Synthetic data for the fictional "Bright Smile Dental" clinic. NO real people.
-- Phone numbers use the UK Ofcom range reserved for drama/fiction (+44 7700 900xxx).
-- Times are relative to "today" in the clinic time zone (session setting aar.clinic_tz),
-- so the demo always has upcoming appointments. Re-running is safe (idempotent upserts by id).

CREATE OR REPLACE FUNCTION pg_temp.slot(day_offset int, hhmm text) RETURNS timestamptz AS $$
  SELECT ((date_trunc('day', now() AT TIME ZONE current_setting('aar.clinic_tz'))
           + make_interval(days => day_offset) + hhmm::time) AT TIME ZONE current_setting('aar.clinic_tz'))
$$ LANGUAGE sql STABLE;

INSERT INTO treatments (id, name, duration_minutes) VALUES
  ('11111111-0000-4000-8000-000000000001', 'Dental cleaning', 30),
  ('11111111-0000-4000-8000-000000000002', 'Check-up', 30),
  ('11111111-0000-4000-8000-000000000003', 'Filling', 45),
  ('11111111-0000-4000-8000-000000000004', 'Whitening consultation', 30),
  ('11111111-0000-4000-8000-000000000005', 'Root canal treatment', 90)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, duration_minutes = EXCLUDED.duration_minutes;

INSERT INTO patients (id, full_name, phone_number, whatsapp_jid, contact_allowed) VALUES
  ('22222222-0000-4000-8000-000000000001', 'Oliver Bennett',  '+447700900001', '447700900001@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000002', 'Sarah Mitchell',  '+447700900002', '447700900002@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000003', 'James Carter',    '+447700900003', '447700900003@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000004', 'Amelia Hughes',   '+447700900004', '447700900004@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000005', 'Noah Patel',      '+447700900005', '447700900005@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000006', 'Isla Thompson',   '+447700900006', '447700900006@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000007', 'Leo Robinson',    '+447700900007', '447700900007@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000008', 'Grace Walker',    '+447700900008', '447700900008@s.whatsapp.net', false),
  ('22222222-0000-4000-8000-000000000009', 'Ethan Wright',    '+447700900009', '447700900009@s.whatsapp.net', true),
  ('22222222-0000-4000-8000-000000000010', 'Mia Clarke',      '+447700900010', '447700900010@s.whatsapp.net', true)
ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number,
  whatsapp_jid = EXCLUDED.whatsapp_jid, contact_allowed = EXCLUDED.contact_allowed;

-- 10 appointments. calendar_ref is the stable token written into the Outlook event title.
INSERT INTO appointments (id, patient_id, treatment_id, calendar_ref, starts_at, ends_at, status) VALUES
  -- Near-term slots (candidates for cancellation in the demo)
  ('33333333-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'AAR-a0000001', pg_temp.slot(1, '14:00'), pg_temp.slot(1, '14:30'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000005', '11111111-0000-4000-8000-000000000003', 'AAR-a0000002', pg_temp.slot(1, '10:00'), pg_temp.slot(1, '10:45'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000003', '22222222-0000-4000-8000-000000000006', '11111111-0000-4000-8000-000000000002', 'AAR-a0000003', pg_temp.slot(2, '09:00'), pg_temp.slot(2, '09:30'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000004', '22222222-0000-4000-8000-000000000007', '11111111-0000-4000-8000-000000000005', 'AAR-a0000004', pg_temp.slot(2, '11:00'), pg_temp.slot(2, '12:30'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000005', '22222222-0000-4000-8000-000000000009', '11111111-0000-4000-8000-000000000001', 'AAR-a0000005', pg_temp.slot(3, '15:00'), pg_temp.slot(3, '15:30'), 'scheduled'),
  -- Later appointments held by patients who are waiting for something earlier
  ('33333333-0000-4000-8000-000000000006', '22222222-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', 'AAR-a0000006', pg_temp.slot(21, '10:00'), pg_temp.slot(21, '10:30'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000007', '22222222-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001', 'AAR-a0000007', pg_temp.slot(18, '16:00'), pg_temp.slot(18, '16:30'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000008', '22222222-0000-4000-8000-000000000010', '11111111-0000-4000-8000-000000000003', 'AAR-a0000008', pg_temp.slot(14, '09:30'), pg_temp.slot(14, '10:15'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000009', '22222222-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000002', 'AAR-a0000009', pg_temp.slot(25, '11:00'), pg_temp.slot(25, '11:30'), 'scheduled'),
  ('33333333-0000-4000-8000-000000000010', '22222222-0000-4000-8000-000000000008', '11111111-0000-4000-8000-000000000001', 'AAR-a000000a', pg_temp.slot(10, '13:00'), pg_temp.slot(10, '13:30'), 'scheduled')
ON CONFLICT (id) DO UPDATE SET patient_id = EXCLUDED.patient_id, treatment_id = EXCLUDED.treatment_id,
  calendar_ref = EXCLUDED.calendar_ref, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
  status = EXCLUDED.status, calendar_missing_count = 0, updated_at = now();

-- Waiting list (7 entries, 6 active candidates for different rules).
INSERT INTO waitlist (id, patient_id, treatment_id, preferred_start, preferred_end, status, created_at) VALUES
  -- Oldest entry, but contact_allowed = false -> must never be contacted
  ('44444444-0000-4000-8000-000000000003', '22222222-0000-4000-8000-000000000008', '11111111-0000-4000-8000-000000000001', NULL, NULL, 'waiting', now() - interval '25 days'),
  -- Highest-priority eligible patient for a cleaning
  ('44444444-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', now() - interval '1 day', pg_temp.slot(20, '18:00'), 'waiting', now() - interval '20 days'),
  ('44444444-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001', NULL, NULL, 'waiting', now() - interval '15 days'),
  ('44444444-0000-4000-8000-000000000005', '22222222-0000-4000-8000-000000000010', '11111111-0000-4000-8000-000000000003', NULL, NULL, 'waiting', now() - interval '12 days'),
  ('44444444-0000-4000-8000-000000000004', '22222222-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000002', NULL, NULL, 'waiting', now() - interval '10 days'),
  -- Only available from day +5 onwards -> outside the window for near-term slots
  ('44444444-0000-4000-8000-000000000006', '22222222-0000-4000-8000-000000000007', '11111111-0000-4000-8000-000000000001', pg_temp.slot(5, '08:00'), pg_temp.slot(30, '18:00'), 'waiting', now() - interval '5 days'),
  ('44444444-0000-4000-8000-000000000007', '22222222-0000-4000-8000-000000000006', '11111111-0000-4000-8000-000000000001', NULL, NULL, 'waiting', now() - interval '2 days')
ON CONFLICT (id) DO UPDATE SET patient_id = EXCLUDED.patient_id, treatment_id = EXCLUDED.treatment_id,
  preferred_start = EXCLUDED.preferred_start, preferred_end = EXCLUDED.preferred_end,
  status = EXCLUDED.status, created_at = EXCLUDED.created_at;
