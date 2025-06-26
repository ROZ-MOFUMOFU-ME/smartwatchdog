import type { Env } from './types';
import handler from './index';

let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeAll(() => {
  originalLog = console.log;
  originalError = console.error;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
});

// グローバルfetch, googleapis, KVNamespaceをモック
const mockPut = jest.fn();
const mockGet = jest.fn();
const mockSheetsGet = jest.fn();
const mockSheetsValuesGet = jest.fn();
const mockSheetsBatchUpdate = jest.fn();
// body.cancel()を呼ばれてもエラーにならないようにReadableStreamを渡す
const mockBody = new ReadableStream() as unknown as { cancel: jest.Mock };
mockBody.cancel = jest.fn();
const mockDiscordFetch = jest.fn(() =>
  Promise.resolve(new Response(null, { status: 204 }))
);

jest.mock('googleapis', () => {
  const sheets = () => ({
    spreadsheets: {
      get: mockSheetsGet,
      values: { get: mockSheetsValuesGet },
      batchUpdate: mockSheetsBatchUpdate,
    },
  });
  return {
    google: {
      sheets,
      auth: {
        GoogleAuth: jest.fn().mockImplementation(() => ({
          getClient: () => ({}),
        })),
      },
      options: jest.fn(),
    },
  };
});

(globalThis as typeof globalThis & { fetch: jest.Mock }).fetch =
  mockDiscordFetch;

const env: Env = {
  GOOGLE_CLIENT_EMAIL: 'test@example.com',
  GOOGLE_PRIVATE_KEY: 'dummy',
  SPREADSHEET_ID: 'sheetid',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test',
  STATUS_KV: { get: mockGet, put: mockPut } as unknown as KVNamespace,
  DISCORD_MENTION_ROLE_ID: undefined,
};

describe('Cloudflare Worker Entrypoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(undefined);
    mockSheetsGet.mockResolvedValue({
      data: {
        sheets: [{ properties: { sheetId: 1, title: 'Sheet1' } }],
      },
    });
    mockSheetsValuesGet.mockResolvedValue({
      data: { values: [['Server1', 'https://a.com']] },
    });
    mockSheetsBatchUpdate.mockResolvedValue({});
  });

  it('fetch: 正常系で200レスポンス', async () => {
    const req = new Request('https://example.com');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/Server health check complete/);
    expect(mockDiscordFetch).toHaveBeenCalled();
    expect(mockPut).toHaveBeenCalled();
  });

  it('fetch: Google Sheets APIエラー時は500', async () => {
    mockSheetsGet.mockRejectedValueOnce(new Error('sheets error'));
    const req = new Request('https://example.com');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sheets error/);
  });

  it('scheduled: 正常系でエラーなく完了', async () => {
    await expect(
      handler.scheduled({} as ScheduledController, env)
    ).resolves.toBeUndefined();
    expect(mockDiscordFetch).toHaveBeenCalled();
    expect(mockPut).toHaveBeenCalled();
  });

  it('scheduled: Google Sheets APIエラー時もcatchされる', async () => {
    mockSheetsGet.mockRejectedValueOnce(new Error('sheets error'));
    await expect(
      handler.scheduled({} as ScheduledController, env)
    ).resolves.toBeUndefined();
  });
});
