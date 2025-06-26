import https from 'https';
import type { sheets_v4 } from 'googleapis';
import type { SheetUpdateResult } from './types';
import * as index from './index';

type Sheets = sheets_v4.Sheets;

type ReqMock = {
  on: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
};

jest.mock('https');

// sendSlackNotificationのテスト
describe('sendSlackNotification', () => {
  it('Slack通知が正常に送信される', async () => {
    const reqMock: ReqMock = {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    (https.request as jest.Mock).mockImplementation(
      (
        _opts: unknown,
        cb: (res: {
          setEncoding: jest.Mock;
          on: (ev: string, cb2: () => void) => void;
        }) => void
      ) => {
        cb({
          setEncoding: jest.fn(),
          on: (ev: string, cb2: () => void) => {
            if (ev === 'end') cb2();
          },
        });
        return reqMock;
      }
    );
    await expect(
      index.sendSlackNotification({ status: 'OK' }, 'recovery')
    ).resolves.toBeUndefined();
    expect(reqMock.write).toHaveBeenCalled();
    expect(reqMock.end).toHaveBeenCalled();
  });

  it('Slack通知でエラー時はrejectされる', async () => {
    const reqMock: ReqMock & { on: jest.Mock } = {
      on: jest.fn((event: string, handler: (error: Error) => void) => {
        if (event === 'error') {
          setImmediate(() => handler(new Error('fail')));
        }
        return reqMock;
      }),
      write: jest.fn(),
      end: jest.fn(),
    };
    (https.request as jest.Mock).mockImplementation(() => reqMock);
    await expect(
      index.sendSlackNotification({ status: 'NG' }, 'error')
    ).rejects.toBeDefined();
  });
});

// updateSheetのテスト雛形
describe('updateSheet', () => {
  function createSheetsApiMock(
    batchUpdateMock: jest.Mock,
    getMock: jest.Mock
  ): Sheets {
    // 必要なプロパティをundefinedで埋める
    return {
      spreadsheets: {
        batchUpdate: batchUpdateMock,
        get: getMock,
        context: undefined,
        developerMetadata: undefined,
        sheets: undefined,
        values: undefined,
      } as unknown as sheets_v4.Resource$Spreadsheets,
    } as Sheets;
  }

  it('Google Sheets APIが呼ばれる', async () => {
    const batchUpdateMock = jest.fn().mockResolvedValue({});
    const getMock = jest.fn().mockResolvedValue({
      data: { sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] },
    });
    const sheetsApiMock = createSheetsApiMock(batchUpdateMock, getMock);
    jest.spyOn(index.google, 'sheets').mockReturnValue(sheetsApiMock);

    const mockResults: PromiseFulfilledResult<SheetUpdateResult>[] = [
      {
        status: 'fulfilled',
        value: {
          index: 0,
          status: 'OK',
          lastUpdate: '2024-01-01',
          color: 'white',
        },
      },
    ];

    await expect(
      index.updateSheet(
        'sheetId',
        'Sheet1!A2:D',
        mockResults as PromiseSettledResult<SheetUpdateResult | null>[]
      )
    ).resolves.toBeUndefined();
    expect(batchUpdateMock).toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });

  it('APIエラー時はthrowされる', async () => {
    const batchUpdateMock = jest.fn().mockRejectedValue(new Error('api error'));
    const getMock = jest.fn().mockResolvedValue({
      data: { sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] },
    });
    const sheetsApiMock = createSheetsApiMock(batchUpdateMock, getMock);
    jest.spyOn(index.google, 'sheets').mockReturnValue(sheetsApiMock);

    const mockResults: PromiseFulfilledResult<SheetUpdateResult>[] = [
      {
        status: 'fulfilled',
        value: {
          index: 0,
          status: 'OK',
          lastUpdate: '2024-01-01',
          color: 'white',
        },
      },
    ];

    await expect(
      index.updateSheet(
        'sheetId',
        'Sheet1!A2:D',
        mockResults as PromiseSettledResult<SheetUpdateResult | null>[]
      )
    ).rejects.toThrow('api error');
    expect(getMock).toHaveBeenCalled();
  });

  it('空の結果の場合はAPIが呼ばれない', async () => {
    const batchUpdateMock = jest.fn().mockResolvedValue({});
    const getMock = jest.fn().mockResolvedValue({
      data: { sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] },
    });
    const sheetsApiMock = createSheetsApiMock(batchUpdateMock, getMock);
    jest.spyOn(index.google, 'sheets').mockReturnValue(sheetsApiMock);

    await expect(
      index.updateSheet('sheetId', 'Sheet1!A2:D', [])
    ).resolves.toBeUndefined();
    expect(batchUpdateMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });
});
