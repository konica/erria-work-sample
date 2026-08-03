import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export interface TestPostgres {
  prisma: PrismaClient;
  container: StartedPostgreSqlContainer;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:17').start();
  const connectionString = container.getConnectionUri();

  execSync('pnpm --filter @erria/db exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'inherit',
  });

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  return { prisma, container };
}

export async function stopTestPostgres(testPostgres: TestPostgres): Promise<void> {
  await testPostgres.prisma.$disconnect();
  await testPostgres.container.stop();
}
