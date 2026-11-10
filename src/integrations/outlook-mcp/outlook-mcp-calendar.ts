// CalendarPort implemented on top of the existing outlook-calendar-lite-mcp server, over MCP.
// Verified against the server source (tools ls/rd/find/free/cr/ed/rm/rsp/cx, Portuguese tabular output):
//  - `ls` returns "id|dia|ini|fim|titulo|local|org|resp|on|rec|disp" rows, where id is the permanent Graph id
//    (requested as an immutable id). `cr` returns it as "criado:<id>|...". We persist it and edit by it.
//    The "AAR-xxxxxxxx" token in the title is the second key (it exists before the event, for idempotent retries).
//  - `ntf acao=ligar` creates or renews the Graph change-notification subscription and returns
//    "ligado:<id>|expira:<ISO UTC>". The URL and secret live in the MCP's own environment.
//  - `cr` without attendees does not require confirmation. If the server ever asks for one
//    ("CONFIRMAÇÃO NECESSÁRIA" + cf code), we surface `approval_required` and never resend with `cf`.
import { CalendarError } from '../../shared/errors.ts';
import { CALENDAR_REF_RE } from '../../shared/ids.ts';
import { addDays } from '../../shared/time.ts';
import type { CalendarEvent, CalendarListing, CalendarPort, CalendarSubscription, CreateEventInput, CreateEventResult, UpdateEventInput, UpdateEventResult } from './types.ts';
import type { McpClient } from './mcp-client.ts';

const SHOW_AS: Record<string, string> = { livre: 'free', prov: 'tentative', ocup: 'busy', fora: 'oof', remoto: 'workingElsewhere' };
const HEADER = 'id|dia|ini|fim|titulo|local|org|resp|on|rec|disp';
const MAX_CHUNK_DAYS = 7;
export const REQUIRED_TOOLS = ['ls', 'cr', 'ed'] as const;

export function classifyMcpError(text: string): CalendarError {
  const t = text.replace(/^erro:\s*/i, '');
  if (/login|token|InvalidAuth|AADSTS|unauthori[sz]ed|graph 401|graph 403|CLIENT_ID ausente|navegador/i.test(t)) return new CalendarError('auth', `calendar auth required: ${t.slice(0, 200)}`);
  if (/graph (429|500|502|503|504)|timeout|tempo esgotado|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket/i.test(t)) return new CalendarError('transient', `calendar temporarily unavailable: ${t.slice(0, 200)}`);
  if (/calendário desconhecido/i.test(t)) return new CalendarError('protocol', `clinic calendar not found: ${t.slice(0, 200)}`);
  return new CalendarError('protocol', `calendar tool error: ${t.slice(0, 200)}`);
}

/** Resolves "ter 11-10" (weekday + MM-DD, no year) to a full date inside [from, to]. */
function resolveDay(cell: string, from: string, to: string): string {
  const md = /(\d{2})-(\d{2})\s*$/.exec(cell.trim());
  if (!md) throw new CalendarError('protocol', `unexpected day cell: ${cell}`);
  for (let d = from; d <= to; d = addDays(d, 1)) if (d.slice(5) === `${md[1]}-${md[2]}`) return d;
  throw new CalendarError('protocol', `day ${cell} outside requested range ${from}..${to}`);
}

export function parseLsOutput(text: string, from: string, to: string): CalendarListing {
  const lines = text.split('\n');
  const head = lines[0] ?? '';
  if (!head.startsWith('#agenda')) throw new CalendarError('protocol', 'unexpected ls output header');
  const complete = !head.includes('+mais');
  const hi = lines.indexOf(HEADER);
  if (hi === -1) {
    if (lines.some(l => /^0 eventos$/.test(l.trim()))) return { events: [], complete };
    throw new CalendarError('protocol', 'ls output has neither table nor "0 eventos"');
  }
  const events: CalendarEvent[] = [];
  for (const row of lines.slice(hi + 1)) {
    if (!row.trim()) continue;
    const c = row.split('|');
    if (c.length < 11) throw new CalendarError('protocol', 'malformed ls row');
    // Graph ids never contain "|", so the first cell is the whole id.
    const [id, dia, ini, fim, titulo, , , , , , disp] = c;
    const date = resolveDay(dia, addDays(from, -1), addDays(to, 1));
    const allDay = ini === 'dia todo';
    const cancelled = titulo.startsWith('[cancelado]');
    const title = titulo.replace(/^\[cancelado\]\s*/, '');
    const endDate = !allDay && fim < ini ? addDays(date, 1) : date;
    events.push({
      ref: CALENDAR_REF_RE.exec(title)?.[0] ?? null,
      title,
      start: allDay ? `${date}T00:00` : `${date}T${ini}`,
      end: allDay ? `${addDays(date, 1)}T00:00` : `${endDate}T${fim}`,
      allDay,
      cancelled,
      showAs: SHOW_AS[disp] ?? 'unknown',
      graphId: id.trim(),
    });
  }
  return { events, complete };
}

export function parseCrOutput(text: string): CreateEventResult {
  if (/CONFIRMAÇÃO NECESSÁRIA|cf="/.test(text)) return { status: 'approval_required', preview: text.split('\n\n')[0].slice(0, 500) };
  const m = /^criado:([^|\s]+)/m.exec(text);
  if (m) return { status: 'created', graphId: m[1], raw: text.split('\n')[0] };
  if (/cancelado pelo usuário/.test(text)) return { status: 'approval_required', preview: 'declined by user' };
  throw new CalendarError('protocol', `unexpected cr output: ${text.slice(0, 120)}`);
}

export function parseEdOutput(text: string): UpdateEventResult {
  if (/CONFIRMAÇÃO NECESSÁRIA|cf="/.test(text)) return { status: 'approval_required', preview: text.split('\n\n')[0].slice(0, 500) };
  if (/^alterado\|/m.test(text)) return { status: 'updated' };
  if (/cancelado pelo usuário/.test(text)) return { status: 'approval_required', preview: 'declined by user' };
  throw new CalendarError('protocol', `unexpected ed output: ${text.slice(0, 120)}`);
}

export function parseNtfOutput(text: string): CalendarSubscription {
  if (/^notificações não configuradas/i.test(text)) throw new CalendarError('not_supported', 'the MCP has no notification URL/secret configured (OUTLOOK_MCP_NOTIFY_URL, OUTLOOK_MCP_NOTIFY_SECRET)');
  const m = /^ligado:([^|\s]+)\|expira:(\S+)/m.exec(text);
  const expiresAt = m ? new Date(m[2]) : null;
  if (!m || !expiresAt || Number.isNaN(expiresAt.getTime())) throw new CalendarError('protocol', `unexpected ntf output: ${text.slice(0, 120)}`);
  return { id: m[1], expiresAt };
}

export class OutlookMcpCalendar implements CalendarPort {
  readonly name = 'outlook-mcp';
  private client: McpClient;
  private calendarName: string;

  constructor(client: McpClient, calendarName: string) {
    this.client = client;
    this.calendarName = calendarName;
  }

  async capabilities(): Promise<string[]> {
    const tools = await this.client.listTools();
    const names = tools.map(t => t.name);
    const missing = REQUIRED_TOOLS.filter(t => !names.includes(t));
    if (missing.length) throw new CalendarError('not_supported', `MCP server lacks required tools: ${missing.join(', ')}`);
    return names;
  }

  async listEvents(fromDate: string, toDate: string): Promise<CalendarListing> {
    await this.capabilities();
    const events: CalendarEvent[] = [];
    let complete = true;
    for (let start = fromDate; start <= toDate; start = addDays(start, MAX_CHUNK_DAYS)) {
      const end = addDays(start, MAX_CHUNK_DAYS - 1) < toDate ? addDays(start, MAX_CHUNK_DAYS - 1) : toDate;
      const args: Record<string, unknown> = { de: start, ate: end, qtd: 100 };
      if (this.calendarName) args.calendario = this.calendarName;
      const r = await this.client.callTool('ls', args);
      if (r.isError || /^erro:/i.test(r.text)) throw classifyMcpError(r.text);
      const part = parseLsOutput(r.text, start, end);
      events.push(...part.events);
      complete &&= part.complete;
    }
    return { events, complete };
  }

  async createEvent(input: CreateEventInput): Promise<CreateEventResult> {
    await this.capabilities();
    const args: Record<string, unknown> = {
      titulo: input.title,
      inicio: input.start,
      duracao: input.durationMinutes,
      descricao: input.description,
    };
    if (this.calendarName) args.calendario = this.calendarName;
    // No `participantes`: events stay on the clinic calendar and never trigger invitation approvals.
    const r = await this.client.callTool('cr', args);
    if (r.isError || /^erro:/i.test(r.text)) throw classifyMcpError(r.text);
    return parseCrOutput(r.text);
  }

  /**
   * Edits by the stored Graph id when we have one (no listing needed). If that id is unknown to Graph, or we have
   * none, the day is listed and the row is found by our ref (or id). Edits of events without attendees need no
   * confirmation in the MCP; if it ever asks, we do not answer.
   */
  async updateEvent(input: UpdateEventInput): Promise<UpdateEventResult> {
    await this.capabilities();
    if (input.graphId) {
      const r = await this.ed(input.graphId, input);
      if (r !== 'not_found') return r;
    }
    const listing = await this.listEvents(input.date, input.date);
    const row = listing.events.find(e => !e.cancelled && (e.ref === input.ref || (!!input.graphId && e.graphId === input.graphId)));
    if (!row) return { status: 'not_found' };
    const r = await this.ed(row.graphId, input);
    return r === 'not_found' ? { status: 'not_found' } : r;
  }

  private async ed(target: string, input: UpdateEventInput): Promise<UpdateEventResult | 'not_found'> {
    const args: Record<string, unknown> = { alvo: target };
    if (input.title !== undefined) args.titulo = input.title;
    if (input.free) args.disp = 'livre';
    const r = await this.client.callTool('ed', args);
    if (r.isError || /^erro:/i.test(r.text)) {
      if (/graph 404|ErrorItemNotFound|not ?found|não encontrado/i.test(r.text)) return 'not_found';
      throw classifyMcpError(r.text);
    }
    return parseEdOutput(r.text);
  }

  /** `ntf acao=ligar`: creates the subscription or extends it. Needs no confirmation (nobody else is notified). */
  async ensureSubscription(): Promise<CalendarSubscription> {
    const names = await this.capabilities();
    if (!names.includes('ntf')) throw new CalendarError('not_supported', 'MCP server has no ntf tool (update outlook-calendar-lite-mcp)');
    const args: Record<string, unknown> = { acao: 'ligar' };
    if (this.calendarName) args.calendario = this.calendarName;
    const r = await this.client.callTool('ntf', args);
    if (r.isError || /^erro:/i.test(r.text)) {
      if (/não respondeu à validação/i.test(r.text)) throw new CalendarError('transient', 'Microsoft Graph could not validate the notification URL (is it public and pointing at this app?)');
      throw classifyMcpError(r.text);
    }
    return parseNtfOutput(r.text);
  }

  async close() { await this.client.close(); }
}
