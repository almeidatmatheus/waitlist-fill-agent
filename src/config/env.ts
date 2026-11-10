// Typed configuration loaded from environment variables, validated once at startup.

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
  adminApiToken: string;
  clinic: {
    name: string;
    phoneDisplay: string;
    timezone: string;
    calendarName: string;
    offerTtlMinutes: number;
    /** Most patients that can hold a live offer for the same slot at once (1 = one at a time). */
    offerCascadeSize: number;
    /** Minutes before the offer is widened to one more patient (0 = offer to the whole cascade at once). */
    offerWidenAfterMinutes: number;
    minLeadTimeMinutes: number;
    maxClarificationTurns: number;
    /** e.g. "mon-fri 09:00-18:00" (clinic time zone): bookable hours for reschedules. */
    openingHours: string;
    requestTtlMinutes: number;
  };
  loops: {
    cancellationPollMs: number;
    /** Polling interval while Graph change notifications are healthy (safety net). */
    cancellationFallbackPollMs: number;
    cancellationConfirmations: number;
    cancellationLookaheadDays: number;
    sweepIntervalMs: number;
  };
  llm: {
    provider: 'openai' | 'mock';
    apiKey: string;
    model: string;
    priceInputPer1M: number | null;
    priceOutputPer1M: number | null;
    timeoutMs: number;
  };
  jev: {
    /** auto = on when TYPESAFE_API_KEY is set; off = never. */
    enabled: boolean;
    apiKey: string;
    model: string;
    url: string;
    timeoutMs: number;
    priceInputPer1M: number;
    minConfidence: number;
    minAcceptConfidence: number;
  };
  calendar: {
    provider: 'mock' | 'mcp';
    transport: 'stdio' | 'http';
    command: string;
    path: string;
    url: string;
    bearerToken: string;
    callTimeoutMs: number;
    passthroughEnv: Record<string, string>;
    /** Graph change notifications: on when both OUTLOOK_MCP_NOTIFY_URL and OUTLOOK_MCP_NOTIFY_SECRET are set. */
    notifications: { enabled: boolean; url: string; secret: string; debounceMs: number };
  };
  messaging: {
    provider: 'mock' | 'wa-akg';
    baseUrl: string;
    apiKey: string;
    sessionId: string;
    webhookSecret: string;
    allowedNumbers: string[];
  };
  handoffWebhookUrl: string;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback = ''): string {
  const v = env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(env: Env, key: string, fallback: number, min = 0): number {
  const raw = str(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${key} must be an integer >= ${min}`);
  return n;
}

function optNum(env: Env, key: string): number | null {
  const raw = str(env, key);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${key} must be a non-negative number`);
  return n;
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(env, key, fallback) as T;
  if (!allowed.includes(v)) throw new ConfigError(`${key} must be one of ${allowed.join(', ')}`);
  return v;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Env = process.env): AppConfig {
  const nodeEnv = oneOf(env, 'NODE_ENV', ['development', 'test', 'production'] as const, 'development');
  const timezone = str(env, 'CLINIC_TIMEZONE', 'Europe/London');
  if (!isValidTimeZone(timezone)) throw new ConfigError(`CLINIC_TIMEZONE is not a valid IANA zone: ${timezone}`);

  const llmProvider = oneOf(env, 'LLM_PROVIDER', ['openai', 'mock'] as const, 'mock');
  const messagingProvider = oneOf(env, 'MESSAGING_PROVIDER', ['mock', 'wa-akg'] as const, 'mock');
  const calendarProvider = oneOf(env, 'CALENDAR_PROVIDER', ['mock', 'mcp'] as const, 'mock');

  const allowedNumbers = str(env, 'WHATSAPP_ALLOWED_NUMBERS')
    .split(',')
    .map(s => s.replace(/[\s()-]/g, ''))
    .filter(Boolean);

  const cfg: AppConfig = {
    nodeEnv,
    port: int(env, 'PORT', 3000, 1),
    host: str(env, 'HOST', '127.0.0.1'),
    logLevel: oneOf(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    databaseUrl: str(env, 'DATABASE_URL'),
    adminApiToken: str(env, 'ADMIN_API_TOKEN'),
    clinic: {
      name: str(env, 'CLINIC_NAME', 'Bright Smile Dental (fictional)'),
      phoneDisplay: str(env, 'CLINIC_PHONE_DISPLAY', '020 7946 0000'),
      timezone,
      calendarName: str(env, 'CLINIC_CALENDAR_NAME'),
      offerTtlMinutes: int(env, 'OFFER_TTL_MINUTES', 30, 1),
      offerCascadeSize: int(env, 'OFFER_CASCADE_SIZE', 3, 1),
      offerWidenAfterMinutes: int(env, 'OFFER_WIDEN_AFTER_MINUTES', 5, 0),
      minLeadTimeMinutes: int(env, 'MIN_LEAD_TIME_MINUTES', 60, 0),
      maxClarificationTurns: int(env, 'MAX_CLARIFICATION_TURNS', 2, 0),
      openingHours: str(env, 'CLINIC_OPENING_HOURS', 'mon-fri 09:00-18:00'),
      requestTtlMinutes: int(env, 'PATIENT_REQUEST_TTL_MINUTES', 30, 1),
    },
    loops: {
      cancellationPollMs: int(env, 'CANCELLATION_POLL_MS', 60000, 0),
      cancellationFallbackPollMs: int(env, 'CANCELLATION_FALLBACK_POLL_MS', 300000, 0),
      cancellationConfirmations: int(env, 'CANCELLATION_CONFIRMATIONS', 2, 1),
      cancellationLookaheadDays: int(env, 'CANCELLATION_LOOKAHEAD_DAYS', 30, 1),
      sweepIntervalMs: int(env, 'SWEEP_INTERVAL_MS', 15000, 0),
    },
    llm: {
      provider: llmProvider,
      apiKey: str(env, 'OPENAI_API_KEY'),
      model: str(env, 'OPENAI_MODEL'),
      priceInputPer1M: optNum(env, 'OPENAI_PRICE_INPUT_PER_1M'),
      priceOutputPer1M: optNum(env, 'OPENAI_PRICE_OUTPUT_PER_1M'),
      timeoutMs: int(env, 'LLM_TIMEOUT_MS', 20000, 1000),
    },
    jev: {
      enabled: oneOf(env, 'JEV_MODE', ['auto', 'off'] as const, 'auto') === 'auto' && !!str(env, 'TYPESAFE_API_KEY'),
      apiKey: str(env, 'TYPESAFE_API_KEY'),
      model: str(env, 'TYPESAFE_MODEL', 'jev-latest'),
      url: str(env, 'TYPESAFE_URL', 'https://api.typesafe.ai'),
      timeoutMs: int(env, 'TYPESAFE_TIMEOUT_MS', 2500, 100),
      priceInputPer1M: optNum(env, 'TYPESAFE_PRICE_INPUT_PER_1M') ?? 0.042,
      minConfidence: optNum(env, 'JEV_MIN_CONFIDENCE') ?? 0.7,
      minAcceptConfidence: optNum(env, 'JEV_MIN_ACCEPT_CONFIDENCE') ?? 0.85,
    },
    calendar: {
      provider: calendarProvider,
      transport: oneOf(env, 'OUTLOOK_MCP_TRANSPORT', ['stdio', 'http'] as const, 'stdio'),
      command: str(env, 'OUTLOOK_MCP_COMMAND', 'node'),
      path: str(env, 'OUTLOOK_MCP_PATH'),
      url: str(env, 'OUTLOOK_MCP_URL'),
      bearerToken: str(env, 'OUTLOOK_MCP_BEARER_TOKEN'),
      callTimeoutMs: int(env, 'MCP_CALL_TIMEOUT_MS', 20000, 1000),
      // Only OUTLOOK_MCP_* variables are forwarded to the child process; the clinic time zone is
      // forced so that wall-clock times written by the MCP match the clinic's zone.
      passthroughEnv: {
        ...Object.fromEntries(
          Object.entries(env).filter(([k, v]) => k.startsWith('OUTLOOK_MCP_') && v !== undefined && v !== '') as [string, string][],
        ),
        OUTLOOK_MCP_TZ: timezone,
      },
      // The same two variables configure the MCP (which creates the subscription) and this app (which
      // receives the notifications and checks the secret), so they cannot drift apart with stdio transport.
      notifications: {
        enabled: !!str(env, 'OUTLOOK_MCP_NOTIFY_URL') && !!str(env, 'OUTLOOK_MCP_NOTIFY_SECRET'),
        url: str(env, 'OUTLOOK_MCP_NOTIFY_URL'),
        secret: str(env, 'OUTLOOK_MCP_NOTIFY_SECRET'),
        debounceMs: int(env, 'CALENDAR_NOTIFY_DEBOUNCE_MS', 2000, 0),
      },
    },
    messaging: {
      provider: messagingProvider,
      baseUrl: str(env, 'WA_AKG_BASE_URL', 'http://localhost:3001').replace(/\/+$/, ''),
      apiKey: str(env, 'WA_AKG_API_KEY'),
      sessionId: str(env, 'WA_AKG_SESSION_ID', 'clinic-test'),
      webhookSecret: str(env, 'WA_AKG_WEBHOOK_SECRET'),
      allowedNumbers,
    },
    handoffWebhookUrl: str(env, 'HUMAN_HANDOFF_WEBHOOK_URL'),
  };

  const problems: string[] = [];
  if (!cfg.databaseUrl) problems.push('DATABASE_URL is required');
  if (cfg.adminApiToken.length < 16) problems.push('ADMIN_API_TOKEN must be at least 16 characters');
  if (cfg.messaging.webhookSecret.length < 16) problems.push('WA_AKG_WEBHOOK_SECRET must be at least 16 characters');
  if (llmProvider === 'openai') {
    if (!cfg.llm.apiKey) problems.push('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
    if (!cfg.llm.model) problems.push('OPENAI_MODEL is required when LLM_PROVIDER=openai');
  }
  if (messagingProvider === 'wa-akg') {
    if (!cfg.messaging.apiKey) problems.push('WA_AKG_API_KEY is required when MESSAGING_PROVIDER=wa-akg');
    if (allowedNumbers.length === 0) problems.push('WHATSAPP_ALLOWED_NUMBERS must list explicit test numbers when MESSAGING_PROVIDER=wa-akg');
    for (const n of allowedNumbers) if (!/^\+[1-9]\d{7,14}$/.test(n)) problems.push(`WHATSAPP_ALLOWED_NUMBERS entry is not E.164: ${n}`);
  }
  if (calendarProvider === 'mcp') {
    if (cfg.calendar.transport === 'stdio' && !cfg.calendar.path) problems.push('OUTLOOK_MCP_PATH is required for stdio transport');
    if (cfg.calendar.transport === 'http' && !cfg.calendar.url) problems.push('OUTLOOK_MCP_URL is required for http transport');
  }
  // The .env.example placeholders are public. They are fine for a local demo, never once the app is reachable.
  const placeholder = (v: string) => /^change-me/i.test(v);
  const reachable = nodeEnv === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(cfg.host)
    || messagingProvider === 'wa-akg' || cfg.calendar.notifications.enabled;
  if (reachable && placeholder(cfg.adminApiToken)) problems.push('ADMIN_API_TOKEN still has the .env.example placeholder; set a long random value');
  if (reachable && placeholder(cfg.messaging.webhookSecret)) problems.push('WA_AKG_WEBHOOK_SECRET still has the .env.example placeholder; set a long random value');
  const nt = cfg.calendar.notifications;
  if (!!nt.url !== !!nt.secret) problems.push('OUTLOOK_MCP_NOTIFY_URL and OUTLOOK_MCP_NOTIFY_SECRET must be set together');
  if (nt.enabled) {
    let path = '';
    try { const u = new URL(nt.url); if (u.protocol === 'https:') path = u.pathname.replace(/\/+$/, ''); } catch { /* reported below */ }
    if (path !== '/webhooks/graph') problems.push('OUTLOOK_MCP_NOTIFY_URL must be the public HTTPS URL of this app ending in /webhooks/graph');
    if (nt.secret.length < 16 || nt.secret.length > 128) problems.push('OUTLOOK_MCP_NOTIFY_SECRET must have 16 to 128 characters');
  }
  if (problems.length) throw new ConfigError(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  return cfg;
}

export const devEndpointsEnabled = (cfg: AppConfig) => cfg.nodeEnv === 'development' || cfg.nodeEnv === 'test';
