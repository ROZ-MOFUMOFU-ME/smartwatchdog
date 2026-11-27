import { getGoogleAccessToken } from './google_jwt';
import {
  DiscordWebhookError,
  fetchAllSheets,
  fetchSheetsRows,
  sendDiscordWebhook,
} from './sheets_fetch';

// Mock dependencies
jest.mock('./google_jwt');

// Mock global fetch
global.fetch = jest.fn();

const mockGetGoogleAccessToken = getGoogleAccessToken as jest.MockedFunction<
  typeof getGoogleAccessToken
>;

describe('sheets_fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGoogleAccessToken.mockResolvedValue('mock_access_token');
    // console.errorをモックしてテスト時のログを非表示に
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // console.errorのモックを復元
    jest.restoreAllMocks();
  });

  describe('fetchAllSheets', () => {
    it('should return sheet metadata successfully', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: 'Sheet1',
              },
            },
            {
              properties: {
                sheetId: 123456789,
                title: 'Sheet2',
              },
            },
          ],
        }),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      const result = await fetchAllSheets(
        'test@example.com',
        'private-key',
        'spreadsheet-id'
      );

      expect(result).toEqual([
        { sheetId: 0, title: 'Sheet1' },
        { sheetId: 123456789, title: 'Sheet2' },
      ]);
      expect(mockGetGoogleAccessToken).toHaveBeenCalledWith(
        'test@example.com',
        'private-key',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        undefined
      );
    });

    it('should throw error when API request fails', async () => {
      const mockResponse = {
        ok: false,
        text: jest.fn().mockResolvedValue('API Error'),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await expect(
        fetchAllSheets('test@example.com', 'private-key', 'spreadsheet-id')
      ).rejects.toThrow('Failed to fetch sheet metadata: API Error');
    });

    it('should throw error when no sheets found', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          sheets: [],
        }),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await expect(
        fetchAllSheets('test@example.com', 'private-key', 'spreadsheet-id')
      ).rejects.toThrow('No sheets found in spreadsheet');
    });
  });

  describe('fetchSheetsRows', () => {
    it('レンジと同じ順で行を返し、値の無いレンジは空配列にする', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          valueRanges: [{ values: [['Server1', 'https://a.com']] }, {}],
        }),
      });

      const result = await fetchSheetsRows(
        'test@example.com',
        'private-key',
        'spreadsheet-id',
        ['Sheet1!A2:D', 'Sheet2!A2:D']
      );

      expect(result).toEqual([[['Server1', 'https://a.com']], []]);
      const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
      expect(url).toContain('values:batchGet');
      expect(url).toContain(`ranges=${encodeURIComponent('Sheet2!A2:D')}`);
    });

    it('APIがエラーを返したら例外を投げる', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('quota exceeded'),
      });

      await expect(
        fetchSheetsRows('test@example.com', 'private-key', 'spreadsheet-id', [
          'Sheet1!A2:D',
        ])
      ).rejects.toThrow('Failed to fetch sheet rows (batch): quota exceeded');
    });
  });

  describe('sendDiscordWebhook', () => {
    it('本文とembedを送り、使わない応答のbodyは閉じる', async () => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 204,
        body: { cancel },
      });

      await sendDiscordWebhook('https://discord.example/webhook', 'hello', {
        title: 't',
      });

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://discord.example/webhook');
      expect(JSON.parse(init.body)).toEqual({
        content: 'hello',
        embeds: [{ title: 't' }],
      });
      expect(cancel).toHaveBeenCalled();
    });

    // 送信の失敗を捕まえて、送り直す見込みがあるか（retryable）を確かめる
    const sendAndCatch = async () => {
      try {
        await sendDiscordWebhook('https://discord.example/webhook', 'hello');
      } catch (err) {
        return err as DiscordWebhookError;
      }
      throw new Error('sendDiscordWebhook did not throw');
    };

    it('回数制限（429）やDiscord側の障害（5xx）は、送り直せるエラーにする', async () => {
      for (const status of [429, 500, 503]) {
        (global.fetch as jest.Mock).mockResolvedValueOnce(
          new Response('{"message": "x"}', { status })
        );
        const err = await sendAndCatch();
        expect(err).toBeInstanceOf(DiscordWebhookError);
        expect(err.retryable).toBe(true);
        expect(err.message).toContain(`HTTP ${status}`);
      }
    });

    it('通信エラーも、送り直せるエラーにする', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('Network connection lost.')
      );
      const err = await sendAndCatch();
      expect(err.retryable).toBe(true);
      expect(err.message).toContain('Network connection lost.');
    });

    it('Webhook URLの誤りなど（4xx）は、送り直しても届かないエラーにする', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response('{"message": "Unknown Webhook", "code": 10015}', {
          status: 404,
        })
      );
      const err = await sendAndCatch();
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Unknown Webhook');
    });
  });
});
