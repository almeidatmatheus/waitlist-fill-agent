// Minimal TypeSafe System One client (Jev). POST {url}/v1/systemone with { model, state, questions }.
// Jev returns typed decisions with calibrated probabilities (no generated text, no type errors).
import { withTimeout } from '../../shared/errors.ts';

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

export type JevAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number };

export interface JevResponse { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number }; ms: number }

export interface JevClientOptions {
  apiKey: string;
  model: string;
  url: string;
  timeoutMs: number;
  /** USD per 1M input tokens (output tokens are free). */
  priceInputPer1M: number;
  fetchImpl?: typeof fetch;
}

export class JevError extends Error {}

export class JevClient {
  readonly o: JevClientOptions;
  constructor(o: JevClientOptions) { this.o = o; }

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    const f = this.o.fetchImpl ?? fetch;
    const t0 = Date.now(), deadline = t0 + this.o.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new JevError(`jev: no answer within ${this.o.timeoutMs} ms`);
      let r: Response;
      try {
        r = await withTimeout(
          f(`${this.o.url.replace(/\/$/, '')}/v1/systemone`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: this.o.model, state, questions }),
          }),
          left,
          () => new JevError(`jev: no answer within ${this.o.timeoutMs} ms`),
        );
      } catch (e) {
        throw e instanceof JevError ? e : new JevError(`jev: ${(e as Error).message}`);
      }
      if ((r.status === 429 || r.status === 529) && attempt < 2 && deadline - Date.now() > 300) {
        await new Promise(res => setTimeout(res, Math.min(250 * 2 ** attempt, deadline - Date.now() - 200)));
        continue;
      }
      if (!r.ok) throw new JevError(`jev ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      const j = (await r.json()) as Omit<JevResponse, 'ms'>;
      if (!j || typeof j !== 'object' || typeof j.answers !== 'object') throw new JevError('jev: malformed response');
      return { ...j, ms: Date.now() - t0 };
    }
  }

  cost(usage: { input_tokens: number } | undefined) {
    return ((usage?.input_tokens ?? 0) * this.o.priceInputPer1M) / 1_000_000;
  }
}

export const choiceOf = (a: Record<string, JevAnswer>, k: string) => { const x = a[k]; return x?.type === 'choice' ? x : null; };
export const noulOf = (a: Record<string, JevAnswer>, k: string) => { const x = a[k]; return x?.type === 'noul' ? x.noul : null; };
