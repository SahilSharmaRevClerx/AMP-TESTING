import { scrub } from './mask';

/**
 * Developer logging for the terminal.
 *
 *   14:20:05.123 INFO  [run] page checked user=normal_user route=intel/account state=BLOCKED ms=2310
 *
 * Level: `--debug` / `--verbose` flag, else LOG_LEVEL env (debug|info|warn|error), else info.
 * Every line passes through scrub(), so registered tokens are always masked.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function initialLevel(): LogLevel {
  if (process.argv.includes('--debug') || process.argv.includes('--verbose')) return 'debug';
  const env = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return env in ORDER ? (env as LogLevel) : 'info';
}

let threshold: LogLevel = initialLevel();
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;

type Sink = (line: string, level: LogLevel) => void;
const defaultSink: Sink = (line, level) => (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
let sink: Sink = defaultSink;

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}
export function getLogLevel(): LogLevel {
  return threshold;
}
export function isDebug(): boolean {
  return ORDER[threshold] <= ORDER.debug;
}
/** For tests: capture log lines instead of writing to the terminal. Pass nothing to restore. */
export function setLogSink(fn?: Sink): void {
  sink = fn ?? defaultSink;
}

const COLOR: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function time(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === 'string') return v === '' || /[\s="]/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(',') || '[]';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function formatLine(level: LogLevel, tag: string, msg: string, fields?: LogFields, color = false): string {
  const f = fields
    ? Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(' ')
    : '';
  const lvl = level.toUpperCase().padEnd(5);
  const head = color ? `${DIM}${time()}${RESET} ${COLOR[level]}${lvl}${RESET} ${DIM}[${tag}]${RESET}` : `${time()} ${lvl} [${tag}]`;
  return `${head} ${msg}${f ? ' ' + (color ? DIM + f + RESET : f) : ''}`;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  /** Errors print their stack trace (first lines at info level, full at debug). */
  error(msg: string, err?: unknown, fields?: LogFields): void;
  child(tag: string): Logger;
}

export function createLogger(tag: string): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < ORDER[threshold]) return;
    sink(scrub(formatLine(level, tag, msg, fields, useColor)), level);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, err, f) => {
      const e = err instanceof Error ? err : undefined;
      emit('error', m, { ...f, ...(err !== undefined ? { error: e ? e.message : String(err) } : {}) });
      if (e?.stack && ORDER.error >= ORDER[threshold]) {
        const lines = e.stack.split('\n').slice(1);
        sink(scrub((isDebug() ? lines : lines.slice(0, 4)).join('\n')), 'error');
      }
    },
    child: (t) => createLogger(`${tag}:${t}`),
  };
}

/** Milliseconds since `start`, for `ms=` fields. */
export function since(start: number): number {
  return Date.now() - start;
}
