// shop-gateway: the public edge. Forwards to shop-orders and adds nothing else.
const { createApp, fail, handler, log } = require('./common.cjs');

const ORDERS = process.env.ORDERS_URL;
const { app } = createApp();

async function forward(method, path, body) {
  let res;
  try {
    res = await fetch(`${ORDERS}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw fail(502, `upstream shop-orders request failed: ${err.cause?.code || err.name}`, { upstream: 'shop-orders' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status >= 500 ? 502 : res.status, `upstream shop-orders returned ${res.status}: ${data.error || 'no detail'}`, { upstream: 'shop-orders', upstreamStatus: res.status });
  return data;
}

app.get('/orders/:id', handler(async (req, res) => res.json(await forward('GET', `/orders/${encodeURIComponent(req.params.id)}`))));
app.post('/checkout', handler(async (req, res) => res.status(201).json(await forward('POST', '/orders', req.body))));

app.listen(8080, () => log('info', 'shop-gateway listening on 8080'));
