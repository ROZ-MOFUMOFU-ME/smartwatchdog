import { getGoogleAccessToken } from './google_jwt';

// Mock crypto.subtle
const mockCrypto = {
  subtle: {
    importKey: jest.fn(),
    sign: jest.fn(),
  },
};

// Mock global crypto
Object.defineProperty(global, 'crypto', {
  value: mockCrypto,
  writable: true,
});

// Mock global fetch
global.fetch = jest.fn();

describe('google_jwt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getGoogleAccessToken', () => {
    it('should return access token on successful request', async () => {
      // Mock private key import
      const mockPrivateKey = {};
      mockCrypto.subtle.importKey.mockResolvedValue(mockPrivateKey);

      // Mock signing
      const mockSignature = new ArrayBuffer(256);
      mockCrypto.subtle.sign.mockResolvedValue(mockSignature);

      // Mock fetch response
      const mockResponse = {
        json: jest.fn().mockResolvedValue({
          access_token: 'mock_access_token',
        }),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      const result = await getGoogleAccessToken(
        'test@example.com',
        '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC5d1lZ\n-----END PRIVATE KEY-----',
        'https://www.googleapis.com/auth/spreadsheets'
      );

      expect(result).toBe('mock_access_token');
      expect(mockCrypto.subtle.importKey).toHaveBeenCalled();
      expect(mockCrypto.subtle.sign).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: expect.stringContaining('grant_type='),
        })
      );
    });

    it('should throw error when no access token is returned', async () => {
      // Mock private key import
      const mockPrivateKey = {};
      mockCrypto.subtle.importKey.mockResolvedValue(mockPrivateKey);

      // Mock signing
      const mockSignature = new ArrayBuffer(256);
      mockCrypto.subtle.sign.mockResolvedValue(mockSignature);

      // Mock fetch response without access token
      const mockResponse = {
        json: jest.fn().mockResolvedValue({
          error: 'invalid_grant',
        }),
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await expect(
        getGoogleAccessToken(
          'test@example.com',
          '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC5d1lZ\n-----END PRIVATE KEY-----',
          'https://www.googleapis.com/auth/spreadsheets'
        )
      ).rejects.toThrow('Failed to get access token');
    });

    it('should throw error for invalid private key format', async () => {
      await expect(
        getGoogleAccessToken(
          'test@example.com',
          'invalid-private-key',
          'https://www.googleapis.com/auth/spreadsheets'
        )
      ).rejects.toThrow('Invalid base64 in private key');
    });
  });
});
