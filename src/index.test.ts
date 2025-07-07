import type { Env } from './types';
import handler from './index';

let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeAll(() => {
  originalLog = console.log;
  originalError = console.error;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  // Node.jsでcrypto.subtleがなければダミーを生やす
  const g = globalThis as { crypto?: { subtle?: Record<string, unknown> } };
  if (!g.crypto) {
    g.crypto = {};
  }
  if (!g.crypto.subtle) {
    g.crypto.subtle = {};
  }
  g.crypto.subtle.importKey = async () => ({}) as CryptoKey;
  g.crypto.subtle.sign = async () => new Uint8Array([1, 2, 3, 4]);
});
afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
});

// グローバルfetch, KVNamespaceをモック
const mockPut = jest.fn();
const mockGet = jest.fn();
// body.cancel()を呼ばれてもエラーにならないようにReadableStreamを渡す
const mockBody = new ReadableStream() as unknown as { cancel: jest.Mock };
mockBody.cancel = jest.fn();

const env: Env = {
  GOOGLE_CLIENT_EMAIL: 'test@example.com',
  GOOGLE_PRIVATE_KEY:
    '-----BEGIN PRIVATE KEY-----\ndGVzdGRhdGE=\n-----END PRIVATE KEY-----',
  SPREADSHEET_ID: 'sheetid',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test',
  STATUS_KV: { get: mockGet, put: mockPut } as unknown as KVNamespace,
  DISCORD_MENTION_ROLE_ID: undefined,
  RANGE: 'A2:D',
};

// Node.js環境でatob/btoaを定義
if (typeof atob === 'undefined') {
  global.atob = (data: string) =>
    Buffer.from(data, 'base64').toString('binary');
}
if (typeof btoa === 'undefined') {
  global.btoa = (data: string) =>
    Buffer.from(data, 'binary').toString('base64');
}

describe('Cloudflare Worker Entrypoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(undefined);
    // fetchの正常系モック
    (global.fetch as jest.Mock) = jest.fn((url: unknown) => {
      if (
        typeof url === 'string' &&
        url.includes('sheets.googleapis.com/v4/spreadsheets/sheetid')
      ) {
        // メタデータ取得
        if (!url.includes('/values/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                sheets: [{ properties: { sheetId: 1, title: 'Sheet1' } }],
              }),
          } as Response);
        }
        // シートの値取得
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              values: [
                [
                  'Server1',
                  'https://a.com',
                  'OK: Status 200',
                  '2024-01-01 00:00:00',
                ],
              ],
            }),
        } as Response);
      }
      if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'dummy-token' }),
        } as Response);
      }
      if (typeof url === 'string' && url.includes('discord.com')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
  });

  it('fetch: 正常系で200レスポンス', async () => {
    const req = new Request('https://example.com');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; results: unknown };
    console.log('テストレスポンス:', body);
    expect(body.message).toMatch(/Server health check complete/);
    expect(body.results).toBeDefined();
  });

  it('fetch: Google Sheets APIエラー時は500', async () => {
    // fetchのモックをエラーに切り替え
    (global.fetch as jest.Mock).mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.includes('sheets.googleapis.com')) {
        return Promise.reject(new Error('sheets error'));
      }
      if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'dummy-token' }),
        } as Response);
      }
      if (typeof url === 'string' && url.includes('discord.com')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    const req = new Request('https://example.com');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sheets error/);
  });

  it('fetch: offset/limitパラメータのテスト', async () => {
    const req = new Request('https://example.com?offset=0&limit=5');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; results: unknown };
    expect(body.message).toMatch(/Server health check complete/);
  });

  it('fetch: 環境変数不足エラー', async () => {
    const incompleteEnv = { ...env };
    delete (incompleteEnv as unknown as { GOOGLE_CLIENT_EMAIL?: string })
      .GOOGLE_CLIENT_EMAIL;

    const req = new Request('https://example.com');
    const res = await handler.fetch(req, incompleteEnv);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Missing required environment variables/);
  });

  it('scheduled: cronトリガーのテスト', async () => {
    const event = {
      scheduledTime: Date.now(),
      cron: '*/10 * * * *',
    } as ScheduledEvent;

    const ctx = {
      waitUntil: jest.fn(),
      passThroughOnException: jest.fn(),
    } as unknown as ExecutionContext;

    await handler.scheduled(event, env, ctx);

    // cronトリガーが実行されることを確認（エラーが発生しないこと）
    expect(mockPut).toHaveBeenCalled();
  });

  it('fetch: KVエラー時の処理', async () => {
    mockGet.mockRejectedValue(new Error('KV error'));

    const req = new Request('https://example.com');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/KV error/);
  });

  it('fetch: Discord webhook エラー時の処理', async () => {
    // Discord API呼び出しをエラーにする
    (global.fetch as jest.Mock).mockImplementation((url: unknown) => {
      if (
        typeof url === 'string' &&
        url.includes('sheets.googleapis.com/v4/spreadsheets/sheetid')
      ) {
        if (!url.includes('/values/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                sheets: [{ properties: { sheetId: 1, title: 'Sheet1' } }],
              }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              values: [
                [
                  'Server1',
                  'https://a.com',
                  'OK: Status 200',
                  '2024-01-01 00:00:00',
                ],
              ],
            }),
        } as Response);
      }
      if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'dummy-token' }),
        } as Response);
      }
      if (typeof url === 'string' && url.includes('discord.com')) {
        return Promise.reject(new Error('Discord error'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });

    // 状態変化を検出させるため、KVから以前の状態を返す
    mockGet.mockResolvedValue(
      JSON.stringify({
        Server1: {
          status: 'ERROR: Status 500',
          lastUpdate: '2024-01-01 00:00:00',
        },
      })
    );

    const req = new Request('https://example.com');
    const res = await handler.fetch(req, env);

    // Discordエラーは処理を中断させる
    expect(res.status).toBe(500);
  });
});
