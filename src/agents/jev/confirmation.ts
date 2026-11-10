// Decides whether a patient message confirms a pending cancel/reschedule proposal.
// Rules (regex) are the baseline; Jev adds calibrated judgement for natural replies ("go on then", "let's do it",
// "that'd be lovely") while still refusing anything that is not clearly a yes.
import type { Logger } from '../../shared/logger.ts';
import { errMsg } from '../../shared/errors.ts';
import { isSuspicious } from '../guardrails.ts';
import { choiceOf, noulOf, type JevClient } from './client.ts';
import { confirmationQuery } from './decisions.ts';

export type Verdict = 'confirm' | 'decline' | 'unclear';
export interface ConfirmationDecision { verdict: Verdict; confidence: number; by: string; latencyMs: number; costUsd: number }

export interface ConfirmationJudge {
  readonly name: string;
  judge(proposal: string, message: string, ctx?: JudgeContext): Promise<ConfirmationDecision>;
}

// A confirmation must be clearly affirmative ("thanks" or "hmm" is not a yes).
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|please do|do it|confirm(ed)?|sounds good|that works|perfect|great|fine|absolutely|definitely|correct)\b|👍|✅/i;
// Texting shorthand for yes, only when it is the whole message ("y", "k").
const SHORT_YES = /^\s*(y|ya|yh|yea|yeh|k|kk)\s*[.!]*\s*$/i;
const NEGATIVE = /^\s*(no|nope|nah)\b|\b(don'?t|do not|doesn'?t|does not|won'?t|can'?t|never ?mind|keep (it|my)|changed my mind|not now|wait)\b/i;
const QUESTION = /\?\s*$/;

/**
 * Extra context for the judge. `selection`: the patient named the exact proposed time, and that time was
 * one of the options the clinic had just offered ("2:30pm please"). Picking an offered time is agreement.
 */
export interface JudgeContext { selection?: boolean }

export class RulesConfirmationJudge implements ConfirmationJudge {
  readonly name = 'rules';
  async judge(_proposal: string, message: string, ctx: JudgeContext = {}): Promise<ConfirmationDecision> {
    let verdict: Verdict;
    if (NEGATIVE.test(message)) verdict = 'decline';
    else if (isSuspicious(message)) verdict = 'unclear';
    else if (SHORT_YES.test(message) || AFFIRMATIVE.test(message)) verdict = 'confirm';
    else if (ctx.selection && !QUESTION.test(message)) verdict = 'confirm';
    else verdict = 'unclear';
    return { verdict, confidence: 1, by: 'rules', latencyMs: 0, costUsd: 0 };
  }
}

export class JevConfirmationJudge implements ConfirmationJudge {
  readonly name: string;
  private jev: JevClient;
  private minConfidence: number;
  private fallback: ConfirmationJudge;
  private log: Logger;
  constructor(o: { jev: JevClient; minConfidence: number; fallback?: ConfirmationJudge; log: Logger }) {
    this.jev = o.jev; this.minConfidence = o.minConfidence; this.fallback = o.fallback ?? new RulesConfirmationJudge(); this.log = o.log;
    this.name = `jev:${o.jev.o.model}`;
  }

  async judge(proposal: string, message: string, ctx: JudgeContext = {}): Promise<ConfirmationDecision> {
    const t0 = Date.now();
    const q = confirmationQuery(proposal, message, ctx);
    try {
      const r = await this.jev.ask(q.state, q.questions);
      const a = choiceOf(r.answers, '@answer');
      const injection = noulOf(r.answers, '@injection') ?? 0;
      const costUsd = this.jev.cost(r.usage);
      if (!a) throw new Error('missing @answer');
      // Anything short of a confident, non-manipulative "confirm" is treated as not confirmed.
      const verdict: Verdict = a.choice === 'confirm' ? (a.confidence >= this.minConfidence && injection < 0.5 ? 'confirm' : 'unclear') : a.choice === 'decline' ? 'decline' : 'unclear';
      this.log.info('jev.decision', { kind: 'confirmation', ms: r.ms, choice: a.choice, confidence: a.confidence, injection, verdict });
      return { verdict, confidence: a.confidence, by: 'jev', latencyMs: Date.now() - t0, costUsd };
    } catch (e) {
      this.log.warn('jev.failed', { kind: 'confirmation', error: errMsg(e) });
      const d = await this.fallback.judge(proposal, message, ctx);
      return { ...d, by: `rules_fallback`, latencyMs: Date.now() - t0 };
    }
  }
}
