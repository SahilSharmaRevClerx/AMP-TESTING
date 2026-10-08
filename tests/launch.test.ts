import { describe, expect, it } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import { BrowserStartError, startBrowser } from '../src/core/browser/launch';
import { setLogSink } from '../src/core/util/logger';

const CLOSED = 'browserType.launch: Target page, context or browser has been closed';

/** A fake Chromium: `plan` says, per attempt, whether launch or newContext fails. */
function fakeChromium(plan: ('launch' | 'context' | 'ok')[]) {
  let attempt = 0;
  const closed: number[] = [];
  const launch = async (): Promise<Browser> => {
    const n = ++attempt;
    const step = plan[n - 1] ?? 'ok';
    if (step === 'launch') throw new Error(`${CLOSED}\nCall log:\n  - <launched> pid=123\n  - [pid=123] <process did exit: exitCode=0>`);
    return {
      newContext: async () => {
        if (step === 'context') throw new Error('browser.newContext: Target page, context or browser has been closed');
        return { id: n } as unknown as BrowserContext;
      },
      close: async () => {
        closed.push(n);
      },
    } as unknown as Browser;
  };
  return { launch, closed, attempts: () => attempt };
}

describe('startBrowser', () => {
  const quiet = () => setLogSink(() => undefined);
  const noWait = { sleep: async () => undefined, delaysMs: [0] };

  it('starts on the first try', async () => {
    quiet();
    const f = fakeChromium(['ok']);
    const { context } = await startBrowser({ headless: true, who: 'channel_manager', launch: f.launch, ...noWait });
    expect((context as unknown as { id: number }).id).toBe(1);
    expect(f.attempts()).toBe(1);
  });

  it('retries when Chromium dies while starting, as in the failed run', async () => {
    quiet();
    const f = fakeChromium(['launch', 'launch', 'ok']);
    const { context } = await startBrowser({ headless: true, who: 'partner_sales', launch: f.launch, ...noWait });
    expect((context as unknown as { id: number }).id).toBe(3);
  });

  it('closes a half-started browser before trying again', async () => {
    quiet();
    const f = fakeChromium(['context', 'ok']);
    await startBrowser({ headless: true, who: 'super_admin', launch: f.launch, ...noWait });
    expect(f.closed).toEqual([1]);
  });

  it('waits between attempts', async () => {
    quiet();
    const waits: number[] = [];
    const f = fakeChromium(['launch', 'launch', 'launch', 'ok']);
    await startBrowser({ headless: true, who: 'u', launch: f.launch, delaysMs: [10, 20], sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([10, 20, 20]);
  });

  it('gives up after the last attempt with the full Playwright message kept', async () => {
    const lines: string[] = [];
    setLogSink((l) => void lines.push(l));
    const f = fakeChromium(['launch', 'launch', 'launch', 'launch']);
    const err = await startBrowser({ headless: true, who: 'u', launch: f.launch, attempts: 4, ...noWait }).catch((e) => e);
    expect(err).toBeInstanceOf(BrowserStartError);
    expect(err.attempts).toBe(4);
    expect(err.message).toContain('could not be started after 4 attempts');
    expect(err.message).not.toContain('Call log');
    expect(err.detail).toContain('process did exit');
    expect(f.attempts()).toBe(4);
    // Every failed attempt is in the log with Playwright's own detail.
    expect(lines.filter((l) => l.includes('browser failed to start'))).toHaveLength(4);
    expect(lines.some((l) => l.includes('process did exit'))).toBe(true);
  });
});
