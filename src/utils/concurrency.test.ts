import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('同時に走る処理を limit 件までに抑え、結果は入力と同じ順に返す', async () => {
    let running = 0;
    let maxRunning = 0;
    const items = [30, 5, 20, 1, 15, 10, 25, 2];
    const results = await mapWithConcurrency(items, 3, async (ms, i) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return `${i}:${ms}`;
    });
    expect(maxRunning).toBe(3);
    expect(results).toEqual(items.map((ms, i) => `${i}:${ms}`));
  });

  it('空の入力では何も実行しない', async () => {
    const fn = jest.fn(async () => 1);
    expect(await mapWithConcurrency([], 5, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
