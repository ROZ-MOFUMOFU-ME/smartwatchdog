import { getCurrentJST } from './date';

describe('getCurrentJST', () => {
  it('JST表記の時刻文字列を返す', () => {
    const result = getCurrentJST();
    expect(result).toMatch(/UTC\+0900 \(JST\)$/);
  });
});
