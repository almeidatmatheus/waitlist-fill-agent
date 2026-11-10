// LlmPort backed by Jev for the offer-reply decision, with an optional LLM fallback.
//  - Jev answers 4 typed questions in ONE call (~100 ms): intent, clinical, human request, injection.
//  - The intent is used only when its calibrated confidence clears the threshold (higher bar for "accept").
//  - Low confidence or Jev unavailable -> the fallback LLM decides (or "ambiguous" without one).
//  - Reply text for clarifications comes from deterministic templates: Jev never generates text.
import { templateReply } from '../guardrails.ts';
import type { FollowUp, FollowUpInput, Intent, Interpretation, InterpretInput, LlmPort, LlmResult } from '../types.ts';
import type { Logger } from '../../shared/logger.ts';
import { errMsg } from '../../shared/errors.ts';
import { choiceOf, noulOf, type JevClient } from './client.ts';
import { offerReplyQuery } from './decisions.ts';

export interface JevInterpreterOptions {
  jev: JevClient;
  fallback: LlmPort | null;
  /** Minimum confidence to act on Jev's intent without the fallback. */
  minConfidence: number;
  /** Higher bar for "accept", because acting on it books an appointment. */
  minAcceptConfidence: number;
  log: Logger;
}

export class JevInterpreter implements LlmPort {
  readonly name: string;
  private o: JevInterpreterOptions;
  constructor(o: JevInterpreterOptions) {
    this.o = o;
    this.name = `jev:${o.jev.o.model}${o.fallback ? `+${o.fallback.name}` : ''}`;
  }

  async interpret(input: InterpretInput): Promise<LlmResult<Interpretation>> {
    const t0 = Date.now();
    const q = offerReplyQuery(input);
    let res;
    try {
      res = await this.o.jev.ask(q.state, q.questions);
    } catch (e) {
      this.o.log.warn('jev.failed', { error: errMsg(e) });
      return this.fallback(input, t0, 0, 0, 'jev_error');
    }
    const jevCost = this.o.jev.cost(res.usage);
    const tokens = res.usage?.input_tokens ?? 0;
    const clinical = noulOf(res.answers, '@clinical') ?? 0;
    const human = noulOf(res.answers, '@human') ?? 0;
    const injection = noulOf(res.answers, '@injection') ?? 0;
    const it = choiceOf(res.answers, '@intent');
    let intent: Intent | null = null, confidence = 0;
    if (clinical >= 0.5) { intent = 'clinical_concern'; confidence = clinical; }
    else if (human >= 0.5) { intent = 'human_request'; confidence = human; }
    else if (it && (it.choice as Intent) in INTENT_SET) {
      const bar = it.choice === 'accept' ? this.o.minAcceptConfidence : this.o.minConfidence;
      if (it.confidence >= bar && !(it.choice === 'accept' && injection >= 0.5)) { intent = it.choice as Intent; confidence = it.confidence; }
    }
    this.o.log.info('jev.decision', { kind: 'offer_reply', ms: res.ms, choice: it?.choice, confidence: it?.confidence, clinical, human, injection, accepted: !!intent });
    if (!intent) return this.fallback(input, t0, tokens, jevCost, `low_confidence:${it?.choice}:${(it?.confidence ?? 0).toFixed(2)}`);
    const value: Interpretation = { intent, confidence, needsCalendarInfo: intent === 'reschedule_request', requestedDay: null, reply: templateReply(intent, input) };
    return { value, model: `jev:${res.model}`, usage: { inputTokens: tokens, outputTokens: 0 }, costUsd: jevCost, latencyMs: Date.now() - t0, decidedBy: 'jev' };
  }

  private async fallback(input: InterpretInput, t0: number, jevTokens: number, jevCost: number, reason: string): Promise<LlmResult<Interpretation>> {
    if (!this.o.fallback) {
      return { value: { intent: 'ambiguous', confidence: 0, needsCalendarInfo: false, requestedDay: null, reply: templateReply('ambiguous', input) }, model: this.name, usage: { inputTokens: jevTokens, outputTokens: 0 }, costUsd: jevCost, latencyMs: Date.now() - t0, decidedBy: `default_ambiguous:${reason}` };
    }
    const r = await this.o.fallback.interpret(input);
    return {
      ...r,
      usage: { inputTokens: (r.usage?.inputTokens ?? 0) + jevTokens, outputTokens: r.usage?.outputTokens ?? 0 },
      costUsd: (r.costUsd ?? 0) + jevCost,
      latencyMs: Date.now() - t0,
      decidedBy: `llm_fallback:${reason}`,
    };
  }

  followUp(input: FollowUpInput): Promise<LlmResult<FollowUp>> {
    if (!this.o.fallback) throw new Error('followUp needs a fallback LLM');
    return this.o.fallback.followUp(input);
  }
}

const INTENT_SET: Record<string, true> = { accept: true, decline: true, reschedule_request: true, question: true, ambiguous: true, already_booked: true, human_request: true, clinical_concern: true, opt_out: true };
