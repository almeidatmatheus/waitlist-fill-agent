// Booking reliability: validation, concurrency, Outlook failures, partial failures and safe retries.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, IDS, type Harness } from './support/harness.ts';
import { CalendarError } from '../src/shared/errors.ts';
import { toLocalWallClock } from '../src/shared/time.ts';

after(closeDb);

async function offerFor(h: Harness, workflowId: string) {
  return (await h.offers(workflowId)).find(o => o.status === 'pending')!;
}
const bookings = async (h: Harness, workflowId: string) => (await h.db.query('SELECT * FROM bookings WHERE workflow_id = $1 ORDER BY created_at', [workflowId])).rows;

test('validation: expired offer, non-pending offer and ineligible patient are rejected before any calendar call', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const offer = await offerFor(h, workflowId);
    await h.db.query(`UPDATE patients SET contact_allowed = false WHERE id = $1`, [IDS.patient.sarah]);
    assert.deepEqual(await h.app.booking.reserve(offer.id), { ok: false, reason: 'patient_ineligible' });
    await h.db.query(`UPDATE patients SET contact_allowed = true WHERE id = $1`, [IDS.patient.sarah]);
    h.advance(31);
    assert.deepEqual(await h.app.booking.reserve(offer.id), { ok: false, reason: 'offer_expired' });
    assert.equal((await h.db.query('SELECT status FROM appointment_offers WHERE id = $1', [offer.id])).rows[0].status, 'expired');
    assert.deepEqual(await h.app.booking.reserve(offer.id), { ok: false, reason: 'offer_not_pending' });
    assert.equal(h.calendar.createCalls, 0);
  } finally { await h.close(); }
});

test('duplicate acceptance of the same offer yields one booking (idempotent reserve)', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const offer = await offerFor(h, workflowId);
    const [a, b] = await Promise.all([h.app.booking.reserve(offer.id), h.app.booking.reserve(offer.id)]);
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(a.bookingId, b.bookingId);
    assert.equal((await bookings(h, workflowId)).length, 1);
  } finally { await h.close(); }
});

test('two patients accepting the same slot: the booking-level guard lets exactly one win', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const sarahOffer = await offerFor(h, workflowId);
    const insertJamesOffer = () => h.db.query(
      `INSERT INTO appointment_offers (appointment_slot_reference, workflow_id, waitlist_id, patient_id, status, expires_at)
       SELECT appointment_slot_reference, workflow_id, $2, $3, 'pending', now() + interval '30 minutes' FROM appointment_offers WHERE id = $1 RETURNING id`,
      [sarahOffer.id, IDS.waitlist.james, IDS.patient.james]);
    // Two live offers for one slot are allowed (offer cascade). The slot reservation is what must be unique.
    const jamesOffer = (await insertJamesOffer()).rows[0].id;
    const sarah = await h.app.booking.reserve(sarahOffer.id);
    assert.ok(sarah.ok);
    assert.deepEqual(await h.app.booking.reserve(jamesOffer), { ok: false, reason: 'slot_taken' });
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM bookings WHERE slot_reference = $1 AND status NOT IN ('failed','released')`, [`slot:${IDS.appt.oliverCleaning}`])).rows[0].n, 1);
  } finally { await h.close(); }
});

test('simultaneous duplicate "yes" webhooks (different message ids) create one booking and one event', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await Promise.all([h.reply(IDS.phone.sarah, 'Yes please'), h.reply(IDS.phone.sarah, 'Yes!!')]);
    await h.app.sweeper.sweep();
    const b = await bookings(h, workflowId);
    assert.equal(b.length, 1);
    assert.equal(b[0].status, 'confirmed');
    assert.equal(h.calendar.findByRef(b[0].calendar_ref).length, 1);
    assert.equal(h.calendar.createCalls, 1);
    assert.equal(h.sent(IDS.phone.sarah).filter(t => t.includes('is confirmed for')).length, 1);
  } finally { await h.close(); }
});

test('Outlook reports the slot unavailable -> nothing booked, patient told, workflow ends', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const wf = await h.workflow(workflowId);
    // A staff member booked the freed slot directly in Outlook meanwhile.
    h.calendar.addEvent({ title: 'Emergency patient (staff)', start: toLocalWallClock(wf.starts_at, 'Europe/London'), end: toLocalWallClock(wf.ends_at, 'Europe/London') });
    await h.reply(IDS.phone.sarah, 'Yes please');
    assert.equal((await h.workflow(workflowId)).status, 'slot_unavailable');
    assert.equal(h.calendar.createCalls, 0);
    assert.match(h.lastSent(IDS.phone.sarah)!, /nothing has been booked/);
    assert.equal((await bookings(h, workflowId))[0].status, 'released');
  } finally { await h.close(); }
});

test('Outlook MCP error during create -> needs_reconciliation -> sweeper retry books exactly once', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    h.calendar.inject('create', { kind: 'error', error: new CalendarError('transient', 'graph 503') });
    await h.reply(IDS.phone.sarah, 'Yes please');
    let b = (await bookings(h, workflowId))[0];
    assert.equal(b.status, 'needs_reconciliation');
    assert.equal((await h.workflow(workflowId)).status, 'awaiting_reconciliation');
    assert.equal(h.sent(IDS.phone.sarah).some(t => /confirmed/.test(t)), false, 'no confirmation before verification');
    await h.app.sweeper.sweep();
    b = (await bookings(h, workflowId))[0];
    assert.equal(b.status, 'confirmed');
    assert.equal(h.calendar.findByRef(b.calendar_ref).length, 1);
    assert.match(h.lastSent(IDS.phone.sarah)!, /confirmed/);
  } finally { await h.close(); }
});

test('timeout AFTER the event was created: retry adopts the existing event (no duplicate)', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    h.calendar.inject('create', { kind: 'create_then_timeout' });
    await h.reply(IDS.phone.sarah, 'Yes please');
    assert.equal((await bookings(h, workflowId))[0].status, 'needs_reconciliation');
    await h.app.sweeper.sweep();
    const b = (await bookings(h, workflowId))[0];
    assert.equal(b.status, 'confirmed');
    assert.equal(h.calendar.createCalls, 1, 'create was not called again');
    assert.equal(h.calendar.findByRef(b.calendar_ref).length, 1);
    const how = (await h.db.query(`SELECT payload->>'how' how FROM workflow_events WHERE workflow_id = $1 AND event_type = 'calendar_event_verified'`, [workflowId])).rows[0].how;
    assert.equal(how, 'adopted_existing_event');
  } finally { await h.close(); }
});

test('calendar listing failure during availability check never books blindly', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    h.calendar.inject('list', { kind: 'error', error: new CalendarError('auth', 'login required') }, 2);
    await h.reply(IDS.phone.sarah, 'Yes please');
    assert.equal(h.calendar.createCalls, 0);
    assert.equal((await bookings(h, workflowId))[0].status, 'needs_reconciliation');
    await h.app.sweeper.sweep();
    assert.equal((await bookings(h, workflowId))[0].status, 'confirmed');
  } finally { await h.close(); }
});

test('database failure after the calendar write: booking stays calendar_created and is finalized later', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.db.query(`CREATE OR REPLACE FUNCTION pg_temp_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated db outage'; END $$ LANGUAGE plpgsql`);
    await h.db.query(`CREATE TRIGGER fail_recovery_insert BEFORE INSERT ON appointments FOR EACH ROW WHEN (NEW.source = 'recovery') EXECUTE FUNCTION pg_temp_fail()`);
    await h.reply(IDS.phone.sarah, 'Yes please');
    let b = (await bookings(h, workflowId))[0];
    assert.equal(b.status, 'calendar_created');
    assert.equal(h.calendar.findByRef(b.calendar_ref).length, 1);
    assert.equal(h.sent(IDS.phone.sarah).some(t => /confirmed/.test(t)), false);
    await h.db.query(`DROP TRIGGER fail_recovery_insert ON appointments; DROP FUNCTION pg_temp_fail()`);
    h.advance(1); // past the retry backoff
    await h.app.sweeper.sweep();
    b = (await bookings(h, workflowId))[0];
    assert.equal(b.status, 'confirmed');
    assert.equal(h.calendar.createCalls, 1);
    assert.match(h.lastSent(IDS.phone.sarah)!, /confirmed/);
  } finally { await h.close(); }
});

test('persistent Outlook failure: bounded retries, then failed + human handoff, never a false confirmation', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    h.calendar.inject('create', { kind: 'error', error: new CalendarError('transient', 'graph 503') }, 10);
    await h.reply(IDS.phone.sarah, 'Yes please');
    for (let i = 0; i < 6; i++) await h.app.sweeper.sweep();
    const b = (await bookings(h, workflowId))[0];
    assert.equal(b.status, 'failed');
    assert.equal(b.attempts, 5);
    assert.equal((await h.workflow(workflowId)).status, 'failed');
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM human_handoffs WHERE workflow_id = $1`, [workflowId])).rows[0].n, 1);
    assert.match(h.lastSent(IDS.phone.sarah)!, /not booked yet/);
    assert.equal(h.sent(IDS.phone.sarah).some(t => /confirmed/.test(t)), false);
  } finally { await h.close(); }
});

test('MCP asks for human confirmation: never auto-confirmed, handed off instead', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    h.calendar.inject('create', { kind: 'approval_required' });
    await h.reply(IDS.phone.sarah, 'Yes please');
    assert.equal((await bookings(h, workflowId))[0].status, 'approval_required');
    assert.equal((await h.workflow(workflowId)).status, 'awaiting_human');
    assert.equal(h.calendar.events.filter(e => e.ref && e.ref !== null && !e.ref.startsWith('AAR-a')).length, 0);
  } finally { await h.close(); }
});

test('safe retry: concurrent execute() calls on one booking make a single calendar write', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const offer = await offerFor(h, workflowId);
    const r = await h.app.booking.reserve(offer.id);
    assert.ok(r.ok);
    if (!r.ok) return;
    h.calendar.delayMs = 20;
    const outs = await Promise.all([h.app.booking.execute(r.bookingId), h.app.booking.execute(r.bookingId), h.app.booking.execute(r.bookingId)]);
    assert.equal(h.calendar.createCalls, 1);
    assert.equal(outs.filter(o => o.status === 'confirmed').length, 1);
    assert.equal(outs.filter(o => o.status === 'pending').length, 2);
    assert.equal((await h.app.booking.execute(r.bookingId)).status, 'confirmed', 'later retries are no-ops');
    assert.equal(h.calendar.createCalls, 1);
  } finally { await h.close(); }
});
