// shop-orders: orders in PostgreSQL, read-through cache in Redis, payment through shop-payments.
const { Pool } = require('pg');
const Redis = require('ioredis');
const { client, createApp, fail, handler, log, state } = require('./common.cjs');

const POOL_MAX = Number(process.env.DB_POOL_MAX || 6);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: POOL_MAX, connectionTimeoutMillis: 1500 });
pool.on('error', (err) => log('error', `database connection error: ${err.message}`));
const redis = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 800, retryStrategy: (n) => Math.min(n * 500, 3000) });
redis.on('error', () => undefined); // reported per request below, not once per reconnect attempt
const PAYMENTS = process.env.PAYMENTS_URL;

new client.Gauge({ name: 'db_pool_in_use', help: 'Connections checked out of the pool', collect() { this.set(pool.totalCount - pool.idleCount); } });
new client.Gauge({ name: 'db_pool_waiting', help: 'Requests waiting for a connection', collect() { this.set(pool.waitingCount); } });
new client.Gauge({ name: 'db_pool_max', help: 'Pool size', collect() { this.set(POOL_MAX); } });
const cacheErrors = new client.Counter({ name: 'cache_errors_total', help: 'Failed cache operations' });

async function db(text, params) {
  let conn;
  try {
    conn = await pool.connect();
  } catch (err) {
    throw fail(503, `timeout acquiring connection from pool after 1500ms (pool size ${POOL_MAX}, ${pool.waitingCount} waiting)`, { pool: { max: POOL_MAX, waiting: pool.waitingCount }, cause: err.message });
  }
  try {
    // Fault "db-latency": every statement is preceded by a real sleep in the database.
    if (state.faults.dbDelayMs) await conn.query('SELECT pg_sleep($1)', [state.faults.dbDelayMs / 1000]);
    return await conn.query(text, params);
  } finally {
    conn.release();
  }
}

async function cached(key, load) {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) {
    cacheErrors.inc();
    log('warn', `cache read failed, falling back to the database: ${err.message}`, { dependency: 'shop-redis' });
  }
  const value = await load();
  if (value) redis.set(key, JSON.stringify(value), 'EX', 30).catch(() => cacheErrors.inc());
  return value;
}

/** Order total. v1.5.0 "simplified" the discount lookup and reads a field that most orders do not have. */
function total(order) {
  if (state.version === 'v1.5.0') return Math.round(order.amount_cents * (1 - order.discount.percent / 100));
  return Math.round(order.amount_cents * (1 - (order.discount?.percent ?? 0) / 100));
}

const { app, admin } = createApp();

app.get('/orders/:id', handler(async (req, res) => {
  const order = await cached(`order:${req.params.id}`, async () => (await db('SELECT id, sku, amount_cents, discount, status FROM orders WHERE id = $1', [Number(req.params.id) || 0])).rows[0]);
  if (!order) throw fail(404, 'order not found');
  let totalCents;
  try {
    totalCents = total(order);
  } catch (err) {
    throw fail(500, `failed to compute order total: ${err.message}`, { orderId: order.id });
  }
  res.json({ ...order, total_cents: totalCents });
}));

app.post('/orders', handler(async (req, res) => {
  const { sku = 'SKU-1', amountCents = 1999, discount = null } = req.body || {};
  let totalCents;
  try {
    totalCents = total({ amount_cents: amountCents, discount });
  } catch (err) {
    throw fail(500, `failed to compute order total: ${err.message}`, { sku });
  }
  const { rows } = await db('INSERT INTO orders (sku, amount_cents, discount, status) VALUES ($1, $2, $3, $4) RETURNING id', [sku, amountCents, discount, 'pending']);
  let paid;
  try {
    paid = await fetch(`${PAYMENTS}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: rows[0].id, amountCents: totalCents }), signal: AbortSignal.timeout(4000) });
  } catch (err) {
    throw fail(502, `upstream shop-payments request failed: ${err.cause?.code || err.name}`, { upstream: 'shop-payments', orderId: rows[0].id });
  }
  if (!paid.ok) {
    const detail = await paid.json().catch(() => ({}));
    throw fail(502, `upstream shop-payments returned ${paid.status}: ${detail.error || 'no detail'}`, { upstream: 'shop-payments', upstreamStatus: paid.status, orderId: rows[0].id });
  }
  await db('UPDATE orders SET status = $2 WHERE id = $1', [rows[0].id, 'paid']);
  res.status(201).json({ id: rows[0].id, total_cents: totalCents, status: 'paid' });
}));

// ── Admin: failure scenarios ──
const held = [];
async function releaseHeld() {
  // Cancel the sleeping statements from a connection outside the pool, then give the connections back.
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const h of held.splice(0)) {
    await c.query('SELECT pg_cancel_backend($1)', [h.processID]).catch(() => undefined);
    h.release(true);
  }
  await c.end();
}
admin.post('/faults', handler(async (req, res) => {
  const { dbDelayMs, poolHold } = req.body || {};
  if (dbDelayMs !== undefined) state.faults.dbDelayMs = Math.max(0, Math.min(Number(dbDelayMs) || 0, 5000));
  if (poolHold !== undefined) {
    await releaseHeld();
    const n = Math.max(0, Math.min(Number(poolHold) || 0, POOL_MAX));
    for (let i = 0; i < n; i++) {
      const conn = await pool.connect();
      conn.query('SELECT pg_sleep(3600)').catch(() => undefined); // holds the connection until cancelled
      held.push(conn);
    }
    state.faults.poolHold = n;
  }
  log('warn', `fault configuration changed: ${JSON.stringify(state.faults)}`, { admin: true });
  res.json(state);
}));
admin.post('/deploy', handler(async (req, res) => {
  const previous = state.version;
  state.version = String(req.body?.version || 'v1.4.0');
  log('info', `version changed from ${previous} to ${state.version}`, { admin: true });
  res.json({ previous, ...state });
}));

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS orders (id serial PRIMARY KEY, sku text NOT NULL, amount_cents int NOT NULL, discount jsonb, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
      // A fixed set of orders to read. One in five carries a discount, as in real traffic.
      if (rows[0].n < 200) await pool.query(`INSERT INTO orders (sku, amount_cents, discount, status) SELECT 'SKU-' || g, 1000 + g * 7, CASE WHEN g % 5 = 0 THEN '{"code":"SPRING","percent":10}'::jsonb END, 'paid' FROM generate_series(1, 200) g`);
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  app.listen(8080, () => log('info', 'shop-orders listening on 8080'));
}
start();
