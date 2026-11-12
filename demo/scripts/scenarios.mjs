// The failure scenarios: how each is switched on, what it does, how it is switched off,
// and how recovery is checked. Used by ctl.mjs (by hand) and e2e.mjs (automatically).
import { SERVICE_URLS, Session, admin, compose, dockerRunning, ingestKey, log, sleep } from './lib.mjs';

const record = (body) => new Session().must('POST', '/deployments', body, { key: ingestKey() });

export const SCENARIOS = {
  'db-latency': {
    title: 'Increased database latency',
    mechanism: 'Every statement shop-orders sends is preceded by a 400 ms pg_sleep in PostgreSQL. Requests succeed, slowly.',
    observable: 'shop-orders and shop-gateway p95 latency; traces whose time is in the pg.query span.',
    on: () => admin('shop-orders', '/faults', { dbDelayMs: 400 }),
    off: () => admin('shop-orders', '/faults', { dbDelayMs: 0 }),
  },
  'pool-exhaustion': {
    title: 'Database connection-pool exhaustion',
    mechanism: 'All 6 connections of the shop-orders pool are held by long-running statements. Requests wait 1.5 s for a connection and fail with 503.',
    observable: 'ERROR "timeout acquiring connection from pool"; shop-orders error rate, queue_depth (requests waiting) and db_connections at the pool size.',
    on: () => admin('shop-orders', '/faults', { poolHold: 6 }),
    off: () => admin('shop-orders', '/faults', { poolHold: 0 }),
  },
  'redis-outage': {
    title: 'Redis unavailable',
    mechanism: 'The demo-redis container is stopped. shop-payments refuses to charge without its idempotency store; shop-orders falls back from its cache to the database.',
    observable: 'shop-redis up = 0 (DOWN); shop-payments 503s and checkout 502s; WARN "cache read failed" in shop-orders; failed redis spans in traces.',
    on: () => compose(['stop', 'demo-redis'], { quiet: true }),
    off: () => compose(['start', 'demo-redis'], { quiet: true }),
  },
  'error-rate': {
    title: 'Increased API error rate',
    mechanism: 'shop-payments fails 40% of charge requests with a 500, as if its payment provider were failing.',
    observable: 'shop-payments error rate; ERROR "payment provider returned an error"; checkout 502s at the gateway.',
    on: () => admin('shop-payments', '/faults', { errorRate: 0.4 }),
    off: () => admin('shop-payments', '/faults', { errorRate: 0 }),
  },
  'bad-deploy': {
    title: 'Bad application deployment',
    mechanism: 'shop-orders switches to v1.5.0, whose order-total code reads a discount field most orders do not have. The deployment is recorded in OPSILUME as it happens.',
    observable: 'A deployment of shop-orders v1.5.0, followed by ERROR "failed to compute order total" and a jump in error rate.',
    on: async () => {
      await admin('shop-orders', '/deploy', { version: 'v1.5.0' });
      return record({ service: 'shop-orders', version: 'v1.5.0', commitSha: 'abababab1500', branch: 'main', deployedBy: 'demo-scenario', description: 'Simplify discount lookup in order totals' });
    },
    off: async () => {
      await admin('shop-orders', '/deploy', { version: 'v1.4.0' });
      // Recorded as a rollback of v1.5.0, which marks that deployment as rolled back.
      return record({ service: 'shop-orders', version: 'v1.4.0', commitSha: 'abababab1400', branch: 'main', deployedBy: 'demo-scenario', description: 'Roll back to v1.4.0 after errors in v1.5.0', rollbackOf: 'v1.5.0' });
    },
  },
  'upstream-down': {
    title: 'Upstream dependency failure',
    mechanism: 'The demo-payments container is stopped. shop-orders cannot reach it and checkouts fail.',
    observable: 'shop-payments up = 0 (DOWN); ERROR "upstream shop-payments request failed: ECONNREFUSED" in shop-orders; checkout 502s.',
    on: () => compose(['stop', 'demo-payments'], { quiet: true }),
    off: () => compose(['start', 'demo-payments'], { quiet: true }),
  },
};

/** Every fault off, every container running. This is the healthy baseline. */
export async function baseline() {
  for (const name of ['demo-redis', 'demo-payments']) if (!dockerRunning(`opspilot-${name}-1`)) compose(['start', name], { quiet: true });
  for (let i = 0; i < 30; i++) {
    try {
      await admin('shop-orders', '/faults', { dbDelayMs: 0, poolHold: 0 });
      await admin('shop-payments', '/faults', { errorRate: 0 });
      const { version } = await admin('shop-orders', '/state');
      if (version !== 'v1.4.0') await SCENARIOS['bad-deploy'].off();
      return;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error('Could not reach the demo services to restore the baseline.');
}

/** Sends real requests through the gateway and reports how they went. */
export async function probe(requests = 30) {
  let failed = 0;
  const times = [];
  for (let i = 0; i < requests; i++) {
    const started = performance.now();
    try {
      const res = i % 3 === 0
        ? await fetch(`${SERVICE_URLS['shop-gateway']}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'SKU-PROBE', amountCents: 1500, discount: null }), signal: AbortSignal.timeout(10_000) })
        : await fetch(`${SERVICE_URLS['shop-gateway']}/orders/${1 + (i % 200)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) failed += 1;
      await res.arrayBuffer();
    } catch {
      failed += 1;
    }
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { requests, failed, errorPercent: Math.round((failed / requests) * 1000) / 10, p95Ms: Math.round(times[Math.floor(times.length * 0.95) - 1] ?? 0) };
}

/** Recovery check: real requests succeed again and are fast again. */
export async function verifyRecovered({ attempts = 20 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await probe(24);
    if (last.failed === 0 && last.p95Ms < 400) return { recovered: true, ...last };
    await sleep(3000);
  }
  return { recovered: false, ...last };
}

export { log };
