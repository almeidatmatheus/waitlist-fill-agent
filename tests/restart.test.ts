// Persistence across application restarts: LangGraph checkpoints in PostgreSQL + durable business state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { createHarness, closeDb, IDS, testConfig, testDb } from './support/harness.ts';
import { RuleBasedLlm } from '../src/agents/rule-based-llm.ts';
import { silentLogger } from '../src/shared/logger.ts';

after(closeDb);

test('a reply after a restart resumes the persisted conversation in a brand-new process instance', async () => {
  const h = await createHarness();
  const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
  await h.close(); // "process 1" stops while the graph waits for the patient

  const app2 = await buildApp(testConfig(), { db: testDb(), calendar: h.calendar, messaging: h.messaging, llm: new RuleBasedLlm(), log: silentLogger });
  try {
    const snap = await app2.runner.snapshot(workflowId);
    assert.equal(snap.waitingFor, 'patient');
    const ok = await app2.inbound.ingest({ provider: 'wa-akg', externalMessageId: 'AFTER-RESTART', fromJid: '447700900002@s.whatsapp.net', fromPhone: '+447700900002', text: 'Yes please', timestamp: new Date() }, {});
    assert.equal(ok.status, 'accepted');
    if (ok.status === 'accepted') await app2.inbound.process(ok.eventId);
    assert.equal((await testDb().query('SELECT status FROM recovery_workflows WHERE id = $1', [workflowId])).rows[0].status, 'booked');
  } finally { await app2.server.close(); }
});

test('a booking interrupted by a crash (stale calendar_pending) is reconciled without duplicates', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const offer = (await h.offers(workflowId))[0];
    const r = await h.app.booking.reserve(offer.id);
    assert.ok(r.ok);
    if (!r.ok) return;
    // Simulate: process claimed the booking and created the event, then crashed before recording anything.
    const b = (await h.db.query(`UPDATE bookings SET status = 'calendar_pending', attempts = 1, updated_at = now() - interval '10 minutes' WHERE id = $1 RETURNING *`, [r.bookingId])).rows[0];
    h.calendar.addEvent({ title: `${b.calendar_ref} · Dental cleaning · Sarah M.`, start: '2099-01-01T00:00', end: '2099-01-01T00:30' });
    h.calendar.events[h.calendar.events.length - 1].start = (await h.db.query(`SELECT to_char(starts_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD"T"HH24:MI') s FROM bookings WHERE id = $1`, [r.bookingId])).rows[0].s;
    const out = await h.app.booking.execute(r.bookingId);
    assert.equal(out.status, 'confirmed');
    assert.equal(h.calendar.createCalls, 0, 'existing event adopted');
    assert.equal(h.calendar.findByRef(b.calendar_ref).length, 1);
  } finally { await h.close(); }
});
