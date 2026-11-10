// Structured JSON logger. Secrets and unnecessary patient details are redacted before output.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

// Matches credential-like keys (apiKey, access_token, token, secret...) but not metrics such as inputTokens.
const SECRET_KEYS = /(api[_-]?key|^token$|[_-]token$|access[_-]?token|refresh[_-]?token|bearer|secret|password|authorization|cookie|signature)/i;
const PII_KEYS = /^(phone|phone_number|phoneNumber|whatsapp_jid|jid|full_name|fullName|content|text|message_text)$/i;

export function maskPhone(v: string): string {
  const digits = v.replace(/\D/g, '');
  return digits.length <= 4 ? '***' : `***${digits.slice(-4)}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
      else if (PII_KEYS.test(k) && typeof v === 'string') out[k] = /phone|jid/i.test(k) ? maskPhone(v) : `[${v.length} chars]`;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[redacted]');
  return value;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
}

export function createLogger(base: LogFields = {}, opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg, ...(redact({ ...base, ...fields }) as LogFields) };
    sink(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: f => createLogger({ ...base, ...f }, opts),
  };
}

export const silentLogger: Logger = createLogger({}, { level: 'error', sink: () => {} });
