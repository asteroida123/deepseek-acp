import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['reference/**', 'spikes/**', 'node_modules/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Windows shell tests start real ACL runners and Windows PowerShell
    // processes. Four-way file parallelism saturates small CI/dev machines and
    // turns fixed lifecycle deadlines into load tests instead of regressions.
    ...(process.platform === 'win32' ? { maxWorkers: 2, minWorkers: 2 } : {}),
  },
})
