import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';
import { scrub } from '../util/mask';
import { createLogger, since } from '../util/logger';

const log = createLogger('browser');

/** Starting Chromium can fail once in a while (seen on Windows right after other runs): try this often. */
export const START_ATTEMPTS = 4;
/** Wait before attempt 2, 3, 4 … (the last value repeats). About 10 s in all. */
export const START_RETRY_DELAYS_MS = [1500, 3000, 6000];

/** Chromium could not be started even after retrying. `detail` is Playwright's full message (tokens masked). */
export class BrowserStartError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'BrowserStartError';
  }
}

export interface StartOptions {
  headless: boolean;
  context?: BrowserContextOptions;
  /** Who the browser is for, for the log (e.g. a user type, "super_admin"). */
  who: string;
  attempts?: number;
  delaysMs?: number[];
  /** Replaceable in tests. */
  launch?: (headless: boolean) => Promise<Browser>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Starts Chromium and opens a fresh context, retrying when the browser dies while starting
 * ("Target page, context or browser has been closed"). Every failed attempt is logged with
 * Playwright's full message; a half-started browser is closed before the next try.
 */
export async function startBrowser(o: StartOptions): Promise<{ browser: Browser; context: BrowserContext }> {
  const attempts = Math.max(1, o.attempts ?? START_ATTEMPTS);
  const delays = o.delaysMs ?? START_RETRY_DELAYS_MS;
  const launch = o.launch ?? ((headless: boolean) => chromium.launch({ headless }));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    let browser: Browser | undefined;
    try {
      browser = await launch(o.headless);
      const context = await browser.newContext(o.context);
      if (attempt > 1) log.info('browser started after retrying', { who: o.who, attempt, ms: since(started) });
      return { browser, context };
    } catch (e) {
      last = e;
      await browser?.close().catch(() => undefined);
      log.warn('browser failed to start', { who: o.who, attempt: `${attempt}/${attempts}`, ms: since(started), error: scrub(messageOf(e)) });
      if (attempt < attempts) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
  const detail = scrub(messageOf(last));
  throw new BrowserStartError(`the test browser (Chromium) could not be started after ${attempts} attempts: ${detail.split('\n')[0]}`, attempts, detail);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
