import { defineConfig } from '@playwright/test';

// Mirrors upstream's `default` project. The renderer is served by Bruno Web,
// so upstream's `npm run dev:web` server is not needed; the API fixture server
// (packages/bruno-tests, :8081) is.
export default defineConfig({
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.E2E_WORKERS || 4),
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  // Upstream's fixtures manage tracing themselves and expect it to be off or fully on.
  use: { trace: 'off' },
  projects: [
    {
      name: 'default',
      testDir: './tests',
      testIgnore: ['ssl/**', 'auth/**', 'benchmarks/**', 'proxy/system-pac/**', 'mock-server/**']
    },
    { name: 'mock-server', testDir: './tests/mock-server' }
  ],
  webServer: [
    {
      command: 'npm start --workspace=packages/bruno-tests',
      cwd: process.env.BRUNO_WEB_UPSTREAM,
      url: 'http://localhost:8081/ping',
      reuseExistingServer: true,
      timeout: 120000
    }
  ]
});
