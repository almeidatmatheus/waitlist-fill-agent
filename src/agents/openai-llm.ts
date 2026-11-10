// OpenAI implementation of the LLM port. Model comes from OPENAI_MODEL (never hardcoded).
// Structured output (JSON schema, strict) + runtime validation; token usage and estimated cost are recorded.
import OpenAI from 'openai';
import { LlmError } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { INTERPRETATION_JSON_SCHEMA, INTERPRETER_SYSTEM_PROMPT, buildInterpreterUserPrompt, FOLLOW_UP_JSON_SCHEMA, FOLLOW_UP_SYSTEM_PROMPT, buildFollowUpUserPrompt } from './prompts.ts';
import { validateInterpretation, validateFollowUp } from './guardrails.ts';
import type { FollowUp, FollowUpInput, Interpretation, InterpretInput, LlmPort, LlmResult } from './types.ts';

export interface OpenAiLlmOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  priceInputPer1M: number | null;
  priceOutputPer1M: number | null;
  log: Logger;
  client?: Pick<OpenAI, 'chat'>;
}

export class OpenAiLlm implements LlmPort {
  readonly name: string;
  private client: Pick<OpenAI, 'chat'>;
  private opts: OpenAiLlmOptions;

  constructor(opts: OpenAiLlmOptions) {
    this.opts = opts;
    this.name = `openai:${opts.model}`;
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 1 });
  }

  /** One structured chat completion: JSON-schema output, runtime validation, usage + cost. */
  private async complete<T>(kind: string, system: string, user: string, schema: unknown, validate: (raw: unknown) => T, summary: (v: T) => Record<string, unknown>): Promise<LlmResult<T>> {
    const t0 = Date.now();
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.opts.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: structuredClone(schema) as any },
        max_completion_tokens: 600,
      });
    } catch (e) {
      throw new LlmError(`OpenAI request failed: ${(e as Error).message}`);
    }
    const latencyMs = Date.now() - t0;
    const content = completion.choices?.[0]?.message?.content ?? '';
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new LlmError('OpenAI returned non-JSON content'); }
    const value = validate(parsed);
    const usage = completion.usage ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens } : null;
    const { priceInputPer1M: pi, priceOutputPer1M: po } = this.opts;
    const costUsd = usage && pi !== null && po !== null ? (usage.inputTokens * pi + usage.outputTokens * po) / 1_000_000 : null;
    this.opts.log.info('llm.call', { provider: 'openai', kind, model: completion.model ?? this.opts.model, latencyMs, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, costUsd, ...summary(value) });
    return { value, model: completion.model ?? this.opts.model, usage, costUsd, latencyMs };
  }

  interpret(input: InterpretInput): Promise<LlmResult<Interpretation>> {
    return this.complete('interpret', INTERPRETER_SYSTEM_PROMPT, buildInterpreterUserPrompt(input), INTERPRETATION_JSON_SCHEMA, validateInterpretation, v => ({ intent: v.intent }));
  }

  followUp(input: FollowUpInput): Promise<LlmResult<FollowUp>> {
    return this.complete('follow_up', FOLLOW_UP_SYSTEM_PROMPT, buildFollowUpUserPrompt(input), FOLLOW_UP_JSON_SCHEMA, validateFollowUp, v => ({ category: v.category, shouldReply: v.shouldReply }));
  }
}
