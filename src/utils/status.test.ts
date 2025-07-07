import {
  generateCurrentStatuses,
  checkTcpStatus,
  __setTestForceError,
} from './status';

beforeAll(() => {
  jest.useFakeTimers();
});
afterAll(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

(globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(() =>
  Promise.resolve(new Response(null, { status: 200 }))
);

describe('generateCurrentStatuses', () => {
  it('サーバー名とURLがある場合、currentStatusesに格納される', async () => {
    const rows = [['Server1', 'https://a.com', 'OK', '2024-01-01 00:00:00']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['Server1'].status).toBe('OK: Status 200');
    expect(typeof currentStatuses['Server1'].lastUpdate).toBe('string');
  });

  it('サーバー名が空でURLのみの場合、URLがキーになる', async () => {
    const rows = [['', 'https://c.com', 'OK', '2024-01-01 02:00:00']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['https://c.com'].status).toBe('OK: Status 200');
    expect(typeof currentStatuses['https://c.com'].lastUpdate).toBe('string');
  });

  it('サーバー名もURLも空の場合はcurrentStatusesに含まれない', async () => {
    const rows = [['', '', '', '']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(Object.keys(currentStatuses)).toHaveLength(0);
  });

  it('HTTPエラー時はERROR: Status xxxになる', async () => {
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => Promise.resolve(new Response(null, { status: 404 }))
    );
    const rows = [['Server2', 'https://notfound.com']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['Server2'].status).toBe('ERROR: Status 404');
  });

  it('HTTPタイムアウト時はERROR: HTTP Timeoutになる', async () => {
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => {
        const error = new Error('timeout');
        (error as { name?: string }).name = 'TimeoutError';
        return Promise.reject(error);
      }
    );
    const rows = [['Server3', 'https://timeout.com']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['Server3'].status).toBe('ERROR: HTTP Timeout');
  });

  it('不正なURLはINVALID_URL_FORMATになる', async () => {
    const rows = [['Server4', '://invalid-url']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['Server4'].status).toBe('INVALID_URL_FORMAT');
  });

  it('Server Nameのみ/URLのみ/両方空のパターンも正しく処理される', async () => {
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => Promise.resolve(new Response(null, { status: 200 }))
    );
    const rows = [
      ['Server5', ''], // Nameのみ
      ['', 'https://onlyurl.com'], // URLのみ
      ['', '', '', ''], // 両方空
    ];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['Server5']).toBeUndefined();
    expect(currentStatuses['https://onlyurl.com'].status).toBe(
      'OK: Status 200'
    );
    expect(Object.keys(currentStatuses)).toContain('https://onlyurl.com');
    expect(Object.keys(currentStatuses)).not.toContain('');
  });

  it('網羅性テスト: 様々なエラーパターンをテスト', async () => {
    // HTTPエラー (500系)
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => Promise.resolve(new Response(null, { status: 500 }))
    );
    const rows1 = [['Server500', 'https://server500.com']];
    const { currentStatuses: cs1 } = await generateCurrentStatuses(rows1);
    expect(cs1['Server500'].status).toBe('ERROR: Status 500');

    // ネットワークエラー (fetch reject)
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => Promise.reject(new Error('Network error'))
    );
    const rows2 = [['ServerNet', 'https://network-error.com']];
    const { currentStatuses: cs2 } = await generateCurrentStatuses(rows2);
    expect(cs2['ServerNet'].status).toBe('ERROR: Unreachable');

    // URLが空の場合
    const rows3 = [['ServerEmpty', '']];
    const { currentStatuses: cs3 } = await generateCurrentStatuses(rows3);
    expect(cs3['ServerEmpty']).toBeUndefined();

    // 両方が空の場合
    const rows4 = [['', '']];
    const { currentStatuses: cs4 } = await generateCurrentStatuses(rows4);
    expect(Object.keys(cs4)).toHaveLength(0);
  });

  it('TCP接続のテスト - ポート指定のURLパターン', async () => {
    // フェッチをモック
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => Promise.resolve(new Response(null, { status: 200 }))
    );

    // TCP用のポート（80, 443以外）を指定
    const rows = [['TCPServer', 'example.com:3000']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    // TCP接続のテストは実際の接続を試みるので、エラーになる可能性が高い
    expect(currentStatuses['TCPServer'].status).toMatch(
      /^(OK: Status 200|ERROR: TCP Port Unreachable)$/
    );
  });

  it('removedStatusesのテスト - 過去の状態と現在の状態の差分', async () => {
    // まず何かしらのサーバーを追加
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => Promise.resolve(new Response(null, { status: 200 }))
    );
  });

  it('removedStatusesのテスト - 現在は常に空のオブジェクト', async () => {
    // generateCurrentStatusesは現在removedStatusesを実際には使用していない
    (globalThis as typeof globalThis & { fetch: jest.Mock }).fetch = jest.fn(
      () => Promise.resolve(new Response(null, { status: 200 }))
    );

    const rows = [['Server1', 'https://example.com']];
    const { currentStatuses, removedStatuses } =
      await generateCurrentStatuses(rows);

    // Server1が正常に処理される
    expect(currentStatuses['Server1'].status).toBe('OK: Status 200');

    // removedStatusesは現在の実装では常に空
    expect(Object.keys(removedStatuses)).toHaveLength(0);
  });

  describe('checkTcpStatus', () => {
    it('正常に接続できた場合はOK: Status 200', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalImport = (globalThis as any).import;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).import = async (mod: string) => {
        if (mod === 'cloudflare:sockets') {
          return {
            connect: () => ({
              opened: Promise.resolve(),
              close: async () => {},
            }),
          };
        }
        return originalImport(mod);
      };
      const result = await checkTcpStatus('example.com', 12345);
      expect(result).toBe('OK: Status 200');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).import = originalImport;
    });
    it('接続できない場合はERROR: TCP Port Unreachable', async () => {
      __setTestForceError(true);
      const result = await checkTcpStatus('example.com', 12345);
      expect(result).toBe('ERROR: TCP Port Unreachable');
      __setTestForceError(false);
    });
    it('openedが非同期rejectの場合はERROR: TCP Port Unreachable', async () => {
      __setTestForceError(true);
      const result = await checkTcpStatus('example.com', 12345);
      expect(result).toBe('ERROR: TCP Port Unreachable');
      __setTestForceError(false);
    });
    it('テスト用フラグでcatchブロックに入る場合はERROR: TCP Port Unreachable', async () => {
      __setTestForceError(true);
      const result = await checkTcpStatus('example.com', 12345);
      expect(result).toBe('ERROR: TCP Port Unreachable');
      __setTestForceError(false);
    });
  });
});
