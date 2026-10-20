import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { UPLOADS_DIR } from './uploads/uploads.controller';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Keeps the exact request bytes on req.rawBody — PayMongo's webhook signature is computed
    // over the raw body and cannot be verified from re-serialised JSON.
    rawBody: true,
  });

  // Drawn/snapped routes can carry thousands of [lng, lat] pairs; Express's
  // default 100kb JSON limit would reject them with a 413.
  app.useBodyParser('json', { limit: '2mb' });

  // Serves uploaded banner images back out. Deliberately outside the /api prefix (set below), so
  // an uploaded file's URL is just http://host:port/uploads/<file> — a plain static asset URL,
  // the same shape as any externally-hosted bannerUrl the app already accepts.
  app.useStaticAssets(UPLOADS_DIR, { prefix: '/uploads/' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  ); 

  app.enableCors({
    origin: ['http://localhost:3001','https://everyrun-pi.vercel.app'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.setGlobalPrefix('api');

  // const port = process.env.PORT ?? 3000;
  
// await app.listen(port);
//   // eslint-disable-next-line no-console
//   console.log(`RunFlow API listening on port ${port}`);

  //for render
  const port = Number(process.env.PORT) || 3000;
await app.listen(port, '0.0.0.0');

// eslint-disable-next-line no-console
console.log(`RunFlow API listening on port ${port}`);

}
bootstrap();