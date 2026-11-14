import { type APIRequestContext, expect, request, test } from '@playwright/test';

// A new organisation, from nothing to a first investigation, as its first engineer sees it.
// Data is sent the way a real system would send it: with an API key, from outside the browser.
// It creates an organisation, so it runs only against the isolated stack.
const ISOLATED = process.env.E2E_ISOLATED === '1';
const stamp = Date.now().toString(36);

test.skip(!ISOLATED, 'Creates an organisation: runs only against the isolated stack (npm run isolated:e2e).');

test('a new organisation sees what can be connected, connects a source, watches data arrive and runs a first investigation', async ({ page, baseURL }) => {
  // Register. The session cookie lands in the browser context, as it does from the sign-up page.
  const registered = await page.request.post('/api/v1/auth/register', { data: { email: `pilot-${stamp}@example.com`, password: 'Pilot-team-pw-1', name: 'Pia Pilot', organizationName: `Pilot Team ${stamp}` } });
  expect(registered.status()).toBe(201);

  // The first page says nothing is connected and where to go.
  await page.goto('/');
  await expect(page.getByText('Nothing is connected yet.')).toBeVisible();
  await page.getByRole('link', { name: 'See what can be connected and set it up' }).click();
  await expect(page).toHaveURL(/\/integrations$/);

  // Discovery: every source that exists, none of them claiming to work.
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  for (const name of ['Logs', 'Metrics', 'Deployments', 'Service events', 'GitHub', 'Remediation webhook', 'Distributed traces', 'Analysis engine']) await expect(page.getByRole('heading', { level: 3, name, exact: true })).toBeVisible();
  await expect(page.getByText('0 of 6 steps done.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('status-logs')).toContainText('No API key with the scope ingest:logs exists');
  await expect(page.getByTestId('status-analysis_engine')).toContainText('rule-based engine');
  await expect(page.getByText('Receiving data', { exact: true })).toHaveCount(0);

  // How to connect shows the request to send, with a placeholder for the key.
  await page.getByRole('button', { name: 'How to connect' }).first().click();
  await expect(page.getByText(/curl -X POST .*\/api\/v1\/logs/)).toBeVisible();
  await expect(page.getByText(/\$OPSILUME_API_KEY/).first()).toBeVisible();

  // Step 1: register a service, in the interface.
  await page.goto('/services');
  await page.getByRole('button', { name: /Add service|New service/ }).first().click();
  await page.getByLabel('Name').fill('Checkout Service');
  await page.getByRole('dialog').getByRole('button', { name: /Add service|Create/ }).click();
  // Saving opens the new service's own page.
  await expect(page).toHaveURL(/\/services\/[a-z0-9]+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout Service' })).toBeVisible();

  // Step 2: an API key. Created by an owner; the secret is shown once.
  const key = await (await page.request.post('/api/v1/api-keys', { data: { name: 'pilot ingestion', scopes: ['ingest:logs', 'ingest:metrics', 'ingest:deployments'] } })).json();
  expect(key.secret).toMatch(/^opk_/);
  await page.goto('/integrations');
  await expect(page.getByTestId('status-logs')).toContainText('None has been used yet');
  await expect(page.getByTestId('step-source')).toHaveAttribute('data-done', 'true');
  await expect(page.getByTestId('step-connect')).toHaveAttribute('data-done', 'false');

  // Steps 3 and 4: the organisation's systems send data. No browser session, only the key.
  const outside: APIRequestContext = await request.newContext({ baseURL, extraHTTPHeaders: { 'x-api-key': key.secret } });
  // A first attempt with a mistake in it: the page must say so, in words, without the payload.
  expect((await outside.post('/api/v1/logs', { data: { logs: [{ level: 'error', message: 12345 }] } })).status()).toBe(400);
  await expect(page.getByTestId('status-logs')).toContainText('Nothing has been accepted yet', { timeout: 15_000 });
  await expect(page.getByText(/The request was rejected: logs\.0\.message/)).toBeVisible();
  await expect(page.getByText('12345')).toHaveCount(0);

  const now = Date.now();
  const lines = Array.from({ length: 40 }, (_, i) => ({ timestamp: new Date(now - i * 20_000).toISOString(), level: i % 2 ? 'error' : 'info', message: i % 2 ? 'timeout acquiring connection from pool after 3000ms' : 'request served' }));
  expect((await outside.post('/api/v1/logs', { data: { service: 'checkout-service', logs: lines } })).status()).toBe(202);
  // Metrics for a name nobody registered: accepted by the endpoint, useless, and the page says so.
  expect((await outside.post('/api/v1/monitoring/metrics', { data: { samples: [{ service: 'checkout-svc', metric: 'error_rate', value: 7.5 }] } })).status()).toBe(202);
  expect((await outside.post('/api/v1/deployments', { data: { service: 'checkout-service', version: 'v1.4.0', status: 'SUCCEEDED', startedAt: new Date(now - 15 * 60_000).toISOString() } })).status()).toBe(201);
  await outside.dispose();

  // The page updates by itself: logs are arriving for a registered service…
  await expect(page.getByTestId('status-logs')).toContainText('40 log lines in the last 24 hours', { timeout: 15_000 });
  await expect(page.getByTestId('status-deployments')).toContainText('Receiving data');
  // …and metrics are named as the problem they are.
  await expect(page.getByTestId('status-metrics')).toContainText('Nothing has been accepted yet');
  await expect(page.getByText('Data that belongs to no service')).toBeVisible();
  await expect(page.getByText('checkout-svc', { exact: true })).toBeVisible();
  await expect(page.getByTestId('step-data')).toHaveAttribute('data-done', 'true');
  await expect(page.getByTestId('step-associate')).toHaveAttribute('data-done', 'false');

  // Step 5: the sender is corrected; the mismatch clears.
  const fixed = await request.newContext({ baseURL, extraHTTPHeaders: { 'x-api-key': key.secret } });
  expect((await fixed.post('/api/v1/monitoring/metrics', { data: { samples: [{ service: 'checkout-service', metric: 'error_rate', value: 7.5 }] } })).status()).toBe(202);
  await fixed.dispose();
  await expect(page.getByTestId('status-metrics')).toContainText('Receiving data', { timeout: 15_000 });
  await expect(page.getByText('Data that belongs to no service')).toHaveCount(0);
  await expect(page.getByTestId('step-associate')).toHaveAttribute('data-done', 'true');

  // Step 6: a first investigation, on the data that was just sent.
  const started = await page.request.post('/api/v1/investigations', { data: { question: 'Why is checkout-service logging connection pool timeouts?' } });
  expect(started.status()).toBe(202);
  await page.goto(`/investigations/${(await started.json()).id}`);
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 45_000 });
  // The report rests on what was sent: the error pattern from the log lines.
  await expect(page.getByText(/timeout acquiring connection from pool/).first()).toBeVisible();

  // The same investigation as a document to hand to someone else.
  await page.getByRole('link', { name: 'Report to share' }).click();
  await expect(page).toHaveURL(/\/report$/);
  await expect(page.getByTestId('engine-line')).toContainText('No AI model was used');
  for (const section of ['Conclusion', 'Most probable cause', 'What is established', 'What is not known', 'Recommended next steps', 'Evidence referred to']) await expect(page.getByRole('heading', { level: 2, name: new RegExp(`^${section}`) })).toBeVisible();
  await expect(page.getByText('The cause has not been confirmed')).toBeVisible();
  // On paper there is the report and nothing of the application around it.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden();
  await expect(page.getByRole('heading', { level: 2, name: /^Conclusion/ })).toBeVisible();
  await page.emulateMedia({ media: 'screen' });

  await page.goto('/integrations');
  await expect(page.getByText('Set-up is complete.')).toBeVisible();
  // Nowhere on the page is the key.
  expect(await page.content()).not.toContain(key.secret);
});
