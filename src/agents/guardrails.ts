// Deterministic guardrails around the LLM:
//  - pre-classification of clinical/emergency language and explicit human requests (never left to the model alone)
//  - prompt-injection heuristics (an "accept" from a suspicious message is downgraded to "ambiguous")
//  - runtime validation of the model output and of any reply text before it is sent to a patient
import { INTENTS, FOLLOW_UP_CATEGORIES, type Interpretation, type Intent, type InterpretInput, type FollowUp, type FollowUpInput } from './types.ts';
import { isObj } from '../shared/validation.ts';

const CLINICAL = /\b(pain|painful|hurts?|hurting|ache|aching|toothache|bleed(ing|s)?|blood|swell(ing|ed)?|swollen|abscess|infect(ion|ed)|fever|pus|broken tooth|cracked tooth|chipped|knocked out|emergency|urgent(ly)?|can'?t (breathe|swallow|open my mouth)|numb(ness)?|throbbing|antibiotics?|painkillers?)\b|\b(can|should|could|may) i (take|use|have) (some |any |an? )?(ibuprofen|paracetamol|aspirin|antibiotics?|painkillers?|medicine|medication|tablets?|pills?)\b/i;
const HUMAN = /\b(call me|phone me|ring me|give me a call|speak (to|with) (a |an )?(human|person|someone|receptionist|real person|staff|dentist)|talk (to|with) (a |an )?(human|person|someone|receptionist|staff)|real person|human please|agent please)\b/i;
const INJECTION = /(ignore (all |any |the )?(previous|prior|above|earlier|your) (instructions|rules|prompts?)|disregard (the|your|all) (rules|instructions)|system prompt|you are now|developer mode|act as (an? )?(admin|administrator|system)|new instructions|override (the )?(policy|rules)|jailbreak|<\/?(system|assistant)>|\bBEGIN (SYSTEM|PROMPT)\b)/i;

export const isClinical = (text: string) => CLINICAL.test(text);
export const isHumanRequest = (text: string) => HUMAN.test(text);
export const isSuspicious = (text: string) => INJECTION.test(text);

/** Pre-LLM override. Returns an intent when policy must not depend on the model. */
export function preClassify(text: string): Intent | null {
  if (isClinical(text)) return 'clinical_concern';
  if (isHumanRequest(text)) return 'human_request';
  return null;
}

const MAX_REPLY = 320;
// The clarification reply must never claim a booking, mention other people, include links, or give clinical advice.
const FORBIDDEN_REPLY = /(confirmed|booked|reserved|scheduled for you|https?:\/\/|www\.|@|diagnos|prescri|ibuprofen|paracetamol|antibiotic|take (some|a) |rinse with)/i;

export function validateInterpretation(raw: unknown): Interpretation {
  if (!isObj(raw)) throw new Error('LLM output is not an object');
  const intent = raw.intent;
  if (typeof intent !== 'string' || !(INTENTS as readonly string[]).includes(intent)) throw new Error('LLM output has invalid intent');
  const confidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0;
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
  const requestedDay = typeof raw.requested_day === 'string' && raw.requested_day.trim() ? raw.requested_day.trim().slice(0, 40) : null;
  return {
    intent: intent as Intent,
    confidence,
    needsCalendarInfo: raw.needs_calendar_info === true,
    requestedDay,
    reply,
  };
}

/** Applies policy on top of the model's answer. Pure and deterministic. */
export function applyPolicy(message: string, interp: Interpretation): Interpretation & { overridden: string | null } {
  const forced = preClassify(message);
  if (forced) return { ...interp, intent: forced, overridden: `pre_classifier:${forced}` };
  if (interp.intent === 'accept' && isSuspicious(message)) return { ...interp, intent: 'ambiguous', overridden: 'suspicious_accept' };
  if (interp.intent === 'accept' && interp.confidence < 0.6) return { ...interp, intent: 'ambiguous', overridden: 'low_confidence_accept' };
  return { ...interp, overridden: null };
}

/** Deterministic, policy-safe reply templates (fallback when the model's draft is rejected). */
export function templateReply(intent: Intent, input: Pick<InterpretInput, 'patientFirstName' | 'treatmentName' | 'slotText'>): string {
  const { treatmentName: t, slotText: s } = input;
  switch (intent) {
    case 'question':
      return `The appointment is a ${t.toLowerCase()} ${s}. Would you like to take it? Please reply yes or no.`;
    case 'reschedule_request':
      return `Sorry, I can only offer ${s} at the moment. You'll keep your place on the waiting list either way. Would you like this one?`;
    default:
      return `Just to check: would you like the ${t.toLowerCase()} appointment ${s}? Please reply yes or no.`;
  }
}

export function safeReply(draft: string, intent: Intent, input: Pick<InterpretInput, 'patientFirstName' | 'treatmentName' | 'slotText'>): { text: string; usedFallback: boolean } {
  const d = draft.replace(/\s+/g, ' ').trim();
  if (!d || d.length > MAX_REPLY || FORBIDDEN_REPLY.test(d)) return { text: templateReply(intent, input), usedFallback: true };
  return { text: d, usedFallback: false };
}

// ---- Conversation outside a live offer
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const optStr = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : null);

export function validateFollowUp(raw: unknown): FollowUp {
  if (!isObj(raw)) throw new Error('LLM output is not an object');
  const c = raw.category;
  if (typeof c !== 'string' || !(FOLLOW_UP_CATEGORIES as readonly string[]).includes(c)) throw new Error('LLM output has invalid category');
  const tod = raw.time_of_day;
  return {
    category: c as FollowUp['category'],
    shouldReply: raw.should_reply !== false,
    reply: typeof raw.reply === 'string' ? raw.reply.trim() : '',
    appointmentDate: optStr(raw.appointment_date, DATE_RE),
    targetDate: optStr(raw.target_date, DATE_RE),
    targetTime: optStr(raw.target_time, TIME_RE),
    timeOfDay: tod === 'morning' || tod === 'afternoon' || tod === 'evening' ? tod : null,
  };
}

/** Policy on top of the model: "confirm" needs a pending proposal and a non-suspicious message. */
export function applyFollowUpPolicy(message: string, f: FollowUp, hasProposal: boolean): FollowUp {
  if (f.category === 'confirm' && (!hasProposal || isSuspicious(message))) return { ...f, category: 'other', reply: '' };
  // A "thank you" always gets a short reply (only a bare acknowledgement may go unanswered).
  if (f.category === 'thanks' && !f.shouldReply) return { ...f, shouldReply: true };
  return f;
}

// Small-talk replies may mention a confirmation only when it is a fact; they may never claim a change was made.
const FORBIDDEN_FOLLOW_UP = /(https?:\/\/|www\.|@|diagnos|prescri|ibuprofen|paracetamol|antibiotic|take (some|a) |rinse with|(i'?ve|i have|we'?ve|we have) (cancel|moved|reschedul|changed|rebooked|booked)|is (now )?(cancelled|canceled|rescheduled|moved))/i;
const OTHER_NAMES = /\b(James|Isla|Grace|Oliver|Mia|Leo|Noah|Ethan|Amelia)\b/;

export function followUpTemplate(category: FollowUp['category'], input: Pick<FollowUpInput, 'clinicPhone' | 'nextAppointment'>): string {
  if (category === 'thanks') return input.nextAppointment ? `You're welcome! See you ${input.nextAppointment} 😊` : `You're welcome! 😊`;
  if (category === 'appointment_question' && input.nextAppointment) return `Your next appointment is ${input.nextAppointment}. Anything else I can help with?`;
  return `Thanks for your message. I can help you cancel or reschedule an appointment here, or the team is on ${input.clinicPhone}.`;
}

export function safeFollowUpReply(f: FollowUp, input: FollowUpInput): { text: string; usedFallback: boolean } {
  const d = f.reply.replace(/\s+/g, ' ').trim();
  const confirmedClaim = /confirmed|booked/i.test(d) && input.appointments.length === 0;
  if (!d || d.length > 280 || FORBIDDEN_FOLLOW_UP.test(d) || OTHER_NAMES.test(d) || confirmedClaim) return { text: followUpTemplate(f.category, input), usedFallback: true };
  return { text: d, usedFallback: false };
}

// ---- End of conversation: once the clinic has signed off, a pure closing from the patient needs no reply.
const plain = (s: string) => s.replace(/[‘’ʼ`]/g, "'").toLowerCase().trim();
const CLOSING_PHRASES = /\b(thank you( so much| very much| again| for (your|the|all the) help)?|thanks( a lot| so much| again| for (your|the|all the) help)?|many thanks|thx|ty|cheers|appreciate it|much appreciated|ok(ay)?|k|kk|great|perfect|cool|nice|lovely|brilliant|awesome|amazing|fine|sounds good|got it|noted|all good|will do|bye( bye)?|goodbye|see you( then| soon| tomorrow)?|take care|have a (good|great|nice|lovely) (day|one|evening|weekend)|you too)\b/g;
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu;
// The clinic's last message was a sign-off (a reply to thanks, a goodbye), not a question or an update.
const CLINIC_SIGN_OFF = /\b(you'?re (very |most )?welcome|anytime|my pleasure|take care|have a (good|great|nice|lovely) (day|one|evening|weekend)|bye|goodbye)\b/;

/** The whole message is a closing ("thanks again!", "ok bye 👍", "have a good day"): no question, nothing else. */
export function isClosingMessage(text: string): boolean {
  const t = plain(text);
  if (!t || t.length > 80 || t.includes('?')) return false;
  return t.replace(EMOJI, ' ').replace(CLOSING_PHRASES, ' ').replace(/[\s,.!\-]+/g, '') === '';
}

/** True when the conversation is already over: nothing pending, the clinic signed off, and the patient only closes. */
export function conversationClosed(history: { role: 'clinic' | 'patient'; text: string }[], message: string, hasPendingProposal: boolean): boolean {
  if (hasPendingProposal || !isClosingMessage(message)) return false;
  const lastClinic = [...history].reverse().find(h => h.role === 'clinic')?.text;
  if (!lastClinic) return false;
  const c = plain(lastClinic);
  return !c.includes('?') && CLINIC_SIGN_OFF.test(c);
}
