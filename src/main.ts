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
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  console.log(`Areana API listening on :${port} — docs at /api/docs`);
}
bootstrap();
