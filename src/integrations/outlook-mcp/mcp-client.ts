// Minimal MCP client (JSON-RPC 2.0) with stdio and Streamable HTTP transports.
// It discovers tools dynamically via tools/list and deliberately does NOT advertise the
// `elicitation` capability, so the server falls back to its preview + `cf` confirmation flow,
// which this application never completes on its own (approval stays with a human).
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CalendarError, withTimeout } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

type JsonRpcMessage = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: unknown; result?: any; error?: { code: number; message: string } };

interface Transport {
  start(onServerRequest: (m: JsonRpcMessage) => void): Promise<void>;
  send(m: JsonRpcMessage): Promise<JsonRpcMessage | null>;
  close(): Promise<void>;
  readonly alive: boolean;
}

const PROTOCOL_VERSION = '2025-06-18';

// ---------------------------------------------------------------- stdio
export interface StdioOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

class StdioTransport implements Transport {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, (m: JsonRpcMessage) => void>();
  private opts: StdioOptions;
  private log: Logger;
  private closing = false;
  alive = false;

  constructor(opts: StdioOptions, log: Logger) {
    this.opts = opts;
    this.log = log;
  }

  async start(onServerRequest: (m: JsonRpcMessage) => void) {
    // Minimal environment: never leak unrelated secrets (OpenAI, WA-AKG...) to the child process.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...this.opts.env };
    const p = spawn(this.opts.command, this.opts.args, { env, cwd: this.opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.alive = true;
    createInterface({ input: p.stdout! }).on('line', line => {
      if (!line.trim()) return;
      let m: JsonRpcMessage;
      try { m = JSON.parse(line); } catch { this.log.warn('mcp.stdio.unparseable_line'); return; }
      if (m.method && m.id !== undefined) return onServerRequest(m);
      if (m.id !== undefined && m.id !== null) {
        const f = this.pending.get(String(m.id));
        if (f) { this.pending.delete(String(m.id)); f(m); }
      }
    });
    createInterface({ input: p.stderr! }).on('line', line => this.log.debug('mcp.stdio.stderr', { line: line.slice(0, 300) }));
    p.on('exit', code => {
      this.alive = false;
      if (this.closing) this.log.debug('mcp.stdio.closed', { code });
      else this.log.warn('mcp.stdio.exit', { code });
      for (const [id, f] of this.pending) f({ jsonrpc: '2.0', id, error: { code: -32000, message: `MCP process exited (${code})` } });
      this.pending.clear();
    });
    p.on('error', e => { this.alive = false; this.log.error('mcp.stdio.spawn_error', { error: e.message }); });
  }

  async send(m: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    if (!this.proc || !this.alive) throw new CalendarError('transient', 'MCP process is not running');
    const line = JSON.stringify(m) + '\n';
    if (m.id === undefined) { this.proc.stdin!.write(line); return null; }
    return new Promise(resolve => {
      this.pending.set(String(m.id), resolve);
      this.proc!.stdin!.write(line);
    });
  }

  forget(id: string) { this.pending.delete(id); }

  async close() {
    this.closing = true;
    if (this.proc && this.alive) {
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
    }
    this.alive = false;
  }
}

// ---------------------------------------------------------------- Streamable HTTP
export interface HttpOptions {
  url: string;
  bearerToken?: string;
}

class HttpTransport implements Transport {
  private sessionId: string | null = null;
  private opts: HttpOptions;
  alive = false;
  constructor(opts: HttpOptions) { this.opts = opts; }

  async start() { this.alive = true; }

  async send(m: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.opts.bearerToken) headers.authorization = `Bearer ${this.opts.bearerToken}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    let r: Response;
    try {
      r = await fetch(this.opts.url, { method: 'POST', headers, body: JSON.stringify(m) });
    } catch (e) {
      throw new CalendarError('transient', `MCP HTTP request failed: ${(e as Error).message}`);
    }
    if (r.status === 401 || r.status === 403) throw new CalendarError('auth', `MCP HTTP ${r.status}: authorization required`);
    if (r.status >= 500 || r.status === 429) throw new CalendarError('transient', `MCP HTTP ${r.status}`);
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (m.id === undefined || r.status === 202) return null;
    if (!r.ok) throw new CalendarError('protocol', `MCP HTTP ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    const body = await r.text();
    if (ct.includes('text/event-stream')) {
      // Take the first JSON-RPC response carried in the SSE stream that matches our id.
      for (const block of body.split(/\n\n/)) {
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        const msg = JSON.parse(data) as JsonRpcMessage;
        if (msg.id === m.id) return msg;
      }
      throw new CalendarError('protocol', 'MCP SSE stream ended without a response');
    }
    return JSON.parse(body) as JsonRpcMessage;
  }

  async close() { this.alive = false; this.sessionId = null; }
}

// ---------------------------------------------------------------- client
export type McpClientOptions =
  | { transport: 'stdio'; stdio: StdioOptions; timeoutMs: number; log: Logger }
  | { transport: 'http'; http: HttpOptions; timeoutMs: number; log: Logger };

export class McpClient {
  private t: Transport | null = null;
  private connecting: Promise<void> | null = null;
  private tools: McpTool[] = [];
  private nextId = 1;
  private opts: McpClientOptions;
  serverInfo: { name?: string; version?: string } = {};

  constructor(opts: McpClientOptions) { this.opts = opts; }

  private get log() { return this.opts.log; }

  /** Connects (or reconnects after a crash) and discovers tools. Safe to call concurrently. */
  async connect(): Promise<void> {
    if (this.t?.alive && this.tools.length) return;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private async doConnect() {
    await this.t?.close().catch(() => {});
    this.t = this.opts.transport === 'stdio' ? new StdioTransport(this.opts.stdio, this.log) : new HttpTransport(this.opts.http);
    await this.t.start(m => this.onServerRequest(m));
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {}, // no elicitation, no sampling: approvals are never auto-answered
      clientInfo: { name: 'waitlist-fill-agent', version: '1.0.0' },
    });
    this.serverInfo = init?.serverInfo ?? {};
    await this.t.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await this.request('tools/list', {});
    this.tools = Array.isArray(list?.tools) ? list.tools.filter((x: any) => typeof x?.name === 'string') : [];
    this.log.info('mcp.connected', { server: this.serverInfo.name, version: this.serverInfo.version, tools: this.tools.map(t => t.name) });
  }

  private onServerRequest(m: JsonRpcMessage) {
    // Servers may ping; anything else (e.g. elicitation) is refused because we never advertised it.
    const reply: JsonRpcMessage = m.method === 'ping'
      ? { jsonrpc: '2.0', id: m.id, result: {} }
      : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `client does not support ${m.method}` } };
    this.t?.send(reply).catch(() => {});
  }

  private async request(method: string, params: unknown): Promise<any> {
    if (!this.t) throw new CalendarError('transient', 'MCP not connected');
    const id = `c${this.nextId++}`;
    const t = this.t;
    const res = await withTimeout(t.send({ jsonrpc: '2.0', id, method, params }), this.opts.timeoutMs, () => {
      if (t instanceof StdioTransport) t.forget(id);
      return new CalendarError('timeout', `MCP ${method} timed out after ${this.opts.timeoutMs}ms`);
    });
    if (!res) throw new CalendarError('protocol', `MCP ${method}: empty response`);
    if (res.error) {
      const kind = /exited|not running/i.test(res.error.message) ? 'transient' : 'protocol';
      throw new CalendarError(kind, `MCP ${method} error ${res.error.code}: ${res.error.message}`);
    }
    return res.result;
  }

  async listTools(): Promise<McpTool[]> {
    await this.connect();
    return this.tools;
  }

  hasTool(name: string) { return this.tools.some(t => t.name === name); }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.connect();
    if (!this.hasTool(name)) throw new CalendarError('not_supported', `MCP server does not expose tool "${name}"`);
    const r = await this.request('tools/call', { name, arguments: args });
    const text = Array.isArray(r?.content) ? r.content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text)).join('\n') : '';
    return { text, isError: r?.isError === true };
  }

  async close() {
    await this.t?.close();
    this.t = null;
    this.tools = [];
  }
}
