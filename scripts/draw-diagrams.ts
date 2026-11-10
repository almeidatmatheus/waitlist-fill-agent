// Draws the README architecture diagrams as hand-laid-out SVGs (light + dark), so boxes and arrows sit
// exactly where they should instead of wherever an auto-layout puts them.
//   node scripts/draw-diagrams.ts   -> docs/img/architecture[-dark].svg, docs/img/recovery-workflow[-dark].svg
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Mode = 'light' | 'dark';
const T = {
  light: { bg: '#fcfcfb', text: '#0b0b0b', text2: '#52514e', line: '#8a8984', box: '#ffffff', stroke: '#d6d5d0', group: '#f4f3ef', groupStroke: '#cfcec8',
    accent: '#2a78d6', accentFill: '#edf4fd', ext: '#faf6ee', extStroke: '#d8cdb6', good: '#1baf7a', goodFill: '#e9f7f1', warn: '#eb6834', warnFill: '#fdf0ea' },
  dark: { bg: '#1a1a19', text: '#f0efec', text2: '#c3c2b7', line: '#8d8c85', box: '#242422', stroke: '#3d3c38', group: '#1f1f1d', groupStroke: '#3a3935',
    accent: '#3987e5', accentFill: '#1c2735', ext: '#25221d', extStroke: '#4a4336', good: '#199e70', goodFill: '#18281f', warn: '#d95926', warnFill: '#2c1f19' },
};
type Kind = 'box' | 'accent' | 'ext' | 'good' | 'warn';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Svg {
  parts: string[] = [];
  w: number; h: number; m: Mode;
  constructor(w: number, h: number, m: Mode) { this.w = w; this.h = h; this.m = m; }
  get t() { return T[this.m]; }
  group(x: number, y: number, w: number, h: number, title: string, accent = false) {
    const t = this.t;
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${accent ? t.accentFill : t.group}" stroke="${accent ? t.accent : t.groupStroke}" stroke-width="${accent ? 1.5 : 1}"/>`);
    this.parts.push(`<text x="${x + 14}" y="${y + 22}" font-size="12.5" font-weight="600" fill="${accent ? t.accent : t.text2}">${esc(title)}</text>`);
  }
  label(x: number, y: number, s: string, o: { anchor?: string; size?: number; weight?: number; color?: string } = {}) {
    this.parts.push(`<text x="${x}" y="${y}" font-size="${o.size ?? 11.5}" font-weight="${o.weight ?? 400}" fill="${o.color ?? this.t.text2}" text-anchor="${o.anchor ?? 'middle'}">${esc(s)}</text>`);
  }
  /** Box with a bold title and optional muted lines, centred. */
  box(x: number, y: number, w: number, h: number, title: string, lines: string[] = [], kind: Kind = 'box') {
    const t = this.t;
    const fill = { box: t.box, accent: t.accentFill, ext: t.ext, good: t.goodFill, warn: t.warnFill }[kind];
    const stroke = { box: t.stroke, accent: t.accent, ext: t.extStroke, good: t.good, warn: t.warn }[kind];
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`);
    const total = 17 + lines.length * 15, top = y + (h - total) / 2 + 13;
    this.parts.push(`<text x="${x + w / 2}" y="${top}" font-size="13" font-weight="600" fill="${t.text}" text-anchor="middle">${esc(title)}</text>`);
    lines.forEach((l, i) => this.parts.push(`<text x="${x + w / 2}" y="${top + 17 + i * 15}" font-size="11.5" fill="${t.text2}" text-anchor="middle">${esc(l)}</text>`));
  }
  /** Orthogonal arrow through the given points; optional label at a point. */
  arrow(pts: [number, number][], label?: { text: string; x: number; y: number; anchor?: string }, o: { dashed?: boolean; both?: boolean } = {}) {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
    this.parts.push(`<path d="${d}" fill="none" stroke="${this.t.line}" stroke-width="1.4"${o.dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#ah)"${o.both ? ' marker-start="url(#ah)"' : ''}/>`);
    if (label) {
      const pad = 4, w = label.text.length * 6.1 + pad * 2, ax = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - w : label.x - w / 2;
      this.parts.push(`<rect x="${ax}" y="${label.y - 11}" width="${w}" height="16" rx="3" fill="${this.t.bg}" opacity="0.92"/>`);
      this.label(label.anchor === 'start' ? label.x + pad : label.anchor === 'end' ? label.x - pad : label.x, label.y + 1, label.text, { anchor: label.anchor ?? 'middle', size: 11 });
    }
  }
  render(title: string) {
    const t = this.t;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.w} ${this.h}" width="${this.w}" height="${this.h}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.line}"/></marker></defs>
<rect width="100%" height="100%" fill="${t.bg}"/>
${this.parts.join('\n')}
</svg>`;
  }
}

// ------------------------------------------------------------------ 1. system architecture
function architecture(m: Mode) {
  const s = new Svg(860, 720, m);
  const L = 20, R = 560;                 // app container
  const c1 = 38, c2 = 300, cw = 242;     // two inner columns
  const sec = (y: number, t: string) => s.label(c1, y, t, { anchor: 'start', size: 10.5, weight: 600 });

  s.group(L, 20, R - L, 560, 'waitlist-fill-agent  (Node.js, TypeScript, Fastify)', true);

  // Row 1: what starts work. Each trigger sits above the workflow it feeds.
  sec(64, 'TRIGGERS');
  s.box(c1, 74, 116, 64, 'Detector', ['lists the calendar:', 'notice or timer']);
  s.box(c1 + 126, 74, 116, 64, 'Sweeper', ['expiry, retries,', 'reconciliation']);
  s.box(c2, 74, cw, 64, 'Inbound webhook', ['HMAC check, dedup, routing']);

  // Row 2: the two LangGraph graphs
  s.box(c1, 214, cw, 92, 'Recovery workflow', ['LangGraph, one thread per freed slot:', 'find patient → offer → book']);
  s.box(c2, 214, cw, 92, 'Patient assistant', ['LangGraph function-calling agent:', 'cancel, reschedule, questions']);
  s.arrow([[c1 + 58, 138], [c1 + 58, 214]], { text: 'starts', x: c1 + 58, y: 178 });
  s.arrow([[c1 + 184, 138], [c1 + 184, 214]], { text: 'resumes', x: c1 + 184, y: 178 });
  s.arrow([[c2 + 170, 138], [c2 + 170, 214]], { text: 'anything else', x: c2 + 170, y: 178 });
  s.arrow([[c2 + 40, 138], [c2 + 40, 162], [c2 - 32, 162], [c2 - 32, 214]]);
  s.label(c2 + 48, 166, 'reply to an offer', { anchor: 'start', size: 11 });

  // Row 3: one layer used by both graphs
  sec(332, 'DECISIONS AND RULES');
  s.parts.push(`<rect x="${c1 - 6}" y="340" width="${R - L - 24}" height="222" rx="10" fill="none" stroke="${s.t.groupStroke}" stroke-dasharray="4 4"/>`);
  s.arrow([[c1 + cw - 30, 306], [c1 + cw - 30, 340]]);
  s.arrow([[c2 + cw / 2, 306], [c2 + cw / 2, 340]]);
  s.box(c1, 352, cw, 198, 'Deterministic core', ['eligibility and priority', 'availability (live calendar)', 'booking state machine', 'confirmation gate', 'guardrails, human handoff']);
  s.box(c2, 352, cw, 62, 'Language decisions', ['what does the patient mean? a clear yes?']);
  s.box(c2, 424, cw, 56, 'LLM', ['agent reasoning and replies; Jev fallback']);
  s.box(c2, 494, cw, 56, 'Jev', ['fast typed decisions with confidence'], 'good');

  // Right column: the outside world
  const X = 640, W = 200;
  s.box(X, 60, W, 56, 'Patient', ['WhatsApp on a phone'], 'ext');
  s.box(X, 160, W, 80, 'WA-AKG gateway', ['WhatsApp REST API', '+ signed webhooks'], 'ext');
  s.arrow([[X + W / 2, 116], [X + W / 2, 160]], undefined, { both: true });
  s.arrow([[X, 180], [600, 180], [600, 106], [c2 + cw, 106]], { text: 'webhook', x: 600, y: 146 });
  s.arrow([[c2 + cw, 226], [X, 226]], { text: 'send', x: 591, y: 220 });
  s.box(X, 424, W, 56, 'OpenAI API', ['OPENAI_MODEL'], 'ext');
  s.box(X, 494, W, 56, 'TypeSafe Jev API', ['System One'], 'ext');
  s.arrow([[c2 + cw, 452], [X, 452]]);
  s.arrow([[c2 + cw, 522], [X, 522]]);

  // Bottom: calendar and database
  s.box(c1, 630, cw, 64, 'Outlook calendar', ['via outlook-calendar-lite-mcp (ls, cr, ed, ntf)'], 'ext');
  s.box(c2, 630, cw, 64, 'PostgreSQL', ['business data + LangGraph checkpoints'], 'ext');
  s.arrow([[c1 + cw / 2, 550], [c1 + cw / 2, 630]], { text: 'MCP', x: c1 + cw / 2 + 24, y: 608 });
  s.arrow([[c2 + cw / 2, 580], [c2 + cw / 2, 630]], { text: 'all state', x: c2 + cw / 2 + 36, y: 608 });
  // Microsoft Graph change notifications: Outlook tells the detector that something changed.
  s.arrow([[c1 + 20, 630], [c1 + 20, 598], [27, 598], [27, 106], [c1, 106]], { text: 'change notice', x: c1 + 66, y: 612 });
  return s.render('System architecture of waitlist-fill-agent');
}

// ------------------------------------------------------------------ 2. recovery workflow
function workflow(m: Mode) {
  const s = new Svg(1000, 720, m);
  const X = 330, W = 300, H = 50, cx = X + W / 2;
  const steps: [string, string[], Kind?][] = [
    ['Slot freed', ['a cancellation was detected in Outlook']],
    ['Pick the next eligible patient', ['waiting list: treatment, window, priority, consent']],
    ['Offer the slot on WhatsApp', ['up to OFFER_CASCADE_SIZE patients, first yes wins']],
    ['Wait for the reply', ['paused + checkpointed: survives restarts'], 'accent'],
    ['Understand the reply', ['guardrails → Jev → LLM fallback']],
    ['Check the slot is still free', ['live calendar via MCP']],
    ['Book in Outlook', ['booking state machine, idempotent']],
    ['Verify, then confirm to patient', ['only after the event is in the calendar'], 'good'],
  ];
  const y = (i: number) => 40 + i * 86;
  steps.forEach(([t, l, k], i) => s.box(X, y(i), W, H, `${i + 1}. ${t}`, l, k ?? 'box'));
  for (let i = 0; i < steps.length - 1; i++) s.arrow([[cx, y(i) + H], [cx, y(i + 1)]]);
  s.label(cx + 8, y(4) - 14, 'reply arrives (resume)', { anchor: 'start', size: 11 });
  s.label(cx + 8, y(5) - 14, 'yes', { anchor: 'start', size: 11 });

  // Left: loops back
  s.box(70, y(4) - 50, 200, 44, 'Ask a clarifying question', ['max 2 turns']);
  s.arrow([[X, y(4) + 16], [170, y(4) + 16], [170, y(4) - 6]]);
  s.label(X - 8, y(4) + 10, 'question / unclear', { anchor: 'end', size: 11 });
  s.arrow([[170, y(4) - 50], [170, y(3) + 25], [X, y(3) + 25]]);
  s.arrow([[X, y(4) + 38], [36, y(4) + 38], [36, y(1) + 25], [X, y(1) + 25]]);
  s.label(48, y(2) + 4, 'declined, no reply in time,', { anchor: 'start', size: 11 });
  s.label(48, y(2) + 20, 'or not delivered:', { anchor: 'start', size: 11 });
  s.label(48, y(2) + 36, 'offer the next patient', { anchor: 'start', size: 11, weight: 600, color: s.t.text });

  // Right: exits
  const RX = 700, RW = 270;
  s.box(RX, y(1), RW, H, 'End: nobody eligible', ['slot stays free'], 'warn');
  s.arrow([[X + W, y(1) + 25], [RX, y(1) + 25]]);
  s.box(RX, y(4), RW, H, 'Hand off to clinic staff', ['symptoms, asks for a person, too many turns'], 'warn');
  s.arrow([[X + W, y(4) + 25], [RX, y(4) + 25]]);
  s.box(RX, y(5), RW, H, 'End: slot was taken', ['patient is told, nothing booked'], 'warn');
  s.arrow([[X + W, y(5) + 25], [RX, y(5) + 25]]);
  s.box(RX, y(6), RW, H, 'Outcome unknown → reconcile', ['find the event by ref, then retry or finish'], 'box');
  s.arrow([[X + W, y(6) + 18], [RX, y(6) + 18]]);
  s.arrow([[RX, y(6) + 36], [X + W, y(6) + 36]]);
  s.label(RX + RW / 2, y(6) + H + 18, 'MCP asks for approval → hand off', { size: 11 });
  return s.render('Recovery workflow: one LangGraph thread per freed slot');
}

const root = join(import.meta.dirname, '..');
mkdirSync(join(root, 'docs/img'), { recursive: true });
for (const m of ['light', 'dark'] as const) {
  const sfx = m === 'dark' ? '-dark' : '';
  writeFileSync(join(root, `docs/img/architecture${sfx}.svg`), architecture(m));
  writeFileSync(join(root, `docs/img/recovery-workflow${sfx}.svg`), workflow(m));
}
console.log('wrote docs/img/architecture*.svg, docs/img/recovery-workflow*.svg');
