// Deterministic stand-in for the LLM (LLM_PROVIDER=mock). No network, no cost.
// Used by automated tests, Promptfoo workflow evals without an API key, and the offline demo.
// It intentionally mimics the structured output of the real model so the whole workflow is exercised.
import { templateReply, followUpTemplate } from './guardrails.ts';
import type { FollowUp, FollowUpInput, Intent, Interpretation, InterpretInput, LlmPort, LlmResult } from './types.ts';

const DAY = /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|weekend|morning|afternoon|evening)/i;

export function classify(text: string): { intent: Intent; confidence: number; requestedDay: string | null } {
  const t = text.toLowerCase().trim();
  const day = DAY.exec(t)?.[1] ?? null;
  if (/\b(stop|unsubscribe|don'?t (message|text|contact) me|remove me from)\b/.test(t)) return { intent: 'opt_out', confidence: 0.9, requestedDay: null };
  if (/\b(already (booked|have|got|made|arranged)|booked (another|elsewhere)|found another|no longer need)\b/.test(t)) return { intent: 'already_booked', confidence: 0.9, requestedDay: null };
  if (/^(no|nope|nah)\b|no,? thanks|no thank you|not interested|can'?t make it|cannot make it|won'?t be able|i'?ll pass|not for me/.test(t)) return { intent: 'decline', confidence: 0.9, requestedDay: null };
  if (day && /\b(instead|can i|could i|is there|do you have|any|another|different|other)\b/.test(t)) return { intent: 'reschedule_request', confidence: 0.85, requestedDay: day };
  if (/^(yes|yeah|yep|yup|sure|ok(ay)?|absolutely|definitely|perfect|great|sounds good)\b|yes,? please|please book|book it|book me|i'?ll take it|that works/.test(t)) {
    return /\b(maybe|might|not sure|if |unless|but )\b/.test(t) ? { intent: 'ambiguous', confidence: 0.5, requestedDay: null } : { intent: 'accept', confidence: 0.92, requestedDay: null };
  }
  if (/\?\s*$|\b(what time|when is|where is|how long|which day|what day)\b/.test(t)) return { intent: 'question', confidence: 0.8, requestedDay: null };
  return { intent: 'ambiguous', confidence: 0.5, requestedDay: null };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Deterministic date/time extraction for the mock (the real model does this in the OpenAI adapter). */
export function extractWhen(text: string, todayIso: string): { date: string | null; time: string | null; timeOfDay: FollowUp['timeOfDay'] } {
  const t = text.toLowerCase();
  const add = (n: number) => new Date(Date.parse(todayIso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  let date: string | null = null;
  if (/\btomorrow\b/.test(t)) date = add(1);
  else if (/\btoday\b/.test(t)) date = todayIso;
  else {
    const w = WEEKDAYS.findIndex(d => new RegExp(`\\b${d}\\b`).test(t));
    if (w >= 0) { const cur = new Date(todayIso + 'T00:00:00Z').getUTCDay(); date = add(((w - cur + 7) % 7) || 7); }
  }
  let time: string | null = null;
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t);
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (ampm) { let h = Number(ampm[1]) % 12; if (ampm[3] === 'pm') h += 12; time = `${String(h).padStart(2, '0')}:${ampm[2] ?? '00'}`; }
  else if (h24) time = `${h24[1].padStart(2, '0')}:${h24[2]}`;
  const timeOfDay = /\bmorning\b/.test(t) ? 'morning' : /\bafternoon\b/.test(t) ? 'afternoon' : /\bevening\b/.test(t) ? 'evening' : null;
  return { date, time, timeOfDay };
}

export function classifyFollowUp(text: string, hasProposal = false): FollowUp['category'] {
  const t = text.toLowerCase().trim();
  if (/\bcancel/.test(t)) return 'cancel_request';
  if (/\b(reschedul\w*|move|change|another (day|time)|different (day|time)|instead|postpone|earlier|later)\b/.test(t)) return 'reschedule_request';
  if (hasProposal) {
    if (/^(yes|yeah|yep|yup|sure|ok(ay)?|confirm|please do|go ahead|perfect|great)\b/.test(t)) return 'confirm';
    if (/^(no|nope|nah)\b|never ?mind|keep (it|my)|don'?t/.test(t)) return 'reject';
    if (/\d{1,2}(:\d{2})?\s*(am|pm)|\b\d{1,2}:\d{2}\b/.test(t)) return 'reschedule_request';
    if (/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b/.test(t)) return 'reschedule_request';
  }
  if (/\b(thanks?|thank you|thx|ty|cheers|appreciate)/.test(t)) return 'thanks';
  if (/^(ok(ay)?|k|great|perfect|cool|nice|good|got it|sure|👍|🙏|👌|😊|🙂)[.! ]*$/u.test(t)) return 'acknowledgement';
  if (/\?\s*$|\b(what time|when|where|how long|address)\b/.test(t)) return 'appointment_question';
  return 'other';
}

function ruleFollowUp(input: FollowUpInput, over: Partial<FollowUp> = {}): FollowUp {
  const category = classifyFollowUp(input.message, !!input.pendingProposal);
  const todayIso = /\d{4}-\d{2}-\d{2}/.exec(input.today)?.[0] ?? new Date().toISOString().slice(0, 10);
  const when = extractWhen(input.message, todayIso);
  const shouldReply = category !== 'acknowledgement';
  const replies = ['thanks', 'appointment_question', 'other'].includes(category);
  return {
    category, shouldReply,
    reply: shouldReply && replies ? followUpTemplate(category, input) : '',
    appointmentDate: category === 'cancel_request' ? when.date : null,
    targetDate: category === 'reschedule_request' ? when.date : null,
    targetTime: category === 'reschedule_request' || category === 'confirm' ? when.time : null,
    timeOfDay: when.timeOfDay,
    ...over,
  };
}

const usage0 = { inputTokens: 0, outputTokens: 0 };

export class RuleBasedLlm implements LlmPort {
  readonly name = 'mock:rule-based';
  calls = 0;

  async interpret(input: InterpretInput): Promise<LlmResult<Interpretation>> {
    this.calls++;
    const t0 = Date.now();
    const c = classify(input.message);
    const value: Interpretation = {
      intent: c.intent,
      confidence: c.confidence,
      needsCalendarInfo: c.intent === 'reschedule_request',
      requestedDay: c.requestedDay,
      reply: templateReply(c.intent, input),
    };
    return { value, model: this.name, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, latencyMs: Date.now() - t0 };
  }

  async followUp(input: FollowUpInput): Promise<LlmResult<FollowUp>> {
    this.calls++;
    return { value: ruleFollowUp(input), model: this.name, usage: usage0, costUsd: 0, latencyMs: 0 };
  }
}

/** Test helper: an LLM whose answers are scripted per call (e.g. to simulate a model mistake). */
export class ScriptedLlm implements LlmPort {
  readonly name = 'mock:scripted';
  private queue: (Partial<Interpretation> | Error)[];
  private followUps: (Partial<FollowUp> | Error)[];
  calls = 0;
  constructor(queue: (Partial<Interpretation> | Error)[], followUps: (Partial<FollowUp> | Error)[] = []) { this.queue = [...queue]; this.followUps = [...followUps]; }
  async followUp(input: FollowUpInput): Promise<LlmResult<FollowUp>> {
    this.calls++;
    const next = this.followUps.shift() ?? {};
    if (next instanceof Error) throw next;
    return { value: ruleFollowUp(input, next), model: this.name, usage: usage0, costUsd: 0, latencyMs: 0 };
  }
  async interpret(input: InterpretInput): Promise<LlmResult<Interpretation>> {
    this.calls++;
    const next = this.queue.shift() ?? {};
    if (next instanceof Error) throw next;
    const base = classify(input.message);
    return {
      value: { intent: base.intent, confidence: base.confidence, needsCalendarInfo: false, requestedDay: null, reply: templateReply(base.intent, input), ...next },
      model: this.name, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, latencyMs: 0,
    };
  }
}
