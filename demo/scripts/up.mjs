// Starts OPSILUME and the demo microservices, in the order that works:
// the application first (rule-based engine, trace store configured), then the demo
// organisation and its ingestion key, then the demo services that use that key.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { API, ROOT, SERVICE_URLS, compose, log, waitFor } from './lib.mjs';

if (!existsSync(join(ROOT, '.env'))) {
  console.error('No .env file. Copy .env.example to .env and set the three secrets first (see docs/setup-guide.md).');
  process.exit(1);
}
const ok = async (url) => (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;

log('starting OPSILUME (API, worker, AI service on the rule-based engine, web) …');
compose(['up', '-d', '--build', 'postgres', 'redis', 'migrate', 'api', 'worker', 'ai', 'web']);
await waitFor('the API', () => ok(`${API}/health`), { timeoutMs: 240_000 });
const provider = compose(['exec', '-T', 'ai', 'printenv', 'AI_PROVIDER'], { quiet: true }).trim();
if (provider !== 'deterministic') throw new Error(`The AI service is running with AI_PROVIDER=${provider}. Refusing to continue: the demo must not call a paid model.`);
log('AI service is on the rule-based engine (AI_PROVIDER=deterministic): investigations cost nothing');

await import('./setup.mjs');

log('starting the demo services, data stores, trace store, Prometheus, load generator and telemetry bridge …');
compose(['up', '-d', '--build', 'prometheus', 'demo-postgres', 'demo-redis', 'demo-jaeger', 'demo-orders', 'demo-payments', 'demo-gateway', 'demo-load', 'demo-bridge']);
compose(['restart', 'prometheus'], { quiet: true }); // picks up the demo scrape jobs if Prometheus was already running
await waitFor('the demo gateway', () => ok(`${SERVICE_URLS['shop-gateway']}/health`), { timeoutMs: 180_000 });
log('ready.');
console.log(`
  OPSILUME            http://localhost:3000   (sign in: shop-demo@example.com / OpsPilot-demo-1)
  Demo shop gateway   http://localhost:8088
  Traces (Jaeger)     http://localhost:16686
  Prometheus          http://localhost:9090

  Give it about three minutes of traffic before investigating, so there is a baseline.
  npm run demo:scenario -- list           failure scenarios
  npm run demo:e2e                        run every scenario and check the investigations
  npm run demo:down                       stop the demo services
`);
