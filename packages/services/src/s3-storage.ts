import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig, StorageAdapter } from '@ci/core';

/** S3-compatible object storage (AWS S3, Cloudflare R2, MinIO…). Selected with STORAGE_DRIVER=s3. */
export class S3Storage implements StorageAdapter {
  readonly driver = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig) {
    this.bucket = config.S3_BUCKET!;
    this.client = new S3Client({
      region: config.S3_REGION!,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: !!config.S3_ENDPOINT,
      credentials: config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined,
    });
  }

  async put(key: string, data: Buffer | string, contentType?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      // Only "not found" means absent; a permission or network failure must not be mistaken for a missing object.
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }
}
