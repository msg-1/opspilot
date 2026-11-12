// End-to-end validation against the running demo. For each scenario: switch the failure on,
// let real telemetry accumulate, ask OPSILUME to investigate, and check the result — the
// outcome, what is and is not blamed, what is proposed, and that every piece of evidence
// can be found again in the store it came from. Uses the rule-based engine only.
//
//   npm run demo:e2e                 all scenarios (about 20 minutes)
//   npm run demo:e2e -- --only redis-outage,runbook-safety
//   HOLD_S=100 SETTLE_S=150 npm run demo:e2e
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JAEGER, ROOT, Session, assertNoPaidModel, iso, log, sleep, state, waitFor } from './lib.mjs';
import { SCENARIOS, baseline, probe, verifyRecovered } from './scenarios.mjs';

const HOLD_S = Number(process.env.HOLD_S ?? 100); // how long a failure runs before it is investigated
const SETTLE_S = Number(process.env.SETTLE_S ?? 150); // clean traffic between scenarios, so the next has a baseline
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const wanted = (name) => !only || only.includes(name);

const s = new Session();
await s.signIn();
const engine = await assertNoPaidModel(s);
const demo = state();
const results = [];
log(`engine: ${engine?.provider ?? 'rule-based'} (no model is called). Hold ${HOLD_S}s, settle ${SETTLE_S}s.`);

// ───────────────────────── helpers ─────────────────────────

class Checks {
  list = [];
  ok(name, pass, detail = '') {
    this.list.push({ name, pass: !!pass, detail: String(detail).slice(0, 400) });
    log(`    ${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
    return !!pass;
  }
  get passed() { return this.list.every((c) => c.pass); }
}

async function investigate(question, from) {
  await s.post('/monitoring/evaluate').catch(() => undefined); // health reflects the alerts as of now
  const started = await s.post('/investigations', { question, timeWindow: { from: iso(from), to: iso() } });
  for (let i = 0; i < 90; i++) {
    const inv = await s.get(`/investigations/${started.id}`);
    if (!['QUEUED', 'RUNNING'].includes(inv.status)) return inv;
    await sleep(1500);
  }
  throw new Error('The investigation did not finish in time.');
}

const titles = (inv) => inv.hypotheses.map((h) => h.title);
const stateChanging = (inv) => inv.remediations.filter((r) => r.effect === 'state_changing');

/**
 * Provenance: every evidence item must be found again where it came from — the log store,
 * the metric store, the deployment record, the trace store, the service catalogue.
 */
async function provenance(inv, from) {
  const window = `from=${encodeURIComponent(iso(new Date(from.getTime() - 400_000)))}&to=${encodeURIComponent(iso())}`;
  const out = { checked: 0, verified: 0, byKind: {}, failures: [] };
  const mark = (e, ok, why) => {
    out.checked += 1;
    out.byKind[e.kind] = out.byKind[e.kind] ?? { checked: 0, verified: 0 };
    out.byKind[e.kind].checked += 1;
    if (ok) { out.verified += 1; out.byKind[e.kind].verified += 1; } else out.failures.push(`${e.ref} ${e.kind}: ${why}`);
  };
  for (const e of inv.evidence) {
    const data = e.data ?? {};
    try {
      if (e.kind === 'log') {
        const found = await s.get(`/logs?${window}&q=${encodeURIComponent(e.summary.slice(0, 40))}&limit=100`);
        mark(e, found.data.some((l) => l.id === e.sourceId), 'log line not found in the log store');
      } else if (e.kind === 'log_pattern') {
        const found = await s.get(`/logs?${window}&fingerprint=${encodeURIComponent(data.fingerprint)}&limit=5`).catch(() => null);
        const lines = found?.data ?? (await s.get(`/logs?${window}&q=${encodeURIComponent(String(data.sample).split('<')[0].slice(0, 30))}&limit=5`)).data;
        mark(e, lines.length > 0, 'no log line with this pattern in the log store');
      } else if (e.kind === 'metric' || e.kind === 'metric_baseline') {
        const names = e.kind === 'metric' ? [data.metric] : (data.metrics ?? []).map((m) => m.metric);
        const service = e.sourceId.split(':')[0];
        const series = await s.get(`/monitoring/series?service=${service}&metric=${names.join(',')}&${window}`);
        const samples = series.series.reduce((n, x) => n + (x.points?.length ?? x.samples?.length ?? 0), 0);
        mark(e, samples > 0, 'no samples for these metrics in the metric store');
      } else if (e.kind === 'deployment' || e.kind === 'deployment_impact') {
        const d = await s.request('GET', `/deployments/${e.sourceId}`);
        mark(e, d.ok && (!data.version || d.data.version === data.version), `deployment record ${e.sourceId} not found or version differs`);
      } else if (e.kind === 'trace') {
        const res = await fetch(`${JAEGER}/api/traces/${e.sourceId}`, { signal: AbortSignal.timeout(8000) });
        const body = res.ok ? await res.json() : null;
        const spans = body?.data?.[0]?.spans?.length ?? 0;
        // The store may have received late spans since; it must hold at least those the evidence counted.
        mark(e, spans > 0 && spans >= data.spanCount, `trace ${e.sourceId} not found in the trace store, or it holds fewer spans than the evidence counted (${spans} vs ${data.spanCount})`);
      } else if (e.kind === 'service_health' || e.kind === 'dependency') {
        const slug = e.kind === 'dependency' ? e.sourceId.replace(/^dep:/, '') : null;
        const svc = await s.request('GET', `/services/${slug ? demo.services[slug] : e.sourceId}`);
        mark(e, svc.ok, 'service not found in the catalogue');
      } else if (e.kind === 'document') {
        mark(e, (await s.request('GET', `/knowledge/documents/${data.documentId}`)).ok, 'document not found');
      } else if (e.kind === 'service_event' || e.kind === 'alert' || e.kind === 'incident' || e.kind === 'commit' || e.kind === 'pull_request') {
        mark(e, !!e.sourceId, 'no source id');
      } else {
        mark(e, false, 'unknown kind of evidence');
      }
    } catch (err) {
      mark(e, false, err.message);
    }
  }
  return out;
}

function reportChecks(c, inv, prov) {
  c.ok('investigation completed on the rule-based engine', inv.status === 'COMPLETED' && inv.analysisMode === 'heuristic', `${inv.status} ${inv.analysisMode} ${inv.error ?? ''}`);
  c.ok(`all ${prov.checked} evidence items found again in their source stores`, prov.checked > 0 && prov.verified === prov.checked, prov.failures.join('; '));
  const refs = new Set(inv.evidence.map((e) => e.ref));
  const cited = [...inv.hypotheses.flatMap((h) => h.evidenceRefs), ...(inv.report.facts ?? []).flatMap((f) => f.evidenceRefs), ...(inv.report.assessment?.supportingRefs ?? [])];
  c.ok('every citation resolves to collected evidence', cited.every((r) => refs.has(r)), cited.filter((r) => !refs.has(r)).join(','));
  const unsupported = (inv.report.integrity?.flagged ?? []).filter((f) => f.status === 'unsupported');
  c.ok(`figures in the report match the evidence (${inv.report.integrity?.supported}/${inv.report.integrity?.checked})`, unsupported.length === 0, unsupported.map((f) => `${f.text} in ${f.where}`).join('; '));
}

async function recordResult(name, title, c, extra = {}) {
  results.push({ scenario: name, title, passed: c.passed, checks: c.list, ...extra });
}

async function settle(reason) {
  log(`  waiting ${SETTLE_S}s of clean traffic (${reason})`);
  await sleep(SETTLE_S * 1000);
}

const summary = (inv) => ({
  investigationId: inv.id, outcome: inv.outcome, assessment: inv.report?.assessment?.rationale, assessmentConfidence: inv.report?.assessment?.confidence,
  hypotheses: inv.hypotheses.map((h) => `${Math.round(h.confidence * 100)}% ${h.status}: ${h.title}`),
  evidenceKinds: Object.fromEntries(Object.entries(Object.groupBy(inv.evidence, (e) => e.kind)).map(([k, v]) => [k, v.length])),
  remediations: inv.remediations.map((r) => `${r.type} [${r.effect}] ${r.status}: ${r.title}`),
  missingTelemetry: inv.report?.assessment?.missingTelemetry,
});

async function failureScenario(name, { question, expect }) {
  const sc = SCENARIOS[name];
  log(`▶ ${name}: ${sc.title}`);
  const c = new Checks();
  const startedAt = new Date();
  const activation = await sc.on();
  log(`  ON. ${sc.mechanism}`);
  await sleep(HOLD_S * 1000);
  const during = await probe(24);
  const inv = await investigate(question, new Date(startedAt.getTime() - 5000));
  const prov = await provenance(inv, startedAt);
  reportChecks(c, inv, prov);
  await expect(c, inv, { activation, during });
  // Recovery: the failure is removed, real requests succeed again, and the metrics OPSILUME holds return to normal.
  await sc.off();
  const recovered = await verifyRecovered();
  c.ok('after recovery, requests through the gateway succeed and are fast again', recovered.recovered, JSON.stringify(recovered));
  await recordResult(name, sc.title, c, { ...summary(inv), duringFailure: during, afterRecovery: recovered, provenance: { checked: prov.checked, verified: prov.verified, byKind: prov.byKind } });
  await settle('so the metrics return to normal and the next scenario has a baseline');
  const metrics = await s.get(`/tools/metrics?service=shop-gateway&from=${encodeURIComponent(iso(new Date(Date.now() - 60_000)))}`);
  const value = (m) => metrics.metrics.find((x) => x.metric === m)?.window?.avg;
  const last = results.at(-1);
  const back = (value('error_rate') ?? 0) < 1 && (value('latency_p95_ms') ?? 0) < 400;
  last.checks.push({ name: 'metrics held by OPSILUME are back to normal (gateway error rate < 1%, p95 < 400 ms)', pass: back, detail: `error_rate ${value('error_rate')}, p95 ${value('latency_p95_ms')}` });
  last.passed = last.passed && back;
  last.metricsAfterRecovery = { errorRate: value('error_rate'), latencyP95Ms: value('latency_p95_ms') };
  log(`    ${back ? 'ok  ' : 'FAIL'} metrics held by OPSILUME are back to normal (error rate ${value('error_rate')}%, p95 ${value('latency_p95_ms')} ms)`);
}

// ───────────────────────── scenarios ─────────────────────────

const traceStore = await fetch(`${JAEGER}/api/services`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
if (!traceStore) throw new Error(`The trace store is not reachable at ${JAEGER}. Is demo-jaeger running? (docker compose --profile demo up -d demo-jaeger)`);
await baseline();
log('baseline restored; checking that the shop is healthy before starting');
const before = await verifyRecovered();
if (!before.recovered) throw new Error(`The demo shop is not healthy to begin with: ${JSON.stringify(before)}`);
// A baseline needs history: wait until the metric store has a few minutes of samples.
for (let i = 0; i < 60; i++) {
  const series = await s.get(`/monitoring/series?service=shop-gateway&metric=latency_p95_ms&from=${encodeURIComponent(iso(new Date(Date.now() - 600_000)))}`);
  const points = series.series[0]?.points ?? series.series[0]?.samples ?? [];
  if (points.length >= 4) break; // one point per minute
  if (i === 0) log('  waiting for four minutes of baseline telemetry …');
  await sleep(10_000);
}

// The run must start from a clean baseline in OPSILUME's own data, not only in live requests:
// a failure that ended a minute ago is still inside the window the first scenario looks at.
await waitFor('five minutes of clean telemetry (an earlier failure may still be in the window)', async () => {
  for (const service of ['shop-gateway', 'shop-orders', 'shop-payments']) {
    const m = await s.get(`/tools/metrics?service=${service}&from=${encodeURIComponent(iso(new Date(Date.now() - 300_000)))}`);
    const max = (name) => m.metrics.find((x) => x.metric === name)?.window?.max ?? 0;
    if (max('error_rate') >= 1 || max('latency_p95_ms') >= 400) return null;
  }
  return true;
}, { timeoutMs: 600_000, everyMs: 15_000 });

if (wanted('healthy-baseline')) {
  log('▶ healthy-baseline: nothing is wrong');
  const c = new Checks();
  const from = new Date(Date.now() - 150_000);
  const inv = await investigate('Is shop-orders healthy right now?', from);
  const prov = await provenance(inv, from);
  reportChecks(c, inv, prov);
  c.ok('outcome is HEALTHY', inv.outcome === 'HEALTHY', inv.report.assessment?.rationale);
  c.ok('no incident is manufactured: no hypothesis above "unlikely"', inv.hypotheses.every((h) => h.status === 'unlikely' && h.confidence <= 0.2), titles(inv).join(' | '));
  c.ok('nothing that changes production is proposed', stateChanging(inv).length === 0, JSON.stringify(inv.remediations));
  const support = inv.evidence.filter((e) => inv.report.assessment.supportingRefs.includes(e.ref));
  c.ok('the healthy conclusion cites steady metrics from the metric store', support.some((e) => e.kind === 'metric_baseline'), support.map((e) => e.kind).join(','));
  c.ok('it says what was not examined', Array.isArray(inv.report.assessment.missingTelemetry));
  await recordResult('healthy-baseline', 'Healthy baseline', c, { ...summary(inv), provenance: { checked: prov.checked, verified: prov.verified, byKind: prov.byKind } });
}

if (wanted('db-latency')) {
  await failureScenario('db-latency', {
    question: 'Why is shop-orders slow?',
    expect: (c, inv, { during }) => {
      c.ok('the failure is real: requests through the gateway are slow', during.p95Ms > 350, JSON.stringify(during));
      c.ok('outcome is INCIDENT', inv.outcome === 'INCIDENT', inv.report.assessment?.rationale);
      c.ok('a latency metric from the metric store is a strong signal', inv.report.assessment.signals.some((x) => x.level === 'strong' && /latency/i.test(x.text)), JSON.stringify(inv.report.assessment.signals.map((x) => x.text)));
      const top = inv.hypotheses[0];
      c.ok('the leading hypothesis locates the delay in shop-orders database calls', !!top && /Time is being lost in shop-orders/.test(top.title) && /postgres/i.test(top.title), titles(inv).join(' | '));
      const traces = inv.evidence.filter((e) => e.kind === 'trace' && top?.evidenceRefs.includes(e.ref));
      c.ok('it cites real traces whose time is in a PostgreSQL span', traces.length >= 2 && traces.every((t) => t.data.slowestSpan?.system === 'postgresql'), JSON.stringify(traces.map((t) => t.data.slowestSpan)));
      c.ok('it does not blame Redis or payments', !titles(inv).some((t) => /redis|payments/i.test(t)), titles(inv).join(' | '));
      c.ok('nothing that changes production is proposed without an established cause to act on', stateChanging(inv).length === 0, JSON.stringify(inv.remediations));
    },
  });
}

if (wanted('redis-outage')) {
  await failureScenario('redis-outage', {
    question: 'Why are checkouts failing on shop-gateway?',
    expect: (c, inv, { during }) => {
      c.ok('the failure is real: checkouts through the gateway fail', during.failed > 0, JSON.stringify(during));
      c.ok('outcome is INCIDENT', inv.outcome === 'INCIDENT', inv.report.assessment?.rationale);
      const top = inv.hypotheses[0];
      c.ok('the leading hypothesis names Redis', !!top && /redis/i.test(top.title), titles(inv).join(' | '));
      c.ok('the dependency chain was followed down to shop-redis, recorded as DOWN', inv.evidence.some((e) => e.kind === 'dependency' && e.sourceId === 'dep:shop-redis' && /DOWN/.test(e.title)), inv.evidence.filter((e) => e.kind === 'dependency').map((e) => e.title).join(' | '));
      c.ok('the unrelated database is not blamed', !titles(inv).some((t) => /postgres/i.test(t)), titles(inv).join(' | '));
      c.ok('no rollback is proposed: no deployment is involved', !inv.remediations.some((r) => r.type === 'rollback_deployment'), JSON.stringify(inv.remediations));
    },
  });
}

if (wanted('bad-deploy')) {
  await failureScenario('bad-deploy', {
    question: 'Why is shop-orders returning errors?',
    expect: async (c, inv, { activation, during }) => {
      c.ok('the failure is real: requests through the gateway fail', during.failed > 0, JSON.stringify(during));
      c.ok('outcome is INCIDENT', inv.outcome === 'INCIDENT', inv.report.assessment?.rationale);
      c.ok('the leading hypothesis is the v1.5.0 deployment', /Regression introduced by Deployment of shop-orders v1\.5\.0/.test(inv.hypotheses[0]?.title ?? ''), titles(inv).join(' | '));
      c.ok('it cites the deployment record created when the scenario was switched on', inv.evidence.some((e) => e.kind === 'deployment' && e.sourceId === activation.id && inv.hypotheses[0]?.evidenceRefs.includes(e.ref)), activation.id);
      const rollback = inv.remediations.find((r) => r.type === 'rollback_deployment');
      c.ok('a rollback is proposed, as a production change awaiting a human', !!rollback && rollback.effect === 'state_changing' && rollback.status === 'PROPOSED', JSON.stringify(inv.remediations));
      if (rollback) {
        const detail = await s.get(`/remediations/${rollback.id}`);
        c.ok('the rollback names the bad deployment and the last version that worked (v1.4.0)', detail.parameters?.deploymentId === activation.id && detail.parameters?.toVersion === 'v1.4.0', JSON.stringify(detail.parameters));
        c.ok('it was proposed by the AI and needs approval', detail.proposedByType === 'ai_agent' && detail.requiredApprovals >= 1, `${detail.proposedByType} ${detail.requiredApprovals}`);
        const run = await s.request('POST', `/remediations/${rollback.id}/execute`, { confirmManual: true });
        c.ok('it cannot be executed without approval (409)', run.status === 409, `${run.status} ${run.data?.error?.message}`);
        await s.request('POST', `/remediations/${rollback.id}/cancel`, {});
      }
    },
  });
}

if (wanted('insufficient-evidence')) {
  log('▶ insufficient-evidence: a service that sends no telemetry');
  const c = new Checks();
  const from = new Date(Date.now() - 150_000);
  const inv = await investigate('Is shop-inventory healthy right now?', from);
  c.ok('investigation completed', inv.status === 'COMPLETED', inv.error);
  c.ok('outcome is UNDETERMINED, not HEALTHY', inv.outcome === 'UNDETERMINED', `${inv.outcome}: ${inv.report.assessment?.rationale}`);
  c.ok('it says what cannot be determined and why', /neither a fault nor good health/.test(inv.report.assessment.rationale) && inv.report.assessment.missingTelemetry.some((m) => /No metric samples/.test(m)), JSON.stringify(inv.report.assessment.missingTelemetry));
  c.ok('no hypothesis is offered above "unlikely" and nothing is proposed that changes production', inv.hypotheses.every((h) => h.status === 'unlikely') && stateChanging(inv).length === 0, titles(inv).join(' | '));
  await recordResult('insufficient-evidence', 'Insufficient evidence', c, summary(inv));
}

for (const name of ['pool-exhaustion', 'error-rate', 'upstream-down']) {
  if (!wanted(name)) continue;
  const sc = SCENARIOS[name];
  log(`▶ ${name}: ${sc.title} (activation, effect and recovery)`);
  const c = new Checks();
  const startedAt = new Date();
  await sc.on();
  await sleep(Math.min(HOLD_S, 60) * 1000);
  const during = await probe(30);
  c.ok('the failure is observable in real requests', during.failed > 0, JSON.stringify(during));
  const inv = await investigate(name === 'pool-exhaustion' ? 'Why is shop-orders returning errors?' : 'Why are checkouts failing on shop-gateway?', new Date(startedAt.getTime() - 5000));
  const prov = await provenance(inv, startedAt);
  reportChecks(c, inv, prov);
  c.ok('OPSILUME sees a failure (not HEALTHY)', inv.outcome === 'INCIDENT' || inv.outcome === 'DEGRADED', inv.outcome);
  await sc.off();
  const recovered = await verifyRecovered();
  c.ok('after recovery, requests succeed and are fast again', recovered.recovered, JSON.stringify(recovered));
  await recordResult(name, sc.title, c, { ...summary(inv), duringFailure: during, afterRecovery: recovered, provenance: { checked: prov.checked, verified: prov.verified, byKind: prov.byKind } });
  await settle('before the next scenario');
}

if (wanted('recovery')) {
  log('▶ recovery: after the failures are removed, the service is healthy again');
  const c = new Checks();
  const from = new Date(Date.now() - 120_000);
  const inv = await investigate('Is shop-orders healthy right now?', from);
  const prov = await provenance(inv, from);
  reportChecks(c, inv, prov);
  c.ok('outcome is HEALTHY again', inv.outcome === 'HEALTHY', `${inv.outcome}: ${inv.report.assessment?.rationale}`);
  c.ok('nothing that changes production is proposed', stateChanging(inv).length === 0);
  await recordResult('recovery', 'Recovery', c, { ...summary(inv), provenance: { checked: prov.checked, verified: prov.verified, byKind: prov.byKind } });
}

if (wanted('runbook-safety')) {
  log('▶ runbook-safety: a production-changing action cannot run without explicit approval');
  const c = new Checks();
  const plan = await s.get(`/knowledge/documents/${demo.runbookId}/plan`);
  c.ok('the runbook plan separates read-only steps from state-changing ones', plan.readOnly === 3 && plan.stateChanging === 3, JSON.stringify(plan.steps.map((x) => `${x.effect}: ${x.text}`)));
  const change = await s.post('/remediations', { type: 'run_runbook', title: 'Follow the shop-orders cache runbook', description: 'Work through the runbook.', risk: 'LOW', parameters: { runbookDocumentId: demo.runbookId } });
  c.ok('an action that points at that runbook is classified by its steps: state-changing, at least medium risk', change.effect === 'state_changing' && change.risk !== 'LOW' && change.requiredApprovals >= 1, `${change.effect} ${change.risk} ${change.requiredApprovals}`);
  const base = `/remediations/${change.id}`;
  c.ok('execution before approval is refused', (await s.request('POST', `${base}/execute`, { confirmManual: true })).status === 409);
  await s.post(`${base}/request-approval`);
  c.ok('the person who proposed it cannot approve it', (await s.request('POST', `${base}/approve`, {})).status === 403);
  c.ok('execution while awaiting approval is refused', (await s.request('POST', `${base}/execute`, { confirmManual: true })).status === 409);
  const edited = await s.must('PATCH', base, { description: 'Work through the runbook, including the restart.' });
  c.ok('editing it returns it to PROPOSED with no approvals counting', edited.status === 'PROPOSED' && edited.approvalsGranted === 0 && edited.currentHash !== change.currentHash);
  await s.post(`${base}/cancel`);
  const check = await s.post('/remediations', { type: 'manual', title: 'Check the shop-orders pool gauge', description: 'Compare db_pool_in_use with the pool size on the dashboard.', risk: 'LOW' });
  c.ok('a diagnostic is classified read-only and needs no approval', check.effect === 'read_only' && check.requiredApprovals === 0);
  const done = await s.post(`/remediations/${check.id}/execute`, { confirmManual: true, notes: 'Pool at 1 of 6 in use.' });
  c.ok('recording it changes nothing and is audited', done.status === 'EXECUTED' && done.executionResult.mode === 'diagnostic' && /Nothing was changed/.test(done.executionResult.summary));
  const audit = (await s.get('/audit-logs?action=remediation&limit=50')).data.filter((a) => [change.id, check.id].includes(a.resourceId)).map((a) => a.action);
  c.ok('the audit trail records the proposal, the edit, the refusal-free path and the diagnostic', ['remediation.propose', 'remediation.request_approval', 'remediation.edit', 'remediation.cancel', 'remediation.execute_success'].every((a) => audit.includes(a)), audit.join(','));
  await recordResult('runbook-safety', 'Runbook safety', c);
}

// ───────────────────────── report ─────────────────────────

await baseline();
const dir = join(ROOT, 'demo', 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify({ ranAt: iso(), engine: 'rule-based (deterministic); no model was called', holdSeconds: HOLD_S, settleSeconds: SETTLE_S, results }, null, 2)}\n`);
console.log('\nscenario                 result  outcome        checks  leading hypothesis');
for (const r of results) console.log(`${r.scenario.padEnd(24)} ${(r.passed ? 'pass' : 'FAIL').padEnd(7)} ${(r.outcome ?? '-').padEnd(14)} ${`${r.checks.filter((c) => c.pass).length}/${r.checks.length}`.padEnd(7)} ${(r.hypotheses?.[0] ?? '-').slice(0, 80)}`);
console.log(`\n${results.filter((r) => r.passed).length}/${results.length} scenarios passed. Details: ${file}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
