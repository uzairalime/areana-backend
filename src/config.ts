import * as Joi from 'joi';

export const validationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  TZ: Joi.string().default('Asia/Karachi'),
  CORS_ORIGIN: Joi.string().default('*'),
  DATABASE_URL: Joi.string().required(),
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_TTL: Joi.number().default(900),
  JWT_REFRESH_TTL: Joi.number().default(604800),
  SMTP_HOST: Joi.string().default('localhost'),
  SMTP_PORT: Joi.number().default(1025),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASS: Joi.string().allow('').default(''),
  MAIL_FROM: Joi.string().default('Areana <no-reply@areana.pk>'),
  ADMIN_EMAIL: Joi.string().email().optional(),
  ADMIN_PASSWORD: Joi.string().optional(),
  FCM_ENABLED: Joi.boolean().default(false),
  FCM_SERVICE_ACCOUNT: Joi.string().allow('').optional(),
  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  STORAGE_DIR: Joi.string().default('./uploads'),
  S3_BUCKET: Joi.string().allow('').optional(),
  S3_REGION: Joi.string().allow('').optional(),
  S3_ENDPOINT: Joi.string().allow('').optional(),
  S3_ACCESS_KEY: Joi.string().allow('').optional(),
  S3_SECRET_KEY: Joi.string().allow('').optional(),
  S3_PUBLIC_URL: Joi.string().allow('').optional(),
});

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigin: (process.env.CORS_ORIGIN ?? '*').split(','),
  isProd: process.env.NODE_ENV === 'production',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET as string,
    refreshSecret: process.env.JWT_REFRESH_SECRET as string,
    accessTtl: parseInt(process.env.JWT_ACCESS_TTL ?? '900', 10),
    refreshTtl: parseInt(process.env.JWT_REFRESH_TTL ?? '604800', 10),
  },
  smtp: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: parseInt(process.env.SMTP_PORT ?? '1025', 10),
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.MAIL_FROM ?? 'Areana <no-reply@areana.pk>',
  },
  fcm: {
    enabled: process.env.FCM_ENABLED === 'true',
    serviceAccount: process.env.FCM_SERVICE_ACCOUNT,
  },
  storage: {
    driver: process.env.STORAGE_DRIVER ?? 'local',
    dir: process.env.STORAGE_DIR ?? './uploads',
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      accessKey: process.env.S3_ACCESS_KEY,
      secretKey: process.env.S3_SECRET_KEY,
      publicUrl: process.env.S3_PUBLIC_URL,
    },
  },
});
