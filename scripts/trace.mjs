#!/usr/bin/env node
// Prints the trace of one investigation: every hop from the HTTP request that started it,
// through the queue and the worker, into the AI service and back into the API for each tool
// call. Reads from the local trace store started by `npm run tracing:up`.
//
//   npm run trace -- <investigation id>     the trace of that investigation
//   npm run trace -- --latest               the most recent investigation trace
//   npm run trace -- <id> --all             include Redis, database and outgoing-HTTP detail
//
// Exit code 0 when the trace covers the whole lifecycle, 1 when a hop is missing.
const JAEGER = (process.env.TRACING_URL ?? 'http://localhost:16687').replace(/\/$/, '');
const args = process.argv.slice(2);
const showAll = args.includes('--all');
const latest = args.includes('--latest');
const id = args.find((a) => !a.startsWith('--'));

if (!id && !latest) {
  console.error('Usage: npm run trace -- <investigation id> | --latest [--all]');
  process.exit(2);
}

async function get(path) {
  let res;
  try {
    res = await fetch(`${JAEGER}${path}`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.error(`The trace store is not reachable at ${JAEGER} (${err.message}). Start it with: npm run tracing:up`);
    process.exit(2);
  }
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()).data;
}

const tagsOf = (span) => Object.fromEntries(span.tags.map((t) => [t.key, t.value]));

async function findTrace() {
  // The worker's span for the job always carries the investigation's id.
  const query = new URLSearchParams({ service: 'opspilot-worker', operation: 'process investigation', lookback: '6h', limit: latest ? '1' : '5' });
  if (id) query.set('tags', JSON.stringify({ 'opspilot.investigation.id': id }));
  const traces = await get(`/api/traces?${query}`);
  if (!traces?.length) return null;
  // More than one only if the job was retried; the newest is the one that finished.
  return traces.sort((a, b) => Math.max(...b.spans.map((s) => s.startTime)) - Math.max(...a.spans.map((s) => s.startTime)))[0];
}

const trace = await findTrace();
if (!trace) {
  console.error(id ? `No trace found for investigation ${id}.` : 'No investigation trace found.');
  console.error('Traces exist only for investigations started while tracing was on (npm run tracing:up), and are kept in memory.');
  process.exit(1);
}

const service = (span) => trace.processes[span.processID].serviceName;
const spans = trace.spans.map((span) => ({ ...span, tags: tagsOf(span), service: service(span), parent: span.references.find((r) => r.refType === 'CHILD_OF')?.spanID ?? null }));
const byId = new Map(spans.map((s) => [s.spanID, s]));
const children = new Map();
for (const span of spans) {
  const key = byId.has(span.parent) ? span.parent : null;
  children.set(key, [...(children.get(key) ?? []), span]);
}
for (const list of children.values()) list.sort((a, b) => a.startTime - b.startTime);

// Detail spans: single Redis commands, database calls, connection setup, and the framework's
// own layers (each Express middleware, the ASGI receive and send events).
const isDetail = (span) =>
  span.tags['db.system'] !== undefined ||
  span.tags['db.system.name'] !== undefined ||
  /^(tcp|dns|tls)\./.test(span.operationName) ||
  /^(middleware|router|request handler) - /.test(span.operationName) ||
  / http (receive|send)$/.test(span.operationName);
const failed = (span) => span.tags.error === true || span.tags['otel.status_code'] === 'ERROR';
const ms = (micros) => (micros >= 1_000_000 ? `${(micros / 1_000_000).toFixed(2)} s` : `${(micros / 1000).toFixed(1)} ms`);

let hidden = 0;
const lines = [];
function print(span, depth) {
  // A hidden span is skipped, not its subtree: what happened inside it is shown in its place.
  const shown = showAll || !isDetail(span);
  if (shown) {
    const status = span.tags['http.response.status_code'] ?? span.tags['http.status_code'];
    lines.push(`${'  '.repeat(depth)}${span.service.replace('opspilot-', '').padEnd(6)} ${span.operationName}${status ? ` → ${status}` : ''}${failed(span) ? '  [failed]' : ''}  (${ms(span.duration)})`);
  } else {
    hidden += 1;
  }
  for (const child of children.get(span.spanID) ?? []) print(child, shown ? depth + 1 : depth);
}
for (const root of children.get(null) ?? []) print(root, 0);

const start = Math.min(...spans.map((s) => s.startTime));
const end = Math.max(...spans.map((s) => s.startTime + s.duration));
const investigationId = spans.find((s) => s.tags['opspilot.investigation.id'])?.tags['opspilot.investigation.id'];
const run = spans.find((s) => s.operationName === 'investigation.run');
const tools = spans.filter((s) => s.service === 'opspilot-ai' && s.operationName.startsWith('tool '));
const servedTools = spans.filter((s) => s.service === 'opspilot-api' && s.tags['opspilot.tool.path']);

console.log(`Investigation ${investigationId}`);
console.log(`Trace ${trace.traceID}: ${spans.length} spans across ${[...new Set(spans.map((s) => s.service))].sort().join(', ')}; ${ms(end - start)} from request to stored report`);
if (run?.tags['opspilot.engine.mode']) console.log(`Engine: ${run.tags['opspilot.engine.mode']}; outcome: ${run.tags['opspilot.investigation.outcome']}; evidence items: ${run.tags['opspilot.investigation.evidence_count']}`);
console.log('');
console.log(lines.join('\n'));
if (hidden) console.log(`\n(${hidden} framework, Redis and connection spans hidden; add --all to see them)`);

// The lifecycle the trace must cover. Each line is a hop where context has to be handed on.
const has = (predicate) => spans.some(predicate);
const hops = [
  ['API request that started it', has((s) => s.service === 'opspilot-api' && /POST/.test(s.operationName) && s.tags['opspilot.investigation.id'])],
  ['job put on the queue', has((s) => s.service === 'opspilot-api' && s.operationName === 'enqueue investigation')],
  ['job picked up by the worker', has((s) => s.service === 'opspilot-worker' && s.operationName === 'process investigation' && byId.get(s.parent)?.operationName === 'enqueue investigation')],
  ['request to the AI service', has((s) => s.service === 'opspilot-ai' && s.operationName === 'investigation')],
  [`tool calls made by the AI service (${tools.length})`, tools.length > 0],
  [`tool calls served by the API (${servedTools.length})`, servedTools.length > 0 && servedTools.length >= tools.filter((t) => !failed(t)).length],
  ['guardrails and persistence in the worker', has((s) => s.operationName === 'investigation.guardrails') && has((s) => s.operationName === 'investigation.persist')],
];
console.log('\nLifecycle covered by this one trace:');
for (const [label, ok] of hops) console.log(`  ${ok ? 'yes' : 'NO '}  ${label}`);
console.log(`\nOpen it: ${JAEGER}/trace/${trace.traceID}`);
process.exit(hops.every(([, ok]) => ok) ? 0 : 1);
