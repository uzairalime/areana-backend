import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { encode as blurhashEncode } from 'blurhash';
import sharp from 'sharp';
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

  /** A processed image ready to store + its placeholder metadata. */
  private async processImage(
    file: Express.Multer.File,
  ): Promise<{ buffer: Buffer; ext: 'jpg' | 'webp'; contentType: string; blurhash: string; width: number; height: number }> {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Only JPEG/PNG/WebP images are allowed');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('Image must be under 5 MB');
    }
    try {
      // Decode for real (the declared MIME is not trusted): sharp throws
      // on anything that is not actually an image.
      const rotated = sharp(file.buffer).rotate(); // EXIF orientation
      const meta = await rotated.metadata();
      if (!meta.width || !meta.height) throw new Error('no dimensions');
      let pipeline = sharp(file.buffer).rotate();
      if (meta.width > 1920) pipeline = pipeline.resize({ width: 1920 });
      const isWebp = file.mimetype === 'image/webp';
      const out = isWebp
        ? await pipeline.webp({ quality: 80 }).toBuffer({ resolveWithObject: true })
        : await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      // BlurHash from a 32x20 raw thumbnail (component X/Y = 4x3).
      const thumb = await sharp(file.buffer)
        .rotate()
        .resize(32, 20, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const blurhash = blurhashEncode(
        new Uint8ClampedArray(thumb.data),
        thumb.info.width,
        thumb.info.height,
        4,
        3,
      );
      return {
        buffer: Buffer.from(out.data),
        ext: isWebp ? 'webp' : 'jpg',
        contentType: isWebp ? 'image/webp' : 'image/jpeg',
        blurhash,
        width: out.info.width,
        height: out.info.height,
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('That file is not a valid image');
    }
  }

  private async storeProcessed(
    key: string,
    processed: { buffer: Buffer; contentType: string },
  ): Promise<string> {
    if (this.config.get('storage.driver') === 's3') {
      return this.saveProcessedToS3(key, processed);
    }
    const dir = join(this.config.get('storage.dir'), key.split('/').slice(0, -1).join('/'));
    await fs.mkdir(dir, { recursive: true });
    const filename = key.split('/').pop() as string;
    await fs.writeFile(join(dir, filename), processed.buffer);
    return `/uploads/${key}`;
  }

  async saveVenueImage(
    venueId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string; blurhash: string; width: number; height: number }> {
    const processed = await this.processImage(file);
    const key = `venues/${venueId}/${randomBytes(8).toString('hex')}.${processed.ext}`;
    const url = await this.storeProcessed(key, processed);
    return { url, blurhash: processed.blurhash, width: processed.width, height: processed.height };
  }

  async saveCourtImage(
    courtId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string; blurhash: string; width: number; height: number }> {
    const processed = await this.processImage(file);
    const key = `courts/${courtId}/${randomBytes(8).toString('hex')}.${processed.ext}`;
    const url = await this.storeProcessed(key, processed);
    return { url, blurhash: processed.blurhash, width: processed.width, height: processed.height };
  }

  async saveBannerImage(
    file: Express.Multer.File,
  ): Promise<{ url: string; blurhash: string; width: number; height: number }> {
    const processed = await this.processImage(file);
    const key = `banners/${randomBytes(8).toString('hex')}.${processed.ext}`;
    const url = await this.storeProcessed(key, processed);
    return { url, blurhash: processed.blurhash, width: processed.width, height: processed.height };
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

  private async saveProcessedToS3(
    key: string,
    processed: { buffer: Buffer; contentType: string },
  ): Promise<string> {
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
        Body: processed.buffer,
        ContentType: processed.contentType,
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
