const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js/,
  timeout: 90000,
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS || 2),
  reporter: [['list']],
  use: { viewport: { width: 1280, height: 800 }, trace: 'retain-on-failure', acceptDownloads: true }
});
