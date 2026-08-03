import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { include: ['src/**/*.spec.ts'] },
  resolve: {
    alias: { '@erria/db': path.resolve(__dirname, '../db/src/index.ts') },
  },
});
