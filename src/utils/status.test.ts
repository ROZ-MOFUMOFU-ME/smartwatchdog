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
