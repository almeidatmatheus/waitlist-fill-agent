// Error taxonomy shared by integrations. The `kind` drives retry and safety decisions:
// e.g. a calendar listing that failed for any reason is never interpreted as a cancellation.

export type CalendarErrorKind = 'transient' | 'auth' | 'incomplete' | 'approval_required' | 'protocol' | 'timeout' | 'not_supported';

export class CalendarError extends Error {
  readonly kind: CalendarErrorKind;
  constructor(kind: CalendarErrorKind, message: string) {
    super(message);
    this.name = 'CalendarError';
    this.kind = kind;
  }
}

export type MessagingErrorKind = 'blocked' | 'transient' | 'rejected' | 'auth' | 'timeout';

export class MessagingError extends Error {
  readonly kind: MessagingErrorKind;
  constructor(kind: MessagingErrorKind, message: string) {
    super(message);
    this.name = 'MessagingError';
    this.kind = kind;
  }
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
