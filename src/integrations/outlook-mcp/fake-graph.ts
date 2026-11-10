// Minimal fake of the Microsoft Graph calendar endpoints used by outlook-calendar-lite-mcp.
// Purpose: run the REAL, unmodified MCP server (stdio) end-to-end without a Microsoft account,
// by pointing it at this server through its own OUTLOOK_MCP_GRAPH / OUTLOOK_MCP_AUTH variables.
// Development/test tool only; it never talks to Microsoft.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { toLocalWallClock } from '../../shared/time.ts';

interface GEvent {
  id: string;
  calendarId: string;
  subject: string;
  start: string; // local wall clock in tz, YYYY-MM-DDTHH:mm
  end: string;
  isAllDay: boolean;
  isCancelled: boolean;
  showAs: string;
  body?: string;
}

export interface GSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
  clientState: string;
  expirationDateTime: string;
}

/** How the fake reaches a notification URL (tests route it to the app in-process; there is no real HTTPS endpoint). */
export type Deliver = (url: string, body: unknown) => Promise<{ status: number; text: string }>;

export interface FakeGraph {
  port: number;
  url: string;
  events: GEvent[];
  /** Environment for spawning the real MCP against this fake (token file pre-provisioned). */
  mcpEnv: Record<string, string>;
  failNext(status: number, times?: number): void;
  removeBySubjectToken(token: string): number;
  cancelBySubjectToken(token: string): number;
  addEvent(subject: string, start: string, end: string, calendarId?: string): GEvent;
  /** Change-notification subscriptions created through POST /subscriptions. */
  subscriptions: GSubscription[];
  /** Deletes the events whose subject has the token and sends the "deleted" notifications, like Graph does. */
  deleteBySubjectToken(token: string): Promise<number>;
  close(): Promise<void>;
}

const ACCESS_TOKEN = 'fake-graph-access-token';

export async function startFakeGraph(opts: { timezone: string; calendarName: string; port?: number; deliver?: Deliver }): Promise<FakeGraph> {
  const tz = opts.timezone;
  const calendars = [
    { id: 'cal-default', name: 'Calendar', isDefaultCalendar: true },
    { id: 'cal-clinic', name: opts.calendarName || 'Bright Smile Clinic', isDefaultCalendar: false },
  ];
  const events: GEvent[] = [];
  let faults: number[] = [];
  const subscriptions: GSubscription[] = [];
  const publicSub = (s: GSubscription) => ({ ...s, clientState: null });
  const notify = async (changeType: string, e: GEvent) => {
    for (const s of subscriptions) {
      if (s.resource.toLowerCase() !== `me/calendars/${e.calendarId}/events`.toLowerCase() || !s.changeType.split(',').includes(changeType)) continue;
      await opts.deliver?.(s.notificationUrl, { value: [{
        subscriptionId: s.id, subscriptionExpirationDateTime: s.expirationDateTime, clientState: s.clientState, changeType,
        resource: `Users/fake-user/Events/${e.id}`, tenantId: 'fake-tenant',
        resourceData: { '@odata.type': '#Microsoft.Graph.Event', '@odata.id': `Users/fake-user/Events/${e.id}`, id: e.id },
      }] });
    }
  };

  const toGraph = (e: GEvent) => ({
    id: e.id, subject: e.subject, type: 'singleInstance', isAllDay: e.isAllDay, isCancelled: e.isCancelled, showAs: e.showAs,
    start: { dateTime: `${e.start}:00.0000000`, timeZone: tz }, end: { dateTime: `${e.end}:00.0000000`, timeZone: tz },
    isOrganizer: true, organizer: { emailAddress: { name: 'Clinic', address: 'clinic@example.test' } },
    responseStatus: { response: 'organizer' }, attendees: [], location: { displayName: '' }, isOnlineMeeting: false,
    body: { contentType: 'text', content: e.body ?? '' },
  });
  const newId = () => 'AAMkFAKE' + randomBytes(48).toString('base64url');

  const srv: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    let raw = '';
    for await (const c of req) raw += c;
    const send = (status: number, body: unknown) => {
      if (body === null) { res.writeHead(status, { 'content-length': '0' }); res.end(); return; }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // OAuth endpoints are never needed (token file is pre-provisioned) but answer refreshes anyway.
    if (url.pathname.endsWith('/token')) return send(200, { access_token: ACCESS_TOKEN, refresh_token: 'fake-rt', expires_in: 3600 });
    if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return send(401, { error: { code: 'InvalidAuthenticationToken', message: 'bad token' } });
    if (faults.length) {
      const status = faults.shift()!;
      return send(status, { error: { code: 'FakeFault', message: `injected ${status}` } });
    }
    const p = url.pathname.replace(/^\/v1\.0/, '');
    const q = url.searchParams;
    const body = raw ? JSON.parse(raw) : undefined;
    let m: RegExpMatchArray | null;

    if (req.method === 'GET' && p === '/me') return send(200, { displayName: 'Bright Smile Clinic (fake)', mail: 'clinic@example.test' });
    if (req.method === 'GET' && p === '/me/mailboxSettings') return send(200, { timeZone: tz, workingHours: { daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startTime: '08:00:00.0000000', endTime: '18:00:00.0000000' } });
    if (req.method === 'GET' && p === '/me/calendars') return send(200, { value: calendars.map(c => ({ ...c, canEdit: true, owner: { address: 'clinic@example.test' } })) });
    if (req.method === 'GET' && (m = p.match(/^\/me(?:\/calendar|\/calendars\/([^/]+))$/))) {
      const c = calendars.find(x => (m![1] ? x.id === m![1] : x.isDefaultCalendar));
      return c ? send(200, c) : send(404, { error: { code: 'ErrorItemNotFound', message: 'calendar not found' } });
    }
    if (req.method === 'GET' && p === '/subscriptions') return send(200, { value: subscriptions.map(publicSub) });
    if (req.method === 'POST' && p === '/subscriptions') {
      // Like Graph: the notification URL must echo a validation token before the subscription exists.
      if (opts.deliver) {
        const token = randomBytes(12).toString('hex');
        const u = new URL(String(body?.notificationUrl)); u.searchParams.set('validationToken', token);
        const r = await opts.deliver(u.toString(), undefined).catch(() => ({ status: 0, text: '' }));
        if (r.status !== 200 || r.text !== token) return send(400, { error: { code: 'ValidationError', message: 'Subscription validation request failed. Notification endpoint must respond with 200 OK to validation request.' } });
      }
      const s: GSubscription = { id: 'sub-' + randomBytes(6).toString('hex'), resource: String(body?.resource), changeType: String(body?.changeType), notificationUrl: String(body?.notificationUrl), lifecycleNotificationUrl: body?.lifecycleNotificationUrl, clientState: String(body?.clientState ?? ''), expirationDateTime: String(body?.expirationDateTime) };
      subscriptions.push(s);
      return send(201, publicSub(s));
    }
    if ((m = p.match(/^\/subscriptions\/([^/]+)$/))) {
      const s = subscriptions.find(x => x.id === m![1]);
      if (!s) return send(404, { error: { code: 'ResourceNotFound', message: 'subscription not found' } });
      if (req.method === 'PATCH') { s.expirationDateTime = String(body?.expirationDateTime); return send(200, publicSub(s)); }
      if (req.method === 'DELETE') { subscriptions.splice(subscriptions.indexOf(s), 1); return send(204, null); }
    }
    if (req.method === 'GET' && (m = p.match(/^\/me(?:\/calendar|\/calendars\/([^/]+))\/calendarView$/))) {
      const calId = m[1] ?? 'cal-default';
      const from = toLocalWallClock(new Date(q.get('startDateTime')!), tz);
      const to = toLocalWallClock(new Date(q.get('endDateTime')!), tz);
      const top = Number(q.get('$top') ?? 100), skip = Number(q.get('$skip') ?? 0);
      const list = events.filter(e => e.calendarId === calId && e.start < to && e.end > from).sort((a, b) => a.start.localeCompare(b.start));
      const page = list.slice(skip, skip + top);
      const next = skip + top < list.length ? (() => { const u = new URL(`http://127.0.0.1:${port}${req.url}`); u.searchParams.set('$skip', String(skip + top)); return u.toString(); })() : undefined;
      return send(200, { value: page.map(toGraph), ...(next ? { '@odata.nextLink': next } : {}) });
    }
    if (req.method === 'POST' && (m = p.match(/^\/me(?:\/calendar|\/calendars\/([^/]+))\/events$/))) {
      const e: GEvent = {
        id: newId(), calendarId: m[1] ?? 'cal-default', subject: String(body?.subject ?? ''),
        start: String(body?.start?.dateTime ?? '').slice(0, 16), end: String(body?.end?.dateTime ?? '').slice(0, 16),
        isAllDay: !!body?.isAllDay, isCancelled: false, showAs: body?.showAs ?? 'busy', body: body?.body?.content,
      };
      events.push(e);
      return send(201, toGraph(e));
    }
    if ((m = p.match(/^\/me\/events\/([^/]+)$/))) {
      const e = events.find(x => x.id === m![1]);
      if (!e) return send(404, { error: { code: 'ErrorItemNotFound', message: 'not found' } });
      if (req.method === 'GET') return send(200, toGraph(e));
      if (req.method === 'PATCH') {
        if (body?.subject !== undefined) e.subject = String(body.subject);
        if (body?.showAs !== undefined) e.showAs = String(body.showAs);
        if (body?.start?.dateTime) e.start = String(body.start.dateTime).slice(0, 16);
        if (body?.end?.dateTime) e.end = String(body.end.dateTime).slice(0, 16);
        return send(200, toGraph(e));
      }
      if (req.method === 'DELETE') { events.splice(events.indexOf(e), 1); return send(204, null); }
    }
    return send(404, { error: { code: 'NoRoute', message: `${req.method} ${p}` } });
  });

  await new Promise<void>(r => srv.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  const home = mkdtempSync(join(tmpdir(), 'aar-fake-graph-'));
  writeFileSync(join(home, 'default.json'), JSON.stringify({ at: ACCESS_TOKEN, exp: Date.now() + 365 * 86400000, rt: 'fake-rt' }), { mode: 0o600 });

  return {
    port, url, events, subscriptions,
    mcpEnv: {
      OUTLOOK_MCP_CLIENT_ID: 'fake-client-id',
      OUTLOOK_MCP_GRAPH: `${url}/v1.0`,
      OUTLOOK_MCP_AUTH: url,
      OUTLOOK_MCP_HOME: home,
      OUTLOOK_MCP_TZ: tz,
      OUTLOOK_MCP_OPEN: 'test',
    },
    failNext(status, times = 1) { for (let i = 0; i < times; i++) faults.push(status); },
    removeBySubjectToken(token) { const n = events.length; for (let i = events.length - 1; i >= 0; i--) if (events[i].subject.includes(token)) events.splice(i, 1); return n - events.length; },
    async deleteBySubjectToken(token) {
      const gone = events.filter(e => e.subject.includes(token));
      for (const e of gone) { events.splice(events.indexOf(e), 1); await notify('deleted', e); }
      return gone.length;
    },
    cancelBySubjectToken(token) { let n = 0; for (const e of events) if (e.subject.includes(token)) { e.isCancelled = true; n++; } return n; },
    addEvent(subject, start, end, calendarId = 'cal-clinic') { const e: GEvent = { id: newId(), calendarId, subject, start, end, isAllDay: false, isCancelled: false, showAs: 'busy' }; events.push(e); return e; },
    close: () => new Promise<void>(r => { faults = []; srv.close(() => r()); srv.closeAllConnections?.(); }),
  };
}
