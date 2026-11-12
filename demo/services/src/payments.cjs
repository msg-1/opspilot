// shop-payments: takes a payment once per order. Redis holds the idempotency keys, so without
// Redis it refuses to charge rather than risk charging twice.
const Redis = require('ioredis');
const { createApp, fail, handler, log, state } = require('./common.cjs');

const redis = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 800, retryStrategy: (n) => Math.min(n * 500, 3000) });
redis.on('error', () => undefined);
const { app, admin } = createApp();

app.post('/pay', handler(async (req, res) => {
  const { orderId, amountCents } = req.body || {};
  if (!orderId) throw fail(400, 'orderId is required');
  let first;
  try {
    first = await redis.set(`paid:${orderId}`, String(amountCents), 'EX', 3600, 'NX');
  } catch (err) {
    throw fail(503, `idempotency store unavailable, refusing to charge: ${err.message}`, { dependency: 'shop-redis', orderId });
  }
  // Fault "error-rate": the provider call fails for a share of requests.
  if (state.faults.errorRate && Math.random() < state.faults.errorRate) {
    await redis.del(`paid:${orderId}`).catch(() => undefined);
    throw fail(500, 'payment provider returned an error for the charge request', { provider: 'simulated', orderId });
  }
  await new Promise((r) => setTimeout(r, 15 + Math.random() * 20)); // the provider call
  res.json({ orderId, charged: first === 'OK', amountCents });
}));

admin.post('/faults', handler(async (req, res) => {
  if (req.body?.errorRate !== undefined) state.faults.errorRate = Math.max(0, Math.min(Number(req.body.errorRate) || 0, 1));
  log('warn', `fault configuration changed: ${JSON.stringify(state.faults)}`, { admin: true });
  res.json(state);
}));

app.listen(8080, () => log('info', 'shop-payments listening on 8080'));
