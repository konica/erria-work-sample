import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Prisma 7's config loader does not read .env files on its own (see
// https://pris.ly/d/prisma7-client-config), so load the workspace-root .env
// explicitly. This does not override DATABASE_URL when it is already set in
// the process environment (e.g. by the Testcontainers helper).
loadEnv({ path: path.join(import.meta.dirname, '../../.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: env('DATABASE_URL'),
  },
});
