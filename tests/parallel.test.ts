import { describe, expect, it } from 'vitest';
import { runLimited } from '../src/util/limit';
import { buildConfig, effectiveParallelUsers } from '../src/config';
import { planRun } from '../src/run';
import { rulebookFromRows } from '../src/rulebook/parse';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runLimited', () => {
  it('never runs more than the limit at once and keeps input order', async () => {
    let running = 0;
    let peak = 0;
    const out = await runLimited([30, 10, 20, 5, 15], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await sleep(ms);
      running--;
      return i;
    });
    expect(peak).toBe(2);
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it('runs everything in parallel when the limit allows', async () => {
    const started = Date.now();
    await runLimited([50, 50, 50], 3, (ms) => sleep(ms));
    expect(Date.now() - started).toBeLessThan(140);
  });

  it('rethrows the first error after the others settle', async () => {
    const finished: number[] = [];
    await expect(
      runLimited([1, 2, 3], 3, async (n) => {
        await sleep(n * 10);
        if (n === 1) throw new Error('boom');
        finished.push(n);
      }),
    ).rejects.toThrow('boom');
    expect(finished).toEqual([2, 3]);
  });
});

describe('parallel users setting', () => {
  const env = { name: 'x', baseUrl: 'https://x.amp.vg', isProduction: false };
  it('defaults to 3, is clamped to 1–5, and is always 1 on production', () => {
    expect(effectiveParallelUsers({ environment: env, parallelUsers: 3 })).toBe(3);
    expect(effectiveParallelUsers({ environment: env, parallelUsers: 9 })).toBe(5);
    expect(effectiveParallelUsers({ environment: env, parallelUsers: 0 })).toBe(1);
    expect(effectiveParallelUsers({ environment: { ...env, isProduction: true }, parallelUsers: 4 })).toBe(1);
  });

  it('the time estimate accounts for users running together', () => {
    const rb = rulebookFromRows([['page', 'a', 'b', 'c'], ...Array.from({ length: 100 }, (_, i) => [`p${i}`, 'Yes', 'No', 'Yes'])]);
    const base = { environment: env, userTypes: { a: { label: 'A' }, b: { label: 'B' }, c: { label: 'C' } } };
    const one = planRun(buildConfig({ ...base, parallelUsers: 1 }), rb);
    const three = planRun(buildConfig({ ...base, parallelUsers: 3 }), rb);
    expect(three.estimatedMinutes).toBeLessThan(one.estimatedMinutes / 2);
  });
});
