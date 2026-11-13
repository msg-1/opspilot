import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real stack: web → API → Postgres/Redis → worker → AI service.
 *
 * The usual way to run them is against the throwaway stack, which starts freshly seeded and
 * on the rule-based engine: `npm run isolated:up && npm run isolated:e2e` (this is what CI
 * does). Against a stack you started yourself: `npm run test:e2e`, after `npm run db:seed`;
 * the tests that stop containers (recovery.spec.ts) are skipped there.
 *
 * A failed test keeps a screenshot and a trace (browser console, network, DOM snapshots).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
