// Open-loop load: a fixed number of requests per second whatever the response time, so that
// throughput stays level during a failure and only errors and latency move.
const TARGET = process.env.GATEWAY_URL;
const RPS = Number(process.env.LOAD_RPS || 6);
let sent = 0;
let failed = 0;

function fire() {
  sent += 1;
  const read = Math.random() < 0.7;
  const id = 1 + Math.floor(Math.random() * 200);
  const request = read
    ? fetch(`${TARGET}/orders/${id}`, { signal: AbortSignal.timeout(10_000) })
    : fetch(`${TARGET}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: `SKU-${id}`, amountCents: 1000 + id * 7, discount: id % 5 === 0 ? { code: 'SPRING', percent: 10 } : null }), signal: AbortSignal.timeout(10_000) });
  request.then((res) => { if (!res.ok) failed += 1; return res.arrayBuffer(); }).catch(() => { failed += 1; });
}
setInterval(fire, 1000 / RPS);
setInterval(() => { console.log(JSON.stringify({ service: 'shop-load', sent, failed })); sent = 0; failed = 0; }, 30_000);
console.log(JSON.stringify({ service: 'shop-load', message: `sending ${RPS} requests per second to ${TARGET}` }));
