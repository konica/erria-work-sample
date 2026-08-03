import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7's config loader does not read .env files on its own (see
// https://pris.ly/d/prisma7-client-config), so load the workspace-root .env
// explicitly. This does not override DATABASE_URL when it is already set in
// the process environment (e.g. by the Testcontainers helper).
loadEnv({ path: path.join(import.meta.dirname, '../../.env') });

// Deliberately process.env.DATABASE_URL, not Prisma's own `env()` helper:
// `env()` throws at config-load time when the var is unset, which breaks
// `prisma generate` (invoked from postinstall on every fresh install/clone)
// even though `generate` never connects to a database at all. Commands that
// genuinely need a connection (migrate dev/deploy, db pull, ...) still fail
// — just at the point they try to connect, with Postgres's own clearer error,
// rather than here.
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
