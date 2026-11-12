import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real stack: web → API → Postgres/Redis → worker → AI service.
 * Start it first (see docs/setup-guide.md) and seed the demo data: `npm run db:seed`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
