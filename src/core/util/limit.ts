/**
 * Runs `fn` for every item with at most `limit` running at the same time.
 * Results come back in the same order as `items`, whatever order they finish in.
 * If any call throws, the first error is rethrown after the running calls have settled.
 */
export async function runLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown = null;
  const worker = async () => {
    while (next < items.length && firstError === null) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (e) {
        firstError ??= e;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  if (firstError !== null) throw firstError;
  return results;
}
