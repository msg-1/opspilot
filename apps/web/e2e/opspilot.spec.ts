import { type Browser, type Page, expect, test } from '@playwright/test';

const PASSWORD = 'OpsPilot-demo-1';
const stamp = Date.now().toString(36);

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

async function as(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { page, close: () => context.close() };
}

test.describe.configure({ mode: 'serial' });

test('unauthenticated visitors are sent to sign-in, and bad credentials are rejected', async ({ page }) => {
  await page.goto('/incidents');
  await expect(page).toHaveURL(/\/login\?next=%2Fincidents/);
  await page.getByLabel('Email').fill('demo@opspilot.dev');
  await page.getByLabel('Password').fill('definitely-wrong-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid email or password')).toBeVisible();
});

test('overview shows the active incident and navigation works', async ({ page }) => {
  await signIn(page, 'demo@opspilot.dev');
  await expect(page.getByRole('link', { name: /Checkout requests failing with 503s/ }).first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Services' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Services' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Checkout Service' })).toBeVisible();
  await page.getByRole('link', { name: 'Checkout Service' }).click();
  await expect(page.getByText('Depends on').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Orders Database/ })).toBeVisible();
});

let incidentUrl = '';
const title = `E2E checkout latency ${stamp}`;

test('an engineer declares an incident, updates it and comments', async ({ browser }) => {
  const { page, close } = await as(browser, 'lena@opspilot.dev');
  await page.goto('/incidents');
  await page.getByRole('button', { name: 'Declare incident' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What is happening?').fill(title);
  await dialog.getByLabel('Severity').selectOption('SEV2');
  await dialog.getByRole('checkbox', { name: 'Checkout Service' }).check();
  await dialog.getByRole('button', { name: 'Declare incident' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  incidentUrl = page.url();

  await page.getByLabel('Change status').selectOption('INVESTIGATING');
  await expect(page.getByText('Status changed from OPEN to INVESTIGATING')).toBeVisible();
  await page.getByLabel('Add an update').fill('Looking at the connection pool. @Tomás Herrera please check the last deploy.');
  await page.getByRole('button', { name: 'Post update' }).click();
  await expect(page.getByText('Looking at the connection pool.')).toBeVisible();

  await page.getByRole('tab', { name: 'Related changes' }).click();
  await expect(page.getByText('Deployments before and during the incident')).toBeVisible();
  await expect(page.getByText('v2.14.0').first()).toBeVisible();
  await close();
});

let actionUrl = '';

test('an AI investigation gathers evidence, ranks hypotheses and proposes remediation', async ({ browser }) => {
  const { page, close } = await as(browser, 'lena@opspilot.dev');
  await page.goto(incidentUrl);
  await page.getByRole('button', { name: 'Investigate with AI' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start investigation' }).click();
  await expect(page).toHaveURL(/\/investigations\//);
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 45_000 });

  // The report is explicit that it is a hypothesis, and cites evidence.
  await expect(page.getByText(/hypotheses to verify, not a confirmed root cause/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Regression introduced by Deployment of checkout-service v2\.14\.0/ })).toBeVisible();
  await expect(page.getByText('Assumptions (not verified)').first()).toBeVisible();
  await page.getByRole('tab', { name: /Evidence timeline/ }).click();
  await expect(page.getByText('cited in report').first()).toBeVisible();
  await page.getByRole('tab', { name: /Agent steps/ }).click();
  await expect(page.getByText('find_log_anomalies').first()).toBeVisible();

  await page.getByRole('link', { name: /Roll back checkout-service to v2\.13\.2/ }).click();
  await expect(page.getByText('This action was proposed by an AI investigation')).toBeVisible();
  await expect(page.getByText('Proposed', { exact: true }).first()).toBeVisible();
  actionUrl = page.url();
  await close();
});

test('remediation needs an independent human approval before it can be executed', async ({ browser }) => {
  const requester = await as(browser, 'lena@opspilot.dev');
  await requester.page.goto(actionUrl);
  await requester.page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(requester.page.getByText('so someone else must approve it')).toBeVisible();
  await expect(requester.page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  const viewer = await as(browser, 'aiko@opspilot.dev');
  await viewer.page.goto(actionUrl);
  await expect(viewer.page.getByText('Your role cannot approve remediation actions')).toBeVisible();
  await viewer.close();

  const approver = await as(browser, 'marcus@opspilot.dev');
  await approver.page.goto('/remediation');
  await expect(approver.page.getByRole('link', { name: /Roll back checkout-service to v2\.13\.2/ }).first()).toBeVisible();
  await approver.page.goto(actionUrl);
  await approver.page.getByRole('button', { name: 'Approve' }).click();
  await approver.page.getByLabel('Comment (optional)').fill('Matches the runbook.');
  await approver.page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(approver.page.getByText('1 of 1 required')).toBeVisible();
  await approver.close();

  await requester.page.reload();
  await requester.page.getByRole('button', { name: 'Mark as executed' }).click();
  await requester.page.getByLabel('Notes (optional)').fill('deployctl rollback checkout-service --to v2.13.2');
  await requester.page.getByRole('button', { name: 'I have carried this out' }).click();
  await expect(requester.page.getByText(/OpsPilot did not change any external system/)).toBeVisible();
  await expect(requester.page.getByText('Executed', { exact: true }).first()).toBeVisible();

  // The rollback is now part of the service's deployment history.
  await requester.page.goto('/deployments?service=checkout-service');
  await expect(requester.page.getByText('rollback').first()).toBeVisible();
  await requester.close();
});

test('viewers get a read-only interface', async ({ browser }) => {
  const { page, close } = await as(browser, 'aiko@opspilot.dev');
  await page.goto('/incidents');
  await expect(page.getByRole('heading', { level: 1, name: 'Incidents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Declare incident' })).toHaveCount(0);
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.getByText('Only admins and owners can read the audit log')).toBeVisible();
  await close();
});

test('log explorer filters and the knowledge base search return real results', async ({ page }) => {
  await signIn(page, 'demo@opspilot.dev');
  await page.goto('/logs?from=6h');
  await page.getByLabel('Search log messages').fill('timeout acquiring connection');
  await expect(page.getByText(/timeout acquiring connection from pool/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'New and spiking' }).click();
  await expect(page.getByText(/New pattern|the baseline rate/).first()).toBeVisible();

  await page.goto('/knowledge');
  await page.getByLabel('Search the knowledge base').fill('database connection pool exhausted');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('link', { name: /Symptoms|pool/i }).first()).toBeVisible();
});

test('the audit log records human and AI activity', async ({ page }) => {
  await signIn(page, 'demo@opspilot.dev');
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Audit log' }).click();
  await page.getByLabel('Area').selectOption('remediation');
  for (const action of ['remediation.request_approval', 'remediation.approve', 'remediation.execute_success']) await expect(page.getByText(action).first()).toBeVisible();
  await page.getByLabel('Area').selectOption('ai_tool');
  await expect(page.getByText('ai_tool.call').first()).toBeVisible();
});

test('pages do not scroll sideways on a phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  await signIn(page, 'demo@opspilot.dev');
  for (const path of ['/', '/incidents', '/monitoring', '/logs', '/remediation', '/analytics']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Knowledge base' })).toBeVisible();
  await context.close();
});
