// Response interpretation pipeline: deterministic pre-classifier -> LLM -> policy -> safe reply.
import { errMsg } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { applyPolicy, preClassify, safeReply, templateReply } from './guardrails.ts';
import type { Intent, InterpretInput, LlmPort } from './types.ts';

export interface InterpretationOutcome {
  intent: Intent;
  confidence: number;
  reply: string;
  needsCalendarInfo: boolean;
  requestedDay: string | null;
  overridden: string | null;
  usedFallbackReply: boolean;
  llm: { called: boolean; model: string | null; inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs: number; error: string | null; decidedBy?: string | null };
}

export async function interpretPatientReply(llm: LlmPort, input: InterpretInput, log: Logger): Promise<InterpretationOutcome> {
  // Clinical / human-request language bypasses the model entirely: policy must not depend on it.
  const forced = preClassify(input.message);
  if (forced) {
    return {
      intent: forced, confidence: 1, reply: '', needsCalendarInfo: false, requestedDay: null, overridden: `pre_classifier:${forced}`, usedFallbackReply: false,
      llm: { called: false, model: null, inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs: 0, error: null },
    };
  }
  try {
    const r = await llm.interpret(input);
    const p = applyPolicy(input.message, r.value);
    const reply = safeReply(p.intent === r.value.intent ? r.value.reply : '', p.intent, input);
    return {
      intent: p.intent, confidence: r.value.confidence, reply: reply.text, needsCalendarInfo: r.value.needsCalendarInfo, requestedDay: r.value.requestedDay,
      overridden: p.overridden, usedFallbackReply: reply.usedFallback,
      llm: { called: true, model: r.model, inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0, costUsd: r.costUsd, latencyMs: r.latencyMs, error: null, decidedBy: r.decidedBy ?? 'llm' },
    };
  } catch (e) {
    // LLM unavailable or invalid output: fail safe (never accept), ask the patient to confirm with a template.
    log.warn('llm.failure', { error: errMsg(e) });
    return {
      intent: 'ambiguous', confidence: 0, reply: templateReply('ambiguous', input), needsCalendarInfo: false, requestedDay: null, overridden: 'llm_error', usedFallbackReply: true,
      llm: { called: true, model: llm.name, inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs: 0, error: errMsg(e) },
    };
  }
}
