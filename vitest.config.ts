import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['database/src/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
