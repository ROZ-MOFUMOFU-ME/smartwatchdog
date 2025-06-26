import { getCurrentTimestamp } from './date';

describe('getCurrentTimestamp', () => {
  it("'YYYY-MM-DD HH:mm:ss (JST)' 形式のタイムスタンプ文字列を返す", () => {
    const result = getCurrentTimestamp();
    // 例: 2024-01-01 12:34:56 (JST)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(JST\)$/);
  });
});
