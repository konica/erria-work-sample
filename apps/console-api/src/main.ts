import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

function assertDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'Missing required environment variable DATABASE_URL. Set it before starting console-api (see .env.example).',
    );
  }
}

// The console-web SPA build lands here at image build time (ADR-0007: one deployable unit,
// one origin). Resolved relative to this compiled file rather than process.cwd() so it
// works regardless of the working directory the container starts in. Absent in dev — the
// SPA is served by Vite on :5173 there — so express.static simply 404s through to the API
// routes below.
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

async function bootstrap() {
  assertDatabaseUrl();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(STATIC_DIR);
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
