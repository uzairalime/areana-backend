import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Venue image storage. Local disk in dev (served at /uploads),
 * S3-compatible bucket in prod. Returns the public URL to store.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private config: ConfigService) {}

  async saveVenueImage(venueId: string, file: Express.Multer.File): Promise<string> {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Only JPEG/PNG/WebP images are allowed');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('Image must be under 5 MB');
    }
    const ext = file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    const key = `venues/${venueId}/${randomBytes(8).toString('hex')}.${ext}`;

    if (this.config.get('storage.driver') === 's3') {
      return this.saveToS3(key, file);
    }
    const dir = join(this.config.get('storage.dir'), 'venues', venueId);
    await fs.mkdir(dir, { recursive: true });
    const filename = key.split('/').pop() as string;
    await fs.writeFile(join(dir, filename), file.buffer);
    return `/uploads/venues/${venueId}/${filename}`;
  }

  async deleteImage(url: string): Promise<void> {
    try {
      if (url.startsWith('/uploads/')) {
        await fs.unlink(join(this.config.get('storage.dir'), url.replace('/uploads/', '')));
      } else if (this.config.get('storage.driver') === 's3') {
        await this.deleteFromS3(url);
      }
    } catch (e) {
      this.logger.warn(`Failed to delete image ${url}: ${(e as Error).message}`);
    }
  }

  private async saveToS3(key: string, file: Express.Multer.File): Promise<string> {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const cfg = this.config.get('storage.s3');
    const client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      forcePathStyle: !!cfg.endpoint,
    });
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );
    const base = (cfg.publicUrl ?? `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`).replace(/\/$/, '');
    return `${base}/${key}`;
  }

  private async deleteFromS3(url: string): Promise<void> {
    const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const cfg = this.config.get('storage.s3');
    const base = (cfg.publicUrl ?? '').replace(/\/$/, '');
    const key = base && url.startsWith(base) ? url.slice(base.length + 1) : url.split('/').slice(3).join('/');
    const client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      forcePathStyle: !!cfg.endpoint,
    });
    await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  }
}
