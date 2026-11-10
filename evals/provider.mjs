// Promptfoo custom provider: the "prompt" is a scenario name; the provider runs the complete
// LangGraph workflow for that scenario and returns the observable outcome as JSON.
// Node >= 22.18 strips TypeScript types natively, so the .ts sources are imported directly.
export default class WorkflowScenarioProvider {
  constructor(options = {}) {
    this.providerId = options.id ?? 'aar-workflow';
  }
  id() {
    return `${this.providerId}:${process.env.EVAL_LLM === 'openai' ? `openai:${process.env.OPENAI_MODEL}` : 'mock-llm'}`;
  }
  async callApi(prompt) {
    const { runScenario } = await import('./scenarios.ts');
    try {
      const r = await runScenario(String(prompt).trim());
      return {
        output: JSON.stringify(r),
        tokenUsage: { total: r.inputTokens + r.outputTokens, prompt: r.inputTokens, completion: r.outputTokens, numRequests: r.llmCalls },
        cost: r.costUsd,
        latencyMs: r.latencyMs,
        metadata: { toolCalls: r.toolCalls.length, workflowStatus: r.workflowStatus, incorrectBookingAttempts: r.incorrectBookingAttempts, llm: r.llm },
      };
    } catch (e) {
      return { error: `scenario failed: ${e?.stack ?? e}` };
    }
  }
}
