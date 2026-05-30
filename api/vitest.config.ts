import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 85,
        functions: 80,
        branches: 75,
      },
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/index.ts'],
    },
  },
});
