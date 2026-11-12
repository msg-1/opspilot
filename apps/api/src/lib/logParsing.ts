import { createHash } from 'node:crypto';
import type { LogLevel } from '@prisma/client';

const LEVELS: Record<string, LogLevel> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  information: 'INFO',
  notice: 'INFO',
  warn: 'WARN',
  warning: 'WARN',
  error: 'ERROR',
  err: 'ERROR',
  fatal: 'FATAL',
  critical: 'FATAL',
  crit: 'FATAL',
  panic: 'FATAL',
};

export function parseLevel(input: unknown): LogLevel {
  if (typeof input === 'number') {
    // pino/bunyan numeric levels
    if (input >= 60) return 'FATAL';
    if (input >= 50) return 'ERROR';
    if (input >= 40) return 'WARN';
    if (input >= 30) return 'INFO';
    if (input >= 20) return 'DEBUG';
    return 'TRACE';
  }
  return LEVELS[String(input ?? 'info').toLowerCase()] ?? 'INFO';
}

/**
 * Reduces a log message to its template by replacing the variable parts, so that
 * "timeout after 3021ms for user 8812" and "timeout after 2990ms for user 17" group together.
 */
export function normalizeMessage(message: string): string {
  return message
    .slice(0, 2000)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/"[^"]{0,200}"/g, '"<str>"')
    .replace(/'[^']{0,200}'/g, "'<str>'")
    .replace(/\b\d+(?:\.\d+)?(ms|s|m|h|kb|mb|gb|%)?\b/gi, '<n>$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(message: string): string {
  return createHash('sha1').update(normalizeMessage(message)).digest('hex').slice(0, 16);
}

const REDACTIONS: [RegExp, string][] = [
  [/\b(authorization|bearer)([:=\s]+)(?:bearer\s+)?[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2[REDACTED]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{3,}/gi, '$1$2[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:\d[ -]?){13,16}\b/g, '[REDACTED_CARD]'],
];

/** Masks credentials and card-like numbers before a log line is stored. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api[_-]?key|cookie|credential/i;

export function redactAttributes(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactAttributes(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactAttributes(v, depth + 1)]),
    );
  }
  return value;
}
