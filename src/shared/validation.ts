// Lightweight runtime validation for payloads crossing system boundaries
// (webhooks, HTTP bodies, LLM output, MCP responses). TypeScript types alone do not validate at runtime.
import { ValidationError } from './errors.ts';

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function asObj(v: unknown, path: string): Obj {
  if (!isObj(v)) throw new ValidationError(`${path}: expected object`);
  return v;
}

export function reqStr(o: Obj, key: string, path = 'body', maxLen = 10_000): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ValidationError(`${path}.${key}: expected non-empty string`);
  if (v.length > maxLen) throw new ValidationError(`${path}.${key}: too long`);
  return v;
}

export function optStr(o: Obj, key: string, path = 'body', maxLen = 10_000): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${path}.${key}: expected string`);
  if (v.length > maxLen) throw new ValidationError(`${path}.${key}: too long`);
  return v;
}

export function optBool(o: Obj, key: string, path = 'body'): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`${path}.${key}: expected boolean`);
  return v;
}

export function reqEnum<T extends string>(o: Obj, key: string, allowed: readonly T[], path = 'body'): T {
  const v = o[key];
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new ValidationError(`${path}.${key}: expected one of ${allowed.join('|')}`);
  return v as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function reqUuid(o: Obj, key: string, path = 'body'): string {
  const v = o[key];
  if (!isUuid(v)) throw new ValidationError(`${path}.${key}: expected uuid`);
  return v;
}
