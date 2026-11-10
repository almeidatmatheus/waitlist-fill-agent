// Fastify HTTP API. Public: GET /health, the HMAC-authenticated WA-AKG webhook and the Microsoft Graph
// notification webhook (authenticated by the clientState secret).
// Everything else requires the admin bearer token; /dev/* additionally exists only in development/test.
// Responses never include phone numbers, JIDs or message bodies; names are masked ("Sarah M.").
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { devEndpointsEnabled } from '../config/env.ts';
import { ValidationError, errMsg } from '../shared/errors.ts';
import { asObj, isUuid, optBool, reqEnum, reqStr, reqUuid } from '../shared/validation.ts';
import { formatDisplay } from '../shared/time.ts';
import { parseWaAkgWebhook, verifySignature, buildWaAkgWebhook, signBody } from '../integrations/wa-akg/webhook.ts';
import { MockCalendar } from '../integrations/outlook-mcp/mock-calendar.ts';
import { MockMessaging } from '../integrations/wa-akg/mock-messaging.ts';
import { maskPhone } from '../shared/logger.ts';
import { maskedName } from '../services/templates.ts';
import type { App } from '../app.ts';

declare module 'fastify' {
  interface FastifyRequest { rawBody?: Buffer }
}

export function buildServer(app: App): FastifyInstance {
  const { cfg, db, log } = app;
  const f = Fastify({ logger: false, bodyLimit: 256 * 1024, routerOptions: { ignoreTrailingSlash: true } });

  // Keep the raw body: WA-AKG signs the exact bytes.
  f.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try { done(null, JSON.parse(body.toString('utf8'))); } catch { const e = new Error('invalid JSON') as Error & { statusCode: number }; e.statusCode = 400; done(e, undefined); }
  });

  f.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (code >= 500) log.error('http.error', { path: req.url, error: errMsg(err) });
    return reply.code(code).send({ error: code >= 500 ? 'internal error' : err.message });
  });

  const token = Buffer.from(cfg.adminApiToken);
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization ?? '';
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (got.length !== token.length || !timingSafeEqual(got, token)) return reply.code(401).send({ error: 'unauthorized' });
  };
  const requireDev = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!devEndpointsEnabled(cfg)) return reply.code(404).send({ error: 'not found' });
    return requireAdmin(req, reply);
  };

  // ---------------------------------------------------------------- public
  f.get('/health', async (_req, reply) => {
    let dbOk = false;
    try { await db.query('SELECT 1'); dbOk = true; } catch { /* reported below */ }
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'up' : 'down',
      calendar: app.calendar.name, calendarNotifications: app.notifications.status(), messaging: app.messagingPort.name, llm: app.llm.name, env: cfg.nodeEnv,
    });
  });

  f.post('/webhooks/wa-akg', async (req, reply) => {
    if (!verifySignature(cfg.messaging.webhookSecret, req.rawBody ?? Buffer.alloc(0), req.headers['x-webhook-signature'] as string | undefined)) {
      log.warn('webhook.bad_signature', { ip: req.ip });
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const parsed = parseWaAkgWebhook(req.body, cfg.messaging.sessionId);
    if (parsed.kind === 'ignored') {
      if (parsed.externalMessageId) await app.inbound.recordIgnored('wa-akg', parsed.externalMessageId, parsed.reason);
      log.info('webhook.ignored', { reason: parsed.reason });
      return reply.code(200).send({ status: 'ignored', reason: parsed.reason });
    }
    const r = await app.inbound.ingest(parsed.message, req.body);
    if (r.status === 'duplicate') return reply.code(200).send({ status: 'duplicate' });
    app.tasks.run(() => app.inbound.process(r.eventId));
    return reply.code(202).send({ status: 'accepted', correlationId: r.correlationId });
  });

  // Microsoft Graph change notifications (and lifecycle notifications) for the clinic calendar.
  f.post('/webhooks/graph', async (req, reply) => {
    if (!app.notifications.enabled) return reply.code(404).send({ error: 'not found' });
    // Subscription handshake: Graph expects the token back as plain text within 10 seconds.
    const vt = (req.query as { validationToken?: unknown }).validationToken;
    if (typeof vt === 'string') return reply.code(200).header('content-type', 'text/plain; charset=utf-8').header('x-content-type-options', 'nosniff').send(vt);
    const r = app.notifications.receive(req.body);
    if (r.malformed) return reply.code(400).send({ error: 'invalid notification' });
    if (!r.accepted) { log.warn('graph_webhook.bad_client_state', { ip: req.ip }); return reply.code(401).send({ error: 'invalid clientState' }); }
    return reply.code(202).send({ status: 'accepted' });
  });

  // ---------------------------------------------------------------- admin (read-only views, masked)
  f.get('/appointments', { preHandler: requireAdmin }, async () => {
    const r = await db.query(
      `SELECT a.id, p.full_name, t.name AS treatment, a.starts_at, a.ends_at, a.status, a.source, a.calendar_ref, a.outlook_event_id IS NOT NULL AS has_graph_id
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN treatments t ON t.id = a.treatment_id ORDER BY a.starts_at`,
    );
    return { timezone: cfg.clinic.timezone, appointments: r.rows.map(x => ({
      id: x.id, patient: maskedName(x.full_name), treatment: x.treatment, startsAt: x.starts_at, endsAt: x.ends_at,
      local: formatDisplay(x.starts_at, cfg.clinic.timezone), status: x.status, source: x.source, calendarRef: x.calendar_ref, hasGraphId: x.has_graph_id,
    })) };
  });

  f.get('/waitlist', { preHandler: requireAdmin }, async () => {
    const r = await db.query(
      `SELECT w.id, p.full_name, p.contact_allowed, t.name AS treatment, w.preferred_start, w.preferred_end, w.status, w.created_at
         FROM waitlist w JOIN patients p ON p.id = w.patient_id JOIN treatments t ON t.id = w.treatment_id ORDER BY w.created_at`,
    );
    return { waitlist: r.rows.map(x => ({
      id: x.id, patient: maskedName(x.full_name), contactAllowed: x.contact_allowed, treatment: x.treatment,
      preferredStart: x.preferred_start, preferredEnd: x.preferred_end, status: x.status, waitingSince: x.created_at,
    })) };
  });

  f.get('/workflows', { preHandler: requireAdmin }, async () => {
    const r = await db.query(
      `SELECT w.id, w.status, w.current_state, w.slot_reference, w.starts_at, t.name AS treatment, w.last_error, w.created_at, w.updated_at,
              (SELECT count(*) FROM appointment_offers o WHERE o.workflow_id = w.id)::int AS offers,
              (SELECT count(*) FROM human_handoffs h WHERE h.workflow_id = w.id AND h.status = 'open')::int AS open_handoffs
         FROM recovery_workflows w JOIN treatments t ON t.id = w.treatment_id ORDER BY w.created_at DESC LIMIT 100`,
    );
    return { workflows: r.rows.map(x => ({ ...x, local: formatDisplay(x.starts_at, cfg.clinic.timezone) })) };
  });

  f.get('/workflows/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid id' });
    const w = await db.query('SELECT * FROM recovery_workflows WHERE id = $1', [id]);
    if (!w.rowCount) return reply.code(404).send({ error: 'not found' });
    const [offers, events, bookings, handoffs] = await Promise.all([
      db.query(`SELECT o.id, p.full_name, o.status, o.expires_at, o.created_at, o.responded_at FROM appointment_offers o JOIN patients p ON p.id = o.patient_id WHERE o.workflow_id = $1 ORDER BY o.created_at`, [id]),
      db.query(`SELECT id, event_type, payload, created_at FROM workflow_events WHERE workflow_id = $1 ORDER BY id`, [id]),
      db.query(`SELECT id, offer_id, status, attempts, calendar_ref, appointment_id, last_error FROM bookings WHERE workflow_id = $1 ORDER BY created_at`, [id]),
      db.query(`SELECT id, reason, status, notified, created_at FROM human_handoffs WHERE workflow_id = $1 ORDER BY created_at`, [id]),
    ]);
    const graph = await app.runner.snapshot(id).catch(() => null);
    return {
      workflow: { ...w.rows[0], lease_owner: undefined },
      graph: graph ? { state: graph.values.status, next: graph.next, waitingFor: graph.waitingFor, outcome: graph.values.outcome, llmCalls: graph.values.llmCalls, inputTokens: graph.values.inputTokens, outputTokens: graph.values.outputTokens } : null,
      offers: offers.rows.map(o => ({ ...o, full_name: undefined, patient: maskedName(o.full_name) })),
      bookings: bookings.rows, handoffs: handoffs.rows, events: events.rows,
    };
  });

  f.post('/workflows/:id/handoff-decision', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid id' });
    const body = asObj(req.body, 'body');
    const decision = reqEnum(body, 'decision', ['offer_next', 'close'] as const);
    const snap = await app.runner.snapshot(id);
    // With an offer cascade a handoff for one patient does not stop the offers to the others, so the
    // workflow can be waiting for patients and for a staff decision at the same time.
    if (snap.waitingFor !== 'human' && !(snap.waitingFor === 'patient' && snap.values.handoffOpen)) return reply.code(409).send({ error: 'workflow is not waiting for a human decision' });
    const r = await app.runner.resume(id, { type: 'staff_decision', decision, correlationId: `staff-${Date.now()}` });
    return { workflowId: id, state: r.state.status, waitingFor: r.waitingFor, outcome: r.state.outcome };
  });

  // ---------------------------------------------------------------- development only
  f.post('/dev/trigger-cancellation', { preHandler: requireDev }, async req => {
    const body = asObj(req.body, 'body');
    const appointmentId = reqUuid(body, 'appointmentId');
    const removeFromCalendar = optBool(body, 'removeFromCalendar') ?? false;
    if (removeFromCalendar && app.calendarImpl instanceof MockCalendar) {
      const ref = (await db.query('SELECT calendar_ref FROM appointments WHERE id = $1', [appointmentId])).rows[0]?.calendar_ref;
      if (ref) app.calendarImpl.removeByRef(ref);
    }
    const r = await app.runner.startForCancellation({ appointmentId, source: 'manual', observation: 'manual', details: { via: 'dev endpoint' } });
    const wf = (await db.query('SELECT status, current_state FROM recovery_workflows WHERE id = $1', [r.workflowId])).rows[0];
    return { workflowId: r.workflowId, created: r.created, status: wf.status, state: wf.current_state, waitingFor: r.result?.waitingFor ?? null };
  });

  f.post('/dev/poll-cancellations', { preHandler: requireDev }, async () => app.detector.poll());
  f.post('/dev/sweep', { preHandler: requireDev }, async () => app.sweeper.sweep());

  // Simulates WA-AKG delivering a patient reply (signed exactly like the real gateway). Mock messaging only.
  f.post('/dev/simulate-inbound', { preHandler: requireDev }, async (req, reply) => {
    if (cfg.messaging.provider !== 'mock') return reply.code(409).send({ error: 'only available with MESSAGING_PROVIDER=mock' });
    const body = asObj(req.body, 'body');
    const phone = reqStr(body, 'phone', 'body', 20);
    const text = reqStr(body, 'text', 'body', 2000);
    const messageId = typeof body.messageId === 'string' ? body.messageId : `SIM${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const payload = JSON.stringify(buildWaAkgWebhook({ sessionId: cfg.messaging.sessionId, messageId, fromJid: `${phone.replace(/\D/g, '')}@s.whatsapp.net`, text }));
    const res = await f.inject({ method: 'POST', url: '/webhooks/wa-akg', payload, headers: { 'content-type': 'application/json', 'x-webhook-signature': signBody(cfg.messaging.webhookSecret, payload) } });
    await app.tasks.idle();
    return { webhookStatus: res.statusCode, webhook: res.json(), messageId };
  });

  f.get('/dev/outbox', { preHandler: requireDev }, async (_req, reply) => {
    if (!(app.messagingImpl instanceof MockMessaging)) return reply.code(409).send({ error: 'only available with MESSAGING_PROVIDER=mock' });
    return { messages: app.messagingImpl.sent.map(m => ({ to: maskPhone(m.to.phoneNumber), text: m.text, at: m.at })) };
  });

  f.get('/dev/calendar', { preHandler: requireDev }, async (_req, reply) => {
    if (!(app.calendarImpl instanceof MockCalendar)) return reply.code(409).send({ error: 'only available with CALENDAR_PROVIDER=mock' });
    return { events: app.calendarImpl.events };
  });

  return f;
}
