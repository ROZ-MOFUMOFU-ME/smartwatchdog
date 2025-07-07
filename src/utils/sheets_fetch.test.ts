import { getGoogleAccessToken } from './google_jwt';
import {
  fetchAllSheets,
  fetchSheetValues,
  fetchSheetRows,
  updateSheetStatuses,
} from './sheets_fetch';
import { generateCurrentStatuses } from './status';

// Mock dependencies
jest.mock('./google_jwt');
jest.mock('./status');

// Mock global fetch
global.fetch = jest.fn();

const mockGetGoogleAccessToken = getGoogleAccessToken as jest.MockedFunction<
  typeof getGoogleAccessToken
>;
const mockGenerateCurrentStatuses =
  generateCurrentStatuses as jest.MockedFunction<
    typeof generateCurrentStatuses
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
        'https://www.googleapis.com/auth/spreadsheets.readonly'
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

  describe('fetchSheetValues', () => {
    it('should return sheet values successfully', async () => {
      // Mock fetchAllSheets call
      const mockSheetsResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: 'Sheet1',
              },
            },
          ],
        }),
      };

      // Mock sheet values call
      const mockValuesResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          values: [
            ['Name', 'URL', 'Status', 'Updated'],
            ['Server1', 'https://example.com', 'OK', '2025-07-01'],
          ],
        }),
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockSheetsResponse)
        .mockResolvedValueOnce(mockValuesResponse);

      const result = await fetchSheetValues(
        'test@example.com',
        'private-key',
        'spreadsheet-id'
      );

      expect(result).toEqual({
        values: [
          ['Name', 'URL', 'Status', 'Updated'],
          ['Server1', 'https://example.com', 'OK', '2025-07-01'],
        ],
      });
    });

    it('should throw error when values fetch fails', async () => {
      // Mock fetchAllSheets call (success)
      const mockSheetsResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: 'Sheet1',
              },
            },
          ],
        }),
      };

      // Mock sheet values call (failure)
      const mockValuesResponse = {
        ok: false,
        text: jest.fn().mockResolvedValue('Values API Error'),
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockSheetsResponse)
        .mockResolvedValueOnce(mockValuesResponse);

      await expect(
        fetchSheetValues('test@example.com', 'private-key', 'spreadsheet-id')
      ).rejects.toThrow('Failed to fetch sheet values: Values API Error');
    });
  });

  describe('fetchSheetRows', () => {
    it('should return sheet rows successfully', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          values: [
            ['Name', 'URL', 'Status', 'Updated'],
            ['Server1', 'https://example.com', 'OK', '2025-07-01'],
            ['Server2', 'https://api.example.com', 'ERROR', '2025-07-01'],
          ],
        }),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      const result = await fetchSheetRows(
        'test@example.com',
        'private-key',
        'spreadsheet-id',
        'Sheet1!A1:D10'
      );

      expect(result).toEqual([
        ['Name', 'URL', 'Status', 'Updated'],
        ['Server1', 'https://example.com', 'OK', '2025-07-01'],
        ['Server2', 'https://api.example.com', 'ERROR', '2025-07-01'],
      ]);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://sheets.googleapis.com/v4/spreadsheets/spreadsheet-id/values/Sheet1!A1%3AD10',
        expect.objectContaining({
          headers: { Authorization: 'Bearer mock_access_token' },
        })
      );
    });

    it('should return empty array when no values', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      const result = await fetchSheetRows(
        'test@example.com',
        'private-key',
        'spreadsheet-id',
        'Sheet1!A1:D10'
      );

      expect(result).toEqual([]);
    });

    it('should throw error when API request fails', async () => {
      const mockResponse = {
        ok: false,
        text: jest.fn().mockResolvedValue('Rows API Error'),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await expect(
        fetchSheetRows(
          'test@example.com',
          'private-key',
          'spreadsheet-id',
          'Sheet1!A1:D10'
        )
      ).rejects.toThrow('Failed to fetch sheet rows: Rows API Error');
    });
  });

  describe('updateSheetStatuses', () => {
    it('should handle case with no rows to update', async () => {
      // Mock fetchSheetRows to return empty data
      const mockRowsResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ values: [] }),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockRowsResponse);

      mockGenerateCurrentStatuses.mockResolvedValue({
        currentStatuses: {},
        removedStatuses: {},
      });

      const result = await updateSheetStatuses(
        'test@example.com',
        'private-key',
        'spreadsheet-id',
        'Sheet1',
        'A2:D',
        0
      );

      expect(result).toEqual({ updatedRows: [] });
    });

    it('should throw error when sheet rows fetch fails', async () => {
      const mockResponse = {
        ok: false,
        text: jest.fn().mockResolvedValue('Update API Error'),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await expect(
        updateSheetStatuses(
          'test@example.com',
          'private-key',
          'spreadsheet-id',
          'Sheet1',
          'A2:D',
          0
        )
      ).rejects.toThrow('Failed to fetch sheet rows: Update API Error');
    });
  });
});
