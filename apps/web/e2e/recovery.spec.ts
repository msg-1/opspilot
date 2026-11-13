import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

// What a person sees when part of the system is down, and after it comes back. These tests
// stop and start containers, so they run only against the isolated stack
// (`npm run isolated:up`, then `npm run isolated:e2e`), never against a stack someone is using.
const ISOLATED = process.env.E2E_ISOLATED === '1';
const PASSWORD = 'OpsPilot-demo-1';
const ROOT = join(__dirname, '..', '..', '..');

function stack(...args: string[]) {
  const res = spawnSync('node', ['scripts/isolated-stack.mjs', 'compose', ...args], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`isolated stack: ${args.join(' ')} failed\n${res.stderr}`);
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('lena@example.com');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

async function openIncident(page: Page) {
  const incidents = await (await page.request.get('/api/v1/incidents?status=OPEN,INVESTIGATING,IDENTIFIED&pageSize=1')).json();
  await page.goto(`/incidents/${incidents.data[0].id}`);
  await expect(page.getByRole('button', { name: 'Investigate with AI' })).toBeVisible();
}

async function startInvestigation(page: Page) {
  await page.getByRole('button', { name: 'Investigate with AI' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start investigation' }).click();
}

test.describe.configure({ mode: 'serial' });
test.skip(!ISOLATED, 'Stops and starts containers: runs only against the isolated stack (npm run isolated:e2e).');

test.afterAll(() => {
  if (ISOLATED) stack('up', '-d', '--wait', '--wait-timeout', '180');
});

test('with the AI service down, an investigation is shown as failed with the reason and no report; it works again once the service is back', async ({ page }) => {
  await signIn(page);
  await openIncident(page);
  const incidentUrl = page.url();

  stack('stop', 'ai');
  await startInvestigation(page);
  await expect(page).toHaveURL(/\/investigations\//);
  await expect(page.getByText('This investigation failed.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/AI service is not reachable/).first()).toBeVisible();
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible();
  // Nothing on the page reads like a conclusion.
  await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/hypotheses to verify, not a confirmed root cause/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Roll back/ })).toHaveCount(0);

  stack('up', '-d', '--wait', '--wait-timeout', '180', 'ai');
  await page.goto(incidentUrl);
  await startInvestigation(page);
  await expect(page).toHaveURL(/\/investigations\//);
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/hypotheses to verify, not a confirmed root cause/)).toBeVisible();
  await expect(page.getByText('This investigation failed.')).toHaveCount(0);
});

test('with the job queue down, starting an investigation is refused on the spot and nothing is left queued; it works again once the queue is back', async ({ page }) => {
  await signIn(page);
  await openIncident(page);
  const incidentUrl = page.url();

  stack('stop', 'redis');
  await startInvestigation(page);
  await expect(page.getByRole('dialog').getByText(/job queue \(Redis\) is not reachable\. Nothing was started/)).toBeVisible({ timeout: 20_000 });
  expect(page.url()).toBe(incidentUrl); // the person stays where they were, with the reason in front of them
  const latest = (await (await page.request.get('/api/v1/investigations?pageSize=1')).json()).data[0];
  expect(latest.status).toBe('FAILED');

  stack('up', '-d', '--wait', '--wait-timeout', '180', 'redis');
  await expect.poll(async () => (await page.request.get('/api/v1/system/status')).ok() && (await (await page.request.get('/api/v1/system/status')).json()).redis, { timeout: 60_000 }).toBe(true);
  await page.goto(incidentUrl);
  await startInvestigation(page);
  await expect(page).toHaveURL(/\/investigations\//, { timeout: 20_000 });
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 45_000 });
});
