import * as index from './index';
import https from 'https';

jest.mock('https');

// sendSlackNotificationのテスト
describe('sendSlackNotification', () => {
  it('Slack通知が正常に送信される', async () => {
    const reqMock = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    (https.request as jest.Mock).mockImplementation((_opts, cb) => {
      cb({ setEncoding: jest.fn(), on: (ev: string, cb2: any) => { if (ev === 'end') cb2(); } });
      return reqMock;
    });
    await expect(index.sendSlackNotification({ status: 'OK' }, 'recovery')).resolves.toBeUndefined();
    expect(reqMock.write).toHaveBeenCalled();
    expect(reqMock.end).toHaveBeenCalled();
  });

  it('Slack通知でエラー時はrejectされる', async () => {
    const reqMock: any = {
      on: jest.fn((event: string, handler: (error: Error) => void) => {
        if (event === 'error') {
          // errorイベントを即時発火
          setImmediate(() => handler(new Error('fail')));
        }
        return reqMock;
      }),
      write: jest.fn(),
      end: jest.fn(),
    };
    (https.request as jest.Mock).mockImplementation((_opts, _cb) => reqMock);
    await expect(index.sendSlackNotification({ status: 'NG' }, 'error')).rejects.toBeDefined();
  });
});

// updateSheetのテスト雛形
describe('updateSheet', () => {
  it('Google Sheets APIが呼ばれる', async () => {
    const batchUpdateMock = jest.fn().mockResolvedValue({});
    const getMock = jest.fn().mockResolvedValue({ data: { sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] } });
    const sheetsApiMock = { spreadsheets: { batchUpdate: batchUpdateMock, get: getMock } };
    jest.spyOn(index.google, 'sheets').mockReturnValue(sheetsApiMock as any);
    
    // 実際にデータがある場合のテスト
    const mockResults = [
      { status: 'fulfilled', value: { index: 0, status: 'OK', lastUpdate: '2024-01-01', color: 'white' } }
    ] as any;
    
    await expect(index.updateSheet('sheetId', 'Sheet1!A2:D', mockResults)).resolves.toBeUndefined();
    expect(batchUpdateMock).toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });

  it('APIエラー時はthrowされる', async () => {
    const batchUpdateMock = jest.fn().mockRejectedValue(new Error('api error'));
    const getMock = jest.fn().mockResolvedValue({ data: { sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] } });
    const sheetsApiMock = { spreadsheets: { batchUpdate: batchUpdateMock, get: getMock } };
    jest.spyOn(index.google, 'sheets').mockReturnValue(sheetsApiMock as any);
    
    // 実際にデータがある場合のテスト
    const mockResults = [
      { status: 'fulfilled', value: { index: 0, status: 'OK', lastUpdate: '2024-01-01', color: 'white' } }
    ] as any;
    
    await expect(index.updateSheet('sheetId', 'Sheet1!A2:D', mockResults)).rejects.toThrow('api error');
    expect(getMock).toHaveBeenCalled();
  });

  it('空の結果の場合はAPIが呼ばれない', async () => {
    const batchUpdateMock = jest.fn().mockResolvedValue({});
    const getMock = jest.fn().mockResolvedValue({ data: { sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] } });
    const sheetsApiMock = { spreadsheets: { batchUpdate: batchUpdateMock, get: getMock } };
    jest.spyOn(index.google, 'sheets').mockReturnValue(sheetsApiMock as any);
    
    await expect(index.updateSheet('sheetId', 'Sheet1!A2:D', [])).resolves.toBeUndefined();
    expect(batchUpdateMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });
}); 