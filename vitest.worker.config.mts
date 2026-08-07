import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/worker/**/*.test.mts'],
    environment: 'node',
  },
});
