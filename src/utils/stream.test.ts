import { Readable } from 'stream';
import { describe, it, expect } from '@jest/globals';
import { streamToString } from './stream';

describe('streamToString', () => {
  it('正常なストリームを文字列に変換できる', async () => {
    const readable = Readable.from([
      Buffer.from('hello'),
      Buffer.from(' '),
      Buffer.from('world'),
    ]);
    const result = await streamToString(readable);
    expect(result).toBe('hello world');
  });
});
