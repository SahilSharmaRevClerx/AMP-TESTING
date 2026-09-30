import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, formatLine, getLogLevel, setLogLevel, setLogSink, type LogLevel } from '../src/util/logger';
import { registerSecret } from '../src/util/mask';

const lines: { line: string; level: LogLevel }[] = [];
const capture = () => {
  lines.length = 0;
  setLogSink((line, level) => lines.push({ line, level }));
};
const initial = getLogLevel();
afterEach(() => {
  setLogSink();
  setLogLevel(initial);
});

describe('formatLine', () => {
  it('prints time, level, tag, message and key=value fields', () => {
    const line = formatLine('info', 'run', 'page checked', { user: 'normal_user', route: 'intel/account', ms: 12, skip: undefined, apis: ['geta', 'getb'] });
    expect(line).toMatch(/^\d\d:\d\d:\d\d\.\d{3} INFO  \[run\] page checked user=normal_user route=intel\/account ms=12 apis=geta,getb$/);
  });

  it('quotes values with spaces and serializes objects', () => {
    const line = formatLine('warn', 'x', 'm', { reason: 'token expired or wrong', o: { a: 1 }, empty: '' });
    expect(line).toContain('reason="token expired or wrong"');
    expect(line).toContain('o={"a":1}');
    expect(line).toContain('empty=""');
  });
});

describe('createLogger', () => {
  it('filters by level', () => {
    capture();
    setLogLevel('info');
    const log = createLogger('t');
    log.debug('hidden');
    log.info('shown');
    log.warn('also shown');
    expect(lines.map((l) => l.level)).toEqual(['info', 'warn']);
    setLogLevel('debug');
    log.debug('now shown');
    expect(lines).toHaveLength(3);
  });

  it('never prints registered tokens', () => {
    capture();
    setLogLevel('debug');
    const secret = 'eyJhbGciOiJIUzI1NiJ9.secret-token-value';
    registerSecret(secret);
    createLogger('t').info(`cookie jwt=${secret}`, { jwt: secret });
    expect(lines[0]!.line).not.toContain(secret);
    expect(lines[0]!.line).toContain('eyJhb…lue');
  });

  it('prints error stack lines and child tags', () => {
    capture();
    setLogLevel('info');
    createLogger('server').child('api').error('boom', new Error('bad thing'), { path: '/api/runs' });
    expect(lines[0]!.line).toContain('[server:api] boom path=/api/runs error="bad thing"');
    expect(lines[1]!.line).toMatch(/at /);
  });
});
