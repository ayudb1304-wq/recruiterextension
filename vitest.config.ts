import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@recruitexport/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./extension', import.meta.url)),
    },
  },
  test: {
    // Default is node. DOM-dependent suites opt in per file with a
    // `// @vitest-environment jsdom` docblock (extraction engine tests).
    environment: 'node',
    include: ['extension/tests/**/*.test.ts', 'backend/tests/**/*.test.ts'],
    globals: false,
  },
});
