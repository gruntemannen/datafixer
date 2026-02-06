import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
const DATA_BUCKET = process.env.DATA_BUCKET!;

export async function getUploadPresignedUrl(
  key: string,
  contentType: string = 'text/csv',
  expiresIn: number = 3600
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
    ContentType: contentType,
    ServerSideEncryption: 'aws:kms',
  });
  
  return getSignedUrl(s3Client, command, { expiresIn });
}

export async function getDownloadPresignedUrl(
  key: string,
  expiresIn: number = 3600,
  fileName?: string
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
    ...(fileName && {
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
    }),
  });
  
  return getSignedUrl(s3Client, command, { expiresIn });
}

export async function getObject(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
  });
  
  const response = await s3Client.send(command);
  return streamToString(response.Body as Readable);
}

export async function getObjectStream(key: string): Promise<Readable> {
  const command = new GetObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
  });
  
  const response = await s3Client.send(command);
  return response.Body as Readable;
}

export async function putObject(
  key: string, 
  body: string | Buffer,
  contentType: string = 'application/json'
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: 'aws:kms',
  });
  
  await s3Client.send(command);
}

export async function getObjectMetadata(key: string): Promise<{
  contentLength: number;
  contentType: string;
  lastModified: Date;
}> {
  const command = new HeadObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
  });
  
  const response = await s3Client.send(command);
  return {
    contentLength: response.ContentLength || 0,
    contentType: response.ContentType || 'application/octet-stream',
    lastModified: response.LastModified || new Date(),
  };
}

export async function deleteS3Object(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
  });
  
  await s3Client.send(command);
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function generateUploadKey(tenantId: string, jobId: string, fileName: string): string {
  return `uploads/${tenantId}/${jobId}/${fileName}`;
}

export function generateRawDataKey(tenantId: string, jobId: string): string {
  return `processing/${tenantId}/${jobId}/raw-data.json`;
}

export function generateOutputCsvKey(tenantId: string, jobId: string): string {
  return `outputs/${tenantId}/${jobId}/cleaned-data.csv`;
}

export function generateOutputReportKey(tenantId: string, jobId: string): string {
  return `outputs/${tenantId}/${jobId}/report.json`;
}
