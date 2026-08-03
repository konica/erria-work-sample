import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: process.env.CONSOLE_WEB_ORIGIN ?? true });
  const port = process.env.CONSOLE_API_PORT ? Number(process.env.CONSOLE_API_PORT) : 3000;
  await app.listen(port);
}

bootstrap();
