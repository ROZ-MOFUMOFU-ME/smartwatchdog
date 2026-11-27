import type { Env, ServerStatus } from './types';
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
        // バッチ取得（values:batchGet）はメタデータ分岐（/values/を含まない）より前に判定
        if (url.includes('values:batchGet')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                valueRanges: [
                  {
                    range: 'Sheet1!A2:D',
                    values: [
                      [
                        'Server1',
                        'https://a.com',
                        'OK: Status 200',
                        '2024-01-01 00:00:00',
                      ],
                    ],
                  },
                ],
              }),
          } as Response);
        }
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

  it('fetch: sheetId+title 指定時はmetadata取得を省略する（子invocation最適化）', async () => {
    const req = new Request('https://example.com?sheetId=1&title=Sheet1');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(200);

    const calls = (global.fetch as jest.Mock).mock.calls.map((c) =>
      String(c[0])
    );
    // 行取得は values:batchGet で行われる
    expect(calls.some((u) => u.includes('values:batchGet'))).toBe(true);
    // metadata（/v4/spreadsheets/sheetid で values/batchGet/batchUpdate を含まない）は呼ばれない
    const metadataCalled = calls.some(
      (u) =>
        u.includes('/v4/spreadsheets/sheetid') &&
        !u.includes('values:batchGet') &&
        !u.includes(':batchUpdate') &&
        !u.includes('/values/')
    );
    expect(metadataCalled).toBe(false);
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

  it('fetch: sheetId未指定でSELFありの場合はシート単位にファンアウトする', async () => {
    const selfFetch = jest.fn(
      async (_input: string | URL) => new Response('{}', { status: 200 })
    );
    const envWithSelf: Env = {
      ...env,
      SELF: { fetch: selfFetch } as unknown as Fetcher,
    };

    const req = new Request('https://example.com');
    const res = await handler.fetch(req, envWithSelf);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: string;
      dispatched: number;
    };
    expect(body.message).toMatch(/fanned out/i);
    // メタデータのシート(Sheet1)ごとに子をディスパッチ
    expect(body.dispatched).toBe(1);
    expect(selfFetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(selfFetch.mock.calls[0][0]);
    expect(calledUrl).toContain('sheetId=1');
    expect(calledUrl).toContain('title=Sheet1');
    expect(calledUrl).toContain('limit=40');
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
        // バッチ取得（values:batchGet）はメタデータ分岐（/values/を含まない）より前に判定
        if (url.includes('values:batchGet')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                valueRanges: [
                  {
                    range: 'Sheet1!A2:D',
                    values: [
                      [
                        'Server1',
                        'https://a.com',
                        'OK: Status 200',
                        '2024-01-01 00:00:00',
                      ],
                    ],
                  },
                ],
              }),
          } as Response);
        }
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

// 無料プランのKV書き込み上限（1日1,000回）対策: 状態に変化があったときだけ保存する
describe('KVへのステータス保存', () => {
  const STATUS_KEY = 'sheetid-1';
  const OLD_UPDATE = '2024-01-01 00:00:00 (JST)';
  // 子invocation相当（metadata取得を省く）でシート1枚分を処理させる
  const childRequest = () =>
    new Request('https://example.com?sheetId=1&title=Sheet1');

  // batchGetで返す行と、監視先URLごとのHTTPステータスを指定してfetchをモックする
  // sheetWriteStatus でシート書き込み（:batchUpdate）の応答ステータスを変えられる
  const mockFetch = (
    rows: string[][],
    statusByUrl: Record<string, number>,
    sheetWriteStatus = 200
  ) => {
    (global.fetch as jest.Mock) = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('values:batchGet')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ valueRanges: [{ values: rows }] }),
        } as Response);
      }
      if (u in statusByUrl) {
        return Promise.resolve(new Response(null, { status: statusByUrl[u] }));
      }
      if (u.includes(':batchUpdate') && sheetWriteStatus !== 200) {
        return Promise.resolve(
          new Response('rate limit exceeded', { status: sheetWriteStatus })
        );
      }
      // Discord通知・シート書き込み
      return Promise.resolve(new Response(null, { status: 200 }));
    });
  };

  // シートへの書き込みリクエスト（値・書式）の本文を取り出す
  const sheetWriteBodies = () => {
    const calls = (global.fetch as jest.Mock).mock.calls as [
      unknown,
      RequestInit | undefined,
    ][];
    const bodyOf = (pred: (u: string) => boolean) =>
      calls
        .filter(([url]) => pred(String(url)))
        .map(([, init]) => JSON.parse(String(init?.body)));
    return {
      values: bodyOf((u) => u.includes('values:batchUpdate')),
      format: bodyOf(
        (u) => u.includes(':batchUpdate') && !u.includes('values:batchUpdate')
      ),
    };
  };

  // KVの前回状態を返す。トークンキャッシュは常にヒットさせる
  const mockPrevStatuses = (prev: Record<string, ServerStatus>) => {
    mockGet.mockImplementation(async (key: string) =>
      key === STATUS_KEY ? JSON.stringify(prev) : 'cached-token'
    );
  };

  const statusPuts = () =>
    mockPut.mock.calls.filter(([key]) => key === STATUS_KEY);
  const fetchedUrls = () =>
    (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('状態に変化が無ければKVへ書き込まない', async () => {
    mockFetch([['Server1', 'https://a.com', 'OK: Status 200', OLD_UPDATE]], {
      'https://a.com': 200,
    });
    mockPrevStatuses({
      Server1: { status: 'OK: Status 200', lastUpdate: OLD_UPDATE },
    });

    const res = await handler.fetch(childRequest(), env);

    expect(res.status).toBe(200);
    expect(statusPuts()).toHaveLength(0);
    // 変化が無いのでDiscord通知もシート書き込みも行わない
    expect(fetchedUrls().some((u) => u.includes('discord.com'))).toBe(false);
    expect(fetchedUrls().some((u) => u.includes(':batchUpdate'))).toBe(false);
  });

  it('変化があればKVへ1回だけ保存し、変化していない行は前回の値を残す', async () => {
    mockFetch(
      [
        ['Server1', 'https://a.com'],
        ['Server2', 'https://b.com'],
        ['Server3', 'https://c.com'],
      ],
      { 'https://a.com': 200, 'https://b.com': 200, 'https://c.com': 500 }
    );
    mockPrevStatuses({
      Server1: { status: 'OK: Status 200', lastUpdate: OLD_UPDATE }, // 変化なし
      Server2: { status: 'ERROR: Status 500', lastUpdate: OLD_UPDATE }, // 復旧
      // Server3 は未登録（初回）
    });

    const res = await handler.fetch(childRequest(), env);

    expect(res.status).toBe(200);
    expect(statusPuts()).toHaveLength(1);
    const saved = JSON.parse(statusPuts()[0][1]) as Record<
      string,
      ServerStatus
    >;
    expect(saved.Server1).toEqual({
      status: 'OK: Status 200',
      lastUpdate: OLD_UPDATE,
    });
    expect(saved.Server2.status).toBe('OK: Status 200');
    expect(saved.Server2.lastUpdate).not.toBe(OLD_UPDATE);
    expect(saved.Server3.status).toBe('ERROR: Status 500');
  });

  it('KVはOKでもシートのC列がERRORのままなら、通知せずにシートだけ書き直す', async () => {
    mockFetch(
      [['Server1', 'https://a.com', 'ERROR: TCP Port Unreachable', OLD_UPDATE]],
      { 'https://a.com': 200 }
    );
    mockPrevStatuses({
      Server1: { status: 'OK: Status 200', lastUpdate: OLD_UPDATE },
    });

    const res = await handler.fetch(childRequest(), env);

    expect(res.status).toBe(200);
    // KVの前回値からは変化していないので、通知もKV保存もしない
    expect(fetchedUrls().some((u) => u.includes('discord.com'))).toBe(false);
    expect(statusPuts()).toHaveLength(0);
    // シートのC列・D列を現在の状態で書き直し、背景色も元に戻す
    const { values, format } = sheetWriteBodies();
    expect(values).toHaveLength(1);
    expect(values[0].data).toEqual([
      {
        range: 'Sheet1!C2:D2',
        values: [['OK: Status 200', expect.any(String)]],
      },
    ]);
    expect(format).toHaveLength(1);
    expect(format[0].requests[0].repeatCell.cell).toEqual({
      userEnteredFormat: {},
    });
  });

  it('シートへの書き込みに失敗してもKVは保存し、エラーをログに残す', async () => {
    mockFetch(
      [['Server1', 'https://a.com', 'OK: Status 200', OLD_UPDATE]],
      { 'https://a.com': 500 },
      429
    );
    mockPrevStatuses({
      Server1: { status: 'OK: Status 200', lastUpdate: OLD_UPDATE },
    });

    const res = await handler.fetch(childRequest(), env);

    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Google Sheets API error')
    );
    // 通知の重複を防ぐためKVは保存する。シートは次の監視でC列の食い違いとして書き直される
    expect(statusPuts()).toHaveLength(1);
    expect(JSON.parse(statusPuts()[0][1]).Server1.status).toBe(
      'ERROR: Status 500'
    );
  });
});

// 手動実行の保護: TRIGGER_TOKEN を設定すると、トークンの無いHTTPアクセスを拒否する
describe('TRIGGER_TOKEN による認可', () => {
  const TOKEN = 'test-trigger-token';
  const envWithToken: Env = { ...env, TRIGGER_TOKEN: TOKEN };
  const authHeader = { Authorization: `Bearer ${TOKEN}` };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(undefined);
    (global.fetch as jest.Mock) = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('values:batchGet')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ valueRanges: [{ values: [] }] }),
        } as Response);
      }
      if (u.includes('oauth2.googleapis.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'dummy-token' }),
        } as Response);
      }
      // シート一覧（メタデータ）
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sheets: [{ properties: { sheetId: 1, title: 'Sheet1' } }],
          }),
      } as Response);
    });
  });

  it('トークンが無いアクセスは401を返し、監視処理を実行しない', async () => {
    const res = await handler.fetch(
      new Request('https://example.com'),
      envWithToken
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('トークンが違うアクセスは401を返す', async () => {
    const req = new Request('https://example.com?sheetId=1&title=Sheet1', {
      headers: { Authorization: 'Bearer wrong-token' },
    });

    const res = await handler.fetch(req, envWithToken);

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('正しいトークンなら実行できる', async () => {
    const req = new Request('https://example.com?sheetId=1&title=Sheet1', {
      headers: authHeader,
    });

    const res = await handler.fetch(req, envWithToken);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/Server health check complete/);
  });

  it('ファンアウトの子invocationにも同じトークンを付けて呼ぶ', async () => {
    const selfFetch = jest.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 })
    );
    const envWithSelf: Env = {
      ...envWithToken,
      SELF: { fetch: selfFetch } as unknown as Fetcher,
    };

    const res = await handler.fetch(
      new Request('https://example.com', { headers: authHeader }),
      envWithSelf
    );

    expect(res.status).toBe(200);
    expect(selfFetch).toHaveBeenCalledTimes(1);
    const init = selfFetch.mock.calls[0][1];
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Bearer ${TOKEN}`
    );
  });
});
