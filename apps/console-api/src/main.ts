import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

function assertDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'Missing required environment variable DATABASE_URL. Set it before starting console-api (see .env.example).',
    );
  }
}

async function bootstrap() {
  assertDatabaseUrl();

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Default closed: an unconfigured deployment (CONSOLE_WEB_ORIGIN unset) must not
  // reflect-any-origin. Only enable CORS for the specific origin when configured.
  app.enableCors({ origin: process.env.CONSOLE_WEB_ORIGIN ?? false });
  app.enableShutdownHooks();
  const port = process.env.CONSOLE_API_PORT ? Number(process.env.CONSOLE_API_PORT) : 3000;
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  console.error('Fatal error during console-api bootstrap:', error);
  process.exit(1);
});
