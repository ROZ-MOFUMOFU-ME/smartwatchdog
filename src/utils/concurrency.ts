// items を同時に limit 件までずつ処理する。結果は items と同じ順に返す。
// Workers は1回の呼び出しで同時に開ける接続が6本までで、それを超えた分は待たされる。
// 全件を一度に始めると、その待ち時間までタイムアウトに数えられて誤検知になるため、
// 同時に走らせるチェックを上限内に抑える。
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
