// Telemetry bridge: reads the services' metrics from Prometheus and probes the two data stores,
// then writes the results into OPSILUME through its metric ingestion API. This is the only path
// by which metrics reach OPSILUME; nothing here is synthesised.
const net = require('node:net');

const PROM = process.env.PROMETHEUS_URL;
const API = process.env.OPSPILOT_API_URL;
const KEY = process.env.OPSPILOT_API_KEY;
const EVERY_MS = Number(process.env.BRIDGE_INTERVAL_MS || 10_000);
const WINDOW = '45s';
const SERVICES = { 'shop-gateway': 'demo-gateway', 'shop-orders': 'demo-orders', 'shop-payments': 'demo-payments' };

async function prom(query) {
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(4000) });
  const body = await res.json();
  const value = body.data?.result?.[0]?.value?.[1];
  return value === undefined || value === 'NaN' ? null : Number(value);
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(1); });
    socket.once('timeout', () => { socket.destroy(); resolve(0); });
    socket.once('error', () => resolve(0));
  });
}

async function collect() {
  const samples = [];
  const add = (service, metric, value) => { if (value !== null && Number.isFinite(value)) samples.push({ service, metric, value: Math.round(value * 1000) / 1000 }); };
  for (const [service, job] of Object.entries(SERVICES)) {
    const up = await prom(`up{job="${job}"}`);
    add(service, 'up', up ?? 0);
    if (!up) continue;
    const total = await prom(`sum(rate(http_requests_total{job="${job}"}[${WINDOW}]))`);
    const errors = await prom(`sum(rate(http_requests_total{job="${job}",code=~"5.."}[${WINDOW}]))`);
    add(service, 'requests_per_min', total === null ? null : total * 60);
    add(service, 'error_rate', total ? ((errors ?? 0) / total) * 100 : total === 0 ? 0 : null);
    add(service, 'latency_p95_ms', (await prom(`histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="${job}"}[${WINDOW}])))`)) * 1000 || null);
    add(service, 'latency_p50_ms', (await prom(`histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{job="${job}"}[${WINDOW}])))`)) * 1000 || null);
    add(service, 'memory_percent', await prom(`app_process_resident_memory_bytes{job="${job}"} / 268435456 * 100`));
    if (service === 'shop-orders') {
      add(service, 'db_connections', await prom(`db_pool_in_use{job="${job}"}`));
      add(service, 'queue_depth', await prom(`db_pool_waiting{job="${job}"}`));
    }
  }
  add('shop-redis', 'up', await tcp(process.env.REDIS_HOST || 'demo-redis', 6379));
  add('shop-postgres', 'up', await tcp(process.env.POSTGRES_HOST || 'demo-postgres', 5432));
  return samples;
}

async function tick() {
  try {
    const samples = await collect();
    const res = await fetch(`${API}/api/v1/monitoring/metrics`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ samples }), signal: AbortSignal.timeout(5000) });
    console.log(JSON.stringify({ service: 'shop-bridge', sent: samples.length, status: res.status }));
  } catch (err) {
    console.log(JSON.stringify({ service: 'shop-bridge', level: 'warn', message: `metrics not forwarded: ${err.message}` }));
  }
}
if (!KEY) { console.error('OPSPILOT_API_KEY is not set: run `npm run demo:setup` first.'); process.exit(1); }
tick();
setInterval(tick, EVERY_MS);
