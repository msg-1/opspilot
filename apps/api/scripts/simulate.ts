/**
 * Demo traffic generator: keeps the seeded organisation "alive" by sending metrics and logs
 * through the public ingestion API every 15 seconds, exactly as a real agent or pipeline would.
 *
 *   OPSPILOT_API_KEY=opk_... npm run simulate            (key needs ingest:logs + ingest:metrics)
 *   OPSPILOT_API_KEY=opk_... npm run simulate -- --heal  (checkout recovers: alerts resolve)
 */
const API = process.env.OPSPILOT_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const KEY = process.env.OPSPILOT_API_KEY;
const healed = process.argv.includes('--heal');

if (!KEY) {
  console.error('Set OPSPILOT_API_KEY to an API key with the ingest:logs and ingest:metrics scopes (Settings → API keys).');
  process.exit(2);
}

const noise = (value: number, pct = 0.08) => Math.max(0, value * (1 + (Math.random() - 0.5) * 2 * pct));
const profiles: Record<string, { rps: number; err: number; p95: number; cpu: number; mem: number }> = {
  'web-storefront': { rps: 2100, err: healed ? 0.3 : 3.4, p95: healed ? 240 : 840, cpu: 38, mem: 52 },
  'api-gateway': { rps: 3400, err: healed ? 0.4 : 6.2, p95: healed ? 95 : 995, cpu: 44, mem: 41 },
  'checkout-service': { rps: healed ? 420 : 336, err: healed ? 0.4 : 17.9, p95: healed ? 180 : 4280, cpu: healed ? 35 : 23, mem: 58 },
  'payment-service': { rps: healed ? 180 : 99, err: 0.6, p95: 310, cpu: 29, mem: 47 },
  'inventory-service': { rps: 900, err: 0.2, p95: 60, cpu: 31, mem: 39 },
  'notification-service': { rps: healed ? 60 : 36, err: 0.5, p95: 420, cpu: 18, mem: 33 },
};

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY as string }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ accepted: number }>;
}

async function tick() {
  const samples = Object.entries(profiles).flatMap(([service, p]) => [
    { service, metric: 'requests_per_min', value: noise(p.rps) },
    { service, metric: 'error_rate', value: noise(p.err, 0.2) },
    { service, metric: 'latency_p95_ms', value: noise(p.p95) },
    { service, metric: 'latency_p50_ms', value: noise(p.p95 * 0.42) },
    { service, metric: 'cpu_percent', value: noise(p.cpu) },
    { service, metric: 'memory_percent', value: noise(p.mem, 0.03) },
    ...(service === 'checkout-service' ? [{ service, metric: 'db_connections', value: healed ? noise(22, 0.15) : 10 }] : []),
  ]);
  const n = () => Math.floor(Math.random() * 9000 + 1000);
  const logs = [
    { service: 'api-gateway', level: 'info', message: `GET /api/products?page=${n() % 40} 200 ${n() % 80}ms` },
    { service: 'inventory-service', level: 'info', message: `reserved sku=SKU-${n()} qty=${(n() % 3) + 1}` },
    { service: 'payment-service', level: 'info', message: `payment authorised provider=stripe amount_cents=${n()} latency=${200 + (n() % 200)}ms` },
    ...(healed
      ? [{ service: 'checkout-service', level: 'info', message: `order created order_id=${880000 + n()} total_cents=${n()} duration=${120 + (n() % 100)}ms` }]
      : Array.from({ length: 6 }, () => ({ service: 'checkout-service', level: 'error', message: `timeout acquiring connection from pool after ${3000 + (n() % 50)}ms (active=10 idle=0 waiting=${n() % 140})` })).concat([
          { service: 'api-gateway', level: 'error', message: `upstream checkout-service returned 503 for POST /api/checkout after ${3050 + (n() % 80)}ms` },
        ])),
  ];
  const [m, l] = await Promise.all([post('/monitoring/metrics', { samples }), post('/logs', { logs })]);
  console.warn(`${new Date().toISOString()} sent ${m.accepted} metric samples, ${l.accepted} log lines (${healed ? 'healthy' : 'incident'} profile)`);
}

async function main() {
  await tick();
  setInterval(() => void tick().catch((err) => console.error((err as Error).message)), 15_000);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
