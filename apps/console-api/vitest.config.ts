import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import path from 'node:path';

export default defineConfig({
  // Vitest transforms through esbuild, which cannot emit the `design:paramtypes`
  // metadata NestJS reads to resolve constructor parameters — the same limitation
  // that broke `tsx` in #35. Without this plugin, any test that resolves a provider
  // through the Nest container gets `undefined` injected instead of the dependency.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.e2e-spec.ts'],
    // Multiple spec files each start their own Testcontainers Postgres and shell out to
    // `prisma migrate deploy`. Vitest's default file parallelism races them on one Docker
    // daemon, same failure mode as #4's workspace-level fix (c63dd49) — this package now has
    // enough integration spec files (accounts, queue, triggers) to trigger it on its own.
    fileParallelism: false,
  },
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
