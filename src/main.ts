import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.enableCors({ origin: config.get<string[]>('corsOrigin') });

  // Serve locally stored uploads (venue images) in dev.
  if (config.get('storage.driver') === 'local') {
    app.useStaticAssets(join(process.cwd(), config.get('storage.dir')), { prefix: '/uploads/' });
  }

  const swagger = new DocumentBuilder()
    .setTitle('Areana API')
    .setDescription('Sports arena booking platform — courts, fields, turfs')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('health', 'Service and database health checks')
    .addTag('auth', 'Player OTP login, owner/staff/admin email+password, token refresh')
    .addTag('users', 'Player profile and account management')
    .addTag('search', 'Venue discovery and slot search')
    .addTag('venues', 'Venue listings, details and images')
    .addTag('courts', 'Courts and grounds inside a venue')
    .addTag('availability', 'Schedules, slots and booking windows')
    .addTag('bookings', 'Booking lifecycle: create, approve, reschedule, check-in')
    .addTag('game-posts', 'Find-players board and curated games')
    .addTag('favorites', 'Player favorite venues')
    .addTag('reviews', 'Player reviews and owner replies')
    .addTag('referrals', 'Promo codes and referral rewards')
    .addTag('disputes', 'Booking disputes and resolutions')
    .addTag('suggestions', 'Suggest-a-turf lead queue')
    .addTag('deeplinks', 'Shareable venue and booking links')
    .addTag('owner', 'Arena owner panel: dashboard, calendar, staff, customers')
    .addTag('admin', 'Super admin panel: approvals, analytics, roles, badges, CMS')
    .addTag('banners', 'App banners and broadcasts')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  console.log(`Areana API listening on :${port} — docs at /api/docs`);
}
bootstrap();
