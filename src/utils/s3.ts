import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ServerStatus, S3StatusData } from '../types';
import { streamToString } from './stream';

// Write statuses to S3
export const writeStatusesToS3 = async (
  s3Client: S3Client,
  statuses: Record<string, ServerStatus>,
  fileName: string,
  sheetUrl: string,
  bucketName: string
): Promise<void> => {
  const dataToWrite: S3StatusData = { sheetUrl, statuses };
  const params = {
    Bucket: bucketName,
    Key: fileName,
    Body: JSON.stringify(dataToWrite, null, 2),
    ContentType: 'application/json',
  };
  await s3Client.send(new PutObjectCommand(params));
};

// Read statuses from S3
export const readStatusesFromS3 = async (
  s3Client: S3Client,
  fileName: string,
  bucketName: string
): Promise<S3StatusData | {}> => {
  try {
    const data = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: fileName,
    }));
    const statusData = await streamToString((data as any).Body);
    return JSON.parse(statusData) as S3StatusData;
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      return {};
    } else {
      throw error;
    }
  }
}; 