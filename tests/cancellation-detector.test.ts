import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, IDS } from './support/harness.ts';
import { CalendarError } from '../src/shared/errors.ts';

after(closeDb);

test('a missing event is confirmed only after N consecutive successful polls, then starts one workflow', async () => {
  const h = await createHarness();
  try {
    assert.equal(h.calendar.removeByRef('AAR-a0000001'), true);
    let r = await h.app.detector.poll();
    assert.deepEqual([r.ok, r.suspected, r.confirmed.length], [true, [IDS.appt.oliverCleaning], 0]);
    r = await h.app.detector.poll();
    assert.equal(r.confirmed.length, 1);
    assert.equal(r.confirmed[0].observation, 'missing');
    assert.match(h.lastSent(IDS.phone.sarah)!, /^Hi Sarah!/);
    r = await h.app.detector.poll();
    assert.equal(r.confirmed.length, 0, 'already cancelled appointments are not re-detected');
    assert.equal((await h.db.query('SELECT count(*)::int n FROM recovery_workflows')).rows[0].n, 1);
    assert.equal((await h.db.query('SELECT source, observation FROM cancellation_events')).rows[0].observation, 'missing');
  } finally { await h.close(); }
});

test('a reappearing event resets the miss counter', async () => {
  const h = await createHarness();
  try {
    const ev = h.calendar.findByRef('AAR-a0000001')[0];
    h.calendar.removeByRef('AAR-a0000001');
    await h.app.detector.poll();
    h.calendar.addEvent(ev);
    await h.app.detector.poll();
    h.calendar.removeByRef('AAR-a0000001');
    const r = await h.app.detector.poll();
    assert.equal(r.confirmed.length, 0);
  } finally { await h.close(); }
});

test('Graph ids: stored by the calendar sync; an event whose title lost its AAR ref is still recognised', async () => {
  const h = await createHarness();
  try {
    const ev = h.calendar.findByRef('AAR-a0000001')[0];
    const stored = (await h.db.query('SELECT outlook_event_id FROM appointments WHERE id = $1', [IDS.appt.oliverCleaning])).rows[0].outlook_event_id;
    assert.equal(stored, ev.graphId, 'the sync saved the permanent id next to the ref');
    ev.title = 'Dental cleaning (renamed by staff)'; ev.ref = null;
    for (let i = 0; i < 3; i++) assert.deepEqual((await h.app.detector.poll()).suspected, [], 'matched by id, so not missing');
    assert.equal((await h.db.query('SELECT count(*)::int n FROM recovery_workflows')).rows[0].n, 0);
  } finally { await h.close(); }
});

test('an explicitly cancelled event is confirmed immediately', async () => {
  const h = await createHarness();
  try {
    h.calendar.markCancelled('AAR-a0000005');
    const r = await h.app.detector.poll();
    assert.deepEqual(r.confirmed.map(c => [c.appointmentId, c.observation]), [[IDS.appt.ethanCleaning, 'cancelled']]);
  } finally { await h.close(); }
});

test('Graph/MCP failures, auth errors and truncated listings never produce cancellations', async () => {
  const h = await createHarness();
  try {
    h.calendar.removeByRef('AAR-a0000001');
    for (const kind of ['transient', 'auth', 'timeout'] as const) {
      h.calendar.inject('list', { kind: 'error', error: new CalendarError(kind, kind) });
      const r = await h.app.detector.poll();
      assert.equal(r.ok, false);
      assert.equal(r.confirmed.length + r.suspected.length, 0);
    }
    h.calendar.inject('list', { kind: 'incomplete' }, 3);
    for (let i = 0; i < 3; i++) assert.equal((await h.app.detector.poll()).confirmed.length, 0);
    assert.equal((await h.db.query('SELECT calendar_missing_count FROM appointments WHERE id = $1', [IDS.appt.oliverCleaning])).rows[0].calendar_missing_count, 0);
    assert.equal((await h.db.query('SELECT count(*)::int n FROM recovery_workflows')).rows[0].n, 0);
  } finally { await h.close(); }
});

test('mass disappearance (wrong calendar / partial data) is treated as an anomaly', async () => {
  const h = await createHarness();
  try {
    h.calendar.events = [];
    for (let i = 0; i < 3; i++) {
      const r = await h.app.detector.poll();
      assert.equal(r.ok, false);
      assert.match(r.skippedReason!, /anomaly/);
    }
    assert.equal((await h.db.query('SELECT count(*)::int n FROM recovery_workflows')).rows[0].n, 0);
  } finally { await h.close(); }
});

test('manual trigger and polling of the same appointment start a single workflow', async () => {
  const h = await createHarness();
  try {
    const a = await h.trigger(IDS.appt.oliverCleaning);
    const b = await h.trigger(IDS.appt.oliverCleaning);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.workflowId, b.workflowId);
    h.calendar.removeByRef('AAR-a0000001');
    await h.app.detector.poll(); await h.app.detector.poll();
    assert.equal((await h.db.query('SELECT count(*)::int n FROM recovery_workflows')).rows[0].n, 1);
    assert.equal(h.sent(IDS.phone.sarah).filter(t => t.startsWith('Hi Sarah')).length, 1);
  } finally { await h.close(); }
});
