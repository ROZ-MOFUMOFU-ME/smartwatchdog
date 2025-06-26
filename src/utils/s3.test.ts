import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { writeStatusesToS3 } from './s3';

jest.mock('@aws-sdk/client-s3');

const mockSend = jest.fn();
(S3Client as jest.Mock).mockImplementation(() => ({ send: mockSend }));

const s3Client = new S3Client({});
const bucketName = 'test-bucket';
const fileName = 'test.json';
const sheetUrl = 'https://sheet.url';
const statuses = { foo: { status: 'OK', lastUpdate: 'now' } };

describe('writeStatusesToS3', () => {
  it('S3に正しく書き込める', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(
      writeStatusesToS3(s3Client, statuses, fileName, sheetUrl, bucketName)
    ).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
  });
});
