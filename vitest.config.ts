import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['reference/**', 'spikes/**', 'node_modules/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
