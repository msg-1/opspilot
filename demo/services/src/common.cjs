// Shared by the three services: structured logs shipped to OPSILUME, Prometheus metrics,
// fault state, and the admin endpoints the failure scenarios use.
const express = require('express');
const client = require('prom-client');
const { trace } = require('@opentelemetry/api');

const SERVICE = process.env.SERVICE_NAME;
const API = process.env.OPSPILOT_API_URL;
const KEY = process.env.OPSPILOT_API_KEY;
const ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN || 'local-demo';

// ── Logs: JSON on stdout, and the same lines shipped in batches to the log ingestion API ──
const queue = [];
function log(level, message, attributes = {}) {
  const span = trace.getActiveSpan()?.spanContext();
  const entry = { timestamp: new Date().toISOString(), level, message, traceId: span?.traceId, spanId: span?.spanId, attributes: { version: state.version, ...attributes } };
  process.stdout.write(`${JSON.stringify({ service: SERVICE, ...entry })}\n`);
  if (API && KEY && queue.length < 5000) queue.push(entry);
}
async function ship() {
  if (!queue.length) return;
  const logs = queue.splice(0, 500);
  try {
    const res = await fetch(`${API}/api/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ service: SERVICE, environment: 'production', logs }), signal: AbortSignal.timeout(4000) });
    if (!res.ok) process.stdout.write(`${JSON.stringify({ service: SERVICE, level: 'warn', message: `log shipping refused: HTTP ${res.status}` })}\n`);
  } catch (err) {
    // The log store being down must not take the service down; the lines stay on stdout.
    process.stdout.write(`${JSON.stringify({ service: SERVICE, level: 'warn', message: `log shipping failed: ${err.message}` })}\n`);
  }
}
if (API && KEY) setInterval(ship, 2000).unref();

// ── Metrics ──
client.collectDefaultMetrics({ prefix: 'app_' });
const requests = new client.Counter({ name: 'http_requests_total', help: 'Requests handled', labelNames: ['route', 'code'] });
const duration = new client.Histogram({ name: 'http_request_duration_seconds', help: 'Request duration', labelNames: ['route'], buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5, 3, 6, 12] });

// ── Faults and version: changed only through /admin, by the scenario scripts ──
const state = { version: process.env.SERVICE_VERSION || 'v1.0.0', faults: {} };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/metrics' || req.path.startsWith('/admin')) return next();
    const end = duration.startTimer();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.method} ${req.baseUrl}${req.route.path}` : `${req.method} unmatched`;
      requests.inc({ route, code: String(res.statusCode) });
      const seconds = end({ route });
      // An access log for one request in twenty: enough to show that the service is alive and logging.
      if (res.statusCode < 500 && Math.random() < 0.05) log('info', `${route} ${res.statusCode} in ${Math.round(seconds * 1000)}ms`, { route, status: res.statusCode });
    });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE, version: state.version }));
  app.get('/metrics', async (_req, res) => res.type(client.register.contentType).send(await client.register.metrics()));
  const admin = express.Router();
  admin.use((req, res, next) => (req.get('x-admin-token') === ADMIN_TOKEN ? next() : res.status(403).json({ error: 'admin token required' })));
  admin.get('/state', (_req, res) => res.json(state));
  app.use('/admin', admin);
  return { app, admin };
}

/** Wraps an async handler so a thrown error becomes a logged 5xx instead of a hung request. */
const handler = (fn) => (req, res) => {
  fn(req, res).catch((err) => {
    const status = err.status || 500;
    log(status >= 500 ? 'error' : 'warn', err.message, { route: `${req.method} ${req.path}`, status, ...(err.attributes || {}) });
    trace.getActiveSpan()?.recordException(err);
    if (!res.headersSent) res.status(status).json({ error: err.message, service: SERVICE });
  });
};
const fail = (status, message, attributes) => Object.assign(new Error(message), { status, attributes });

module.exports = { SERVICE, client, createApp, fail, handler, log, state };
