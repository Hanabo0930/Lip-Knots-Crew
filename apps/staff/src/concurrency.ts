export async function runWithConcurrency<Item>(
  items: Item[],
  concurrency: number,
  worker: (item: Item, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item, index);
    }
  });

  const results = await Promise.allSettled(workers);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}
