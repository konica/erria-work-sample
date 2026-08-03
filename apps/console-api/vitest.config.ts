import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { include: ['src/**/*.spec.ts', 'src/**/*.e2e-spec.ts'] },
  resolve: {
    alias: {
      '@erria/db/test-utils': path.resolve(
        __dirname,
        '../../packages/db/src/test-utils/testcontainers-postgres.ts',
      ),
      '@erria/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
      '@erria/domain': path.resolve(__dirname, '../../packages/domain/src/index.ts'),
    },
  },
});
