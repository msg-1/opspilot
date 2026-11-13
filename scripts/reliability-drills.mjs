#!/usr/bin/env node
// Failure drills against the isolated stack (scripts/isolated-stack.mjs): real containers are
// killed, stopped and started, and each drill checks what the application recorded and
// whether it does real work again afterwards. A drill passes on evidence in the data, never
// on a status code alone.
//
//   npm run isolated:up && npm run drills            all drills
//   npm run drills -- worker-killed redis-down       some of them
//
// Every docker command goes through the isolated Compose project. The default project
// ("opspilot"), its containers and its database are never addressed.
import { spawnSync } from 'node:child_process';
import { PROJECT, URLS, compose, secrets } from './isolated-stack.mjs';

if (PROJECT === 'opspilot') throw new Error('Refusing to run failure drills against the default Compose project.');

const DEMO = { email: 'demo@example.com', password: 'OpsPilot-demo-1' }; // the documented demo account of a freshly seeded stack
const API = `${URLS.api}/api/v1`;
const INTERRUPTED = 'the worker stopped before this investigation finished';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

class Session {
  cookies = new Map();
  async request(method, path, body) {
    // No connection reuse: this script blocks while docker commands run, and a kept-alive socket
    // that the server closed in the meantime would fail the next request for no real reason.
    const headers = { 'content-type': 'application/json', origin: URLS.web, connection: 'close' };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let res;
    try {
      res = await fetch(path.startsWith('http') ? path : `${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      return { status: 0, data: { error: { message: String(err.message) } } };
    }
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: res.status, data };
  }
  get = (path) => this.request('GET', path);
  post = (path, body) => this.request('POST', path, body ?? {});
  async login() {
    const res = await this.post('/auth/login', DEMO);
    if (res.status !== 200) throw new Error(`sign-in failed (${res.status} ${JSON.stringify(res.data).slice(0, 200)}). Is the isolated stack up and freshly seeded? npm run isolated:up`);
  }
}

const session = new Session();
let incidentId;

async function until(read, done, what, timeoutMs = 60_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}; last: ${JSON.stringify(value)?.slice(0, 300)}`);
    await pause(everyMs);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dc = (...args) => {
  const res = compose(args, { capture: true });
  if (res.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed: ${res.stderr.trim().split('\n').pop()}`);
  return res.stdout.trim();
};
const containerState = (service) => {
  const id = dc('ps', '-aq', service).split('\n')[0];
  const res = spawnSync('docker', ['inspect', '-f', '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}', id], { encoding: 'utf8' });
  return res.stdout.trim();
};
const ready = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch(() => ({ status: 0, body: {} }));
const apiReady = () => ready(`${URLS.api}/ready`);
const waitReady = () => until(apiReady, (r) => r.status === 200, 'the API to be ready', 120_000);
/** Healthy as Compose sees it: the container's own readiness check. */
const waitHealthy = (service) => until(() => dc('ps', '--format', '{{.Health}}', service), (h) => h === 'healthy', `${service} to be healthy`, 180_000, 1000);

const start = (question) => session.post('/investigations', { question, incidentId });
const read = async (id) => (await session.get(`/investigations/${id}`)).data;
const ended = (id, timeoutMs = 90_000) => until(() => read(id), (i) => i.status && !['QUEUED', 'RUNNING'].includes(i.status), 'the investigation to end', timeoutMs);
const running = (id) => until(() => read(id), (i) => i.status === 'RUNNING', 'the investigation to be running', 30_000, 200);

/** A stored report with content, produced by the rule-based engine: the proof that the stack does real work. */
async function completes(question) {
  const started = await until(() => start(question), (r) => r.status === 202, 'an investigation to be accepted', 60_000, 1000);
  const done = await ended(started.data.id);
  assert(done.status === 'COMPLETED', `expected COMPLETED, got ${done.status}: ${done.error}`);
  assert(done.report?.summary?.length > 20, 'the completed investigation has no report');
  assert(done.analysisMode === 'heuristic', `the report was written by "${done.analysisMode}", not the rule-based engine`);
  assert(done.evidence.length > 0 && done.steps.length > 0, 'the completed investigation has no evidence or no steps');
  assert(done.outcome, 'the completed investigation has no outcome');
  return done;
}

function noConclusions(inv) {
  assert(inv.report === null && inv.outcome === null && inv.summary === null, 'a failed investigation carries a report, an outcome or a summary');
  assert(inv.hypotheses.length === 0, 'a failed investigation has hypotheses');
  assert(inv.remediations.length === 0, 'a failed investigation proposed remediation actions');
}

const totals = async () => {
  const [investigations, incidents, remediations, me] = await Promise.all([session.get('/investigations?pageSize=1'), session.get('/incidents?pageSize=1'), session.get('/remediations?pageSize=1'), session.get('/auth/me')]);
  return { investigations: investigations.data.meta?.total, incidents: incidents.data.meta?.total, remediations: remediations.data.meta?.total, organizations: me.data.organizations?.length ?? null };
};

// ── Drills ───────────────────────────────────────────────────────────────────────────────

const drills = {
  baseline: {
    title: 'Baseline: the stack is ready and an investigation ends in a stored report',
    async run() {
      const status = (await session.get('/investigations/ai-status')).data;
      assert(status.reachable === true, 'the AI service is not reachable');
      assert(!status.llm?.available, `a model is active (${status.llm?.provider}); the drills run on the rule-based engine only`);
      const done = await completes('Baseline: what is wrong with this service?');
      return `report stored (${done.evidence.length} evidence items, outcome ${done.outcome}), engine: rule-based`;
    },
  },

  'worker-killed': {
    title: 'Worker killed (SIGKILL) in the middle of an investigation',
    async run() {
      // The AI service is frozen so that the run is reliably in flight when the worker dies.
      dc('pause', 'ai');
      let id;
      try {
        id = (await start('Drill: the worker is killed mid-run')).data.id;
        await running(id);
        dc('kill', '-s', 'SIGKILL', 'worker');
      } finally {
        dc('unpause', 'ai');
      }
      assert((await read(id)).status === 'RUNNING', 'the investigation should still read RUNNING right after the kill');
      const began = Date.now();
      dc('up', '-d', '--no-deps', 'worker');
      const failed = await ended(id, 180_000);
      const seconds = Math.round((Date.now() - began) / 1000);
      assert(failed.status === 'FAILED' && failed.error.includes(INTERRUPTED), `expected an interrupted failure, got ${failed.status}: ${failed.error}`);
      noConclusions(failed);
      assert(failed.steps.at(-1)?.title === 'Investigation interrupted', 'the last step does not say the investigation was interrupted');
      // Not started a second time, and not completed behind our back.
      await pause(5000);
      assert((await read(id)).status === 'FAILED', 'the interrupted investigation changed state afterwards');
      await waitHealthy('worker');
      const next = await completes('Drill: after the worker was replaced');
      return `recorded as interrupted ${seconds}s after the new worker started, no report, not re-run; next investigation completed (${next.evidence.length} evidence items)`;
    },
  },

  'worker-stopped': {
    title: 'Worker stopped politely (SIGTERM) in the middle of an investigation',
    async run() {
      dc('pause', 'ai');
      let id;
      try {
        id = (await start('Drill: the worker is stopped mid-run')).data.id;
        await running(id);
        const began = Date.now();
        dc('stop', 'worker'); // returns when the process has exited
        const seconds = Math.round((Date.now() - began) / 1000);
        // No new worker yet: the record must already be true when the process is gone.
        const failed = await read(id);
        assert(failed.status === 'FAILED' && String(failed.error).includes(INTERRUPTED), `expected an interrupted failure at exit, got ${failed.status}: ${JSON.stringify(failed.error)}`);
        noConclusions(failed);
        const exit = spawnSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', dc('ps', '-aq', 'worker').split('\n')[0]], { encoding: 'utf8' }).stdout.trim();
        assert(exit === '0', `the worker exited with code ${exit}, not 0 (was it killed after the grace period?)`);
        this.note = `worker exited cleanly after ${seconds}s with the run recorded as interrupted`;
      } finally {
        dc('unpause', 'ai');
        dc('up', '-d', '--no-deps', 'worker');
      }
      await waitHealthy('worker');
      await completes('Drill: after the worker was restarted');
      return `${this.note}; next investigation completed`;
    },
  },

  'ai-down': {
    title: 'AI service stopped, then started',
    async run() {
      dc('stop', 'ai');
      try {
        const failed = await ended((await start('Drill: the AI service is down')).data.id);
        assert(failed.status === 'FAILED' && failed.error.includes('AI service is not reachable'), `expected "not reachable", got ${failed.status}: ${failed.error}`);
        noConclusions(failed);
        const status = (await session.get('/investigations/ai-status')).data;
        assert(status.reachable === false, 'the application still says the AI service is reachable');
      } finally {
        dc('start', 'ai');
      }
      await waitHealthy('ai');
      await completes('Drill: after the AI service came back');
      return 'failed with "AI service is not reachable", status page said unreachable, no report; completed after restart of the AI service only';
    },
  },

  'redis-down': {
    title: 'Redis stopped, then started (API and worker keep running)',
    async run() {
      const before = { api: containerState('api'), worker: containerState('worker') };
      dc('stop', 'redis');
      try {
        const refused = await start('Drill: Redis is down');
        assert(refused.status === 503 && refused.data.error?.code === 'service_unavailable', `expected 503 service_unavailable, got ${refused.status}`);
        const latest = (await session.get('/investigations?pageSize=1')).data.data[0];
        assert(latest.status === 'FAILED' && /Redis/.test(latest.error ?? ''), `the refused investigation reads ${latest.status}, not FAILED`);
        const probe = await apiReady();
        assert(probe.status === 503 && probe.body.redis === false && probe.body.database === true, `/ready said ${JSON.stringify(probe)}`);
        assert((await session.get('/incidents?pageSize=1')).status === 200, 'reading incidents failed although only Redis is down');
      } finally {
        dc('start', 'redis');
      }
      await waitReady();
      await completes('Drill: after Redis came back');
      assert(containerState('api') === before.api && containerState('worker') === before.worker, 'the API or the worker was restarted; recovery must not need that');
      return 'request refused with 503 and recorded as FAILED, /ready reported redis=false; after Redis returned the same API and worker processes completed an investigation';
    },
  },

  'postgres-down': {
    title: 'PostgreSQL stopped, then started (API and worker keep running)',
    async run() {
      const before = { api: containerState('api'), worker: containerState('worker'), totals: await totals() };
      dc('stop', 'postgres');
      try {
        const probe = await until(apiReady, (r) => r.status === 503, '/ready to report the outage', 30_000);
        assert(probe.body.database === false, `/ready said ${JSON.stringify(probe.body)}`);
        const refused = await session.get('/incidents?pageSize=1');
        assert(refused.status === 503 && refused.data.error?.code === 'service_unavailable', `expected 503 service_unavailable, got ${refused.status}`);
        assert(!/postgres|5432|prisma|ECONN/i.test(JSON.stringify(refused.data)), 'the error names the database host, port or driver');
      } finally {
        dc('start', 'postgres');
      }
      await waitReady();
      const after = await until(totals, (t) => Number.isInteger(t.investigations) && Number.isInteger(t.incidents), 'data to be readable again', 60_000);
      assert(JSON.stringify(after) === JSON.stringify(before.totals), `data changed across the outage: ${JSON.stringify(before.totals)} -> ${JSON.stringify(after)}`);
      await completes('Drill: after PostgreSQL came back');
      assert(containerState('api') === before.api && containerState('worker') === before.worker, 'the API or the worker was restarted; recovery must not need that');
      return `503 without detail during the outage; same session and same data afterwards (${after.investigations} investigations, ${after.incidents} incidents); investigation completed without restarting API or worker`;
    },
  },

  'queued-job-survives-redis-kill': {
    title: 'Redis killed (SIGKILL) while an accepted investigation is waiting for a worker',
    async run() {
      dc('stop', 'worker');
      let id;
      try {
        const started = await start('Drill: a job is waiting when Redis is killed');
        assert(started.status === 202, `the investigation was not accepted (${started.status})`);
        id = started.data.id;
        assert((await read(id)).status === 'QUEUED', 'the investigation should be waiting in the queue');
        await pause(2000); // Redis writes its append-only file to disk once a second
        dc('kill', '-s', 'SIGKILL', 'redis');
        dc('up', '-d', '--no-deps', 'redis');
        await waitReady();
        assert((await read(id)).status === 'QUEUED', 'the investigation changed state although no worker is running');
      } finally {
        dc('up', '-d', '--no-deps', 'worker');
      }
      // Accepted work is done: the job was still in the queue after the kill.
      const done = await ended(id, 120_000);
      assert(done.status === 'COMPLETED' && done.report?.summary && done.evidence.length > 0, `the queued investigation ended ${done.status}: ${done.error}`);
      await waitHealthy('worker');
      return `the job accepted before the kill was still queued afterwards and ran to a stored report (${done.evidence.length} evidence items)`;
    },
  },

  'queue-wiped': {
    title: 'Redis loses all its data while an accepted investigation is waiting',
    async run() {
      dc('stop', 'worker');
      let id;
      try {
        const started = await start('Drill: the queue is wiped while a job is waiting');
        assert(started.status === 202, `the investigation was not accepted (${started.status})`);
        id = started.data.id;
        // Everything Redis holds is gone: the job, and the schedules of the repeating jobs.
        assert(dc('exec', '-T', 'redis', 'redis-cli', 'FLUSHALL') === 'OK', 'could not wipe the isolated Redis');
        assert((await read(id)).status === 'QUEUED', 'the investigation should still read QUEUED');
      } finally {
        dc('up', '-d', '--no-deps', 'worker');
      }
      // Nothing is restarted after this. The worker restores its schedules, the sweep notices an
      // investigation that has waited for minutes and puts its job back, and the job runs.
      const began = Date.now();
      const done = await ended(id, 300_000);
      const seconds = Math.round((Date.now() - began) / 1000);
      assert(done.status === 'COMPLETED' && done.report?.summary && done.evidence.length > 0, `the investigation ended ${done.status}: ${done.error}`);
      await pause(3000);
      const again = await read(id);
      assert(again.status === 'COMPLETED' && again.remediations.length === done.remediations.length, 'the investigation ran or proposed actions a second time');
      return `job and schedules restored by the worker; the investigation ran to a stored report ${seconds}s after the wipe, once`;
    },
  },

  restart: {
    title: 'Whole stack stopped and started again',
    async run() {
      const before = await totals();
      dc('stop');
      const up = compose(['up', '-d', '--wait', '--wait-timeout', '300'], { capture: true });
      assert(up.status === 0, `the stack did not come back healthy: ${up.stderr.trim().split('\n').pop()}`);
      await session.login();
      const after = await totals();
      // The migrate step ran again on the way up: it must not have seeded a second time.
      assert(JSON.stringify(after) === JSON.stringify(before), `data changed across the restart: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      await completes('Drill: after a full restart');
      return `all services healthy again; ${after.organizations} organisation(s), ${after.incidents} incidents, ${after.investigations} investigations as before (no second seeding); investigation completed`;
    },
  },

  'tracing-without-store': {
    title: 'Tracing switched on with no trace store running',
    async run() {
      const on = compose(['up', '-d', '--wait', '--wait-timeout', '300', 'api', 'worker', 'ai'], { capture: true, env: { OTEL_ENABLED: 'true' } });
      assert(on.status === 0, `could not restart with tracing on: ${on.stderr.trim().split('\n').pop()}`);
      try {
        assert(dc('ps', '-q', 'tracing') === '', 'a trace store is running; this drill needs it absent');
        for (const service of ['api', 'worker', 'ai']) assert(dc('exec', '-T', service, 'printenv', 'OTEL_ENABLED') === 'true', `tracing is not switched on in ${service}`);
        await session.login();
        const done = await completes('Drill: tracing is on and the trace store is missing');
        this.note = `investigation completed (${done.evidence.length} evidence items) with tracing on in the API, the worker and the AI service and nothing listening at the trace endpoint`;
      } finally {
        const off = compose(['up', '-d', '--wait', '--wait-timeout', '300', 'api', 'worker', 'ai'], { capture: true });
        assert(off.status === 0, 'could not restore the stack with tracing off');
      }
      await session.login();
      return this.note;
    },
  },

  'logs-clean': {
    title: 'No credential in any service log after all of the above',
    async run() {
      const logs = dc('logs', '--no-color', '--no-log-prefix');
      const forbidden = { ...secrets(), 'demo password': DEMO.password, 'session cookie': [...session.cookies.values()].find((v) => v.length > 40) ?? 'no-session-cookie-found' };
      const found = Object.entries(forbidden).filter(([, value]) => value && logs.includes(value)).map(([name]) => name);
      assert(found.length === 0, `found in the logs: ${found.join(', ')}`);
      assert(!/sk-ant-[A-Za-z0-9_-]{8,}/.test(logs), 'something shaped like an Anthropic key is in the logs');
      assert(!/postgresql:\/\/[^\s"]*:[^\s"@]+@/.test(logs), 'a database URL with a password is in the logs');
      return `${logs.split('\n').length} log lines from all services searched for ${Object.keys(forbidden).length} secrets and two credential shapes: none found`;
    },
  },
};

// ── Runner ───────────────────────────────────────────────────────────────────────────────

const selected = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = selected.length ? selected : Object.keys(drills);
const unknown = names.filter((n) => !drills[n]);
if (unknown.length) {
  console.error(`unknown drill: ${unknown.join(', ')}\navailable: ${Object.keys(drills).join(', ')}`);
  process.exit(2);
}

const running0 = compose(['ps', '--status', 'running', '-q'], { capture: true }).stdout.trim();
if (!running0) {
  console.error('The isolated stack is not running. Start it with: npm run isolated:up');
  process.exit(2);
}

await waitReady();
await session.login();
incidentId = (await session.get('/incidents?pageSize=1')).data.data?.[0]?.id;
if (!incidentId) {
  console.error('The isolated stack has no incident to investigate. Was it seeded?');
  process.exit(2);
}

const results = [];
for (const name of names) {
  const drill = drills[name];
  const began = Date.now();
  log(`\n▶ ${drill.title}`);
  try {
    const detail = await drill.run();
    results.push({ name, ok: true, detail, seconds: Math.round((Date.now() - began) / 1000) });
    log(`  PASS (${results.at(-1).seconds}s): ${detail}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message, seconds: Math.round((Date.now() - began) / 1000) });
    log(`  FAIL (${results.at(-1).seconds}s): ${err.message}`);
    // Leave the stack usable for the next drill whatever state this one died in.
    for (const args of [['unpause', 'ai'], ['up', '-d', '--wait', '--wait-timeout', '300']]) compose(args, { capture: true });
    await waitReady().catch(() => undefined);
    await session.login().catch(() => undefined);
  }
}

log('\nSummary');
for (const r of results) log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(22)} ${String(r.seconds).padStart(4)}s`);
const failed = results.filter((r) => !r.ok);
log(failed.length ? `\n${failed.length} of ${results.length} drills failed.` : `\nAll ${results.length} drills passed.`);
process.exit(failed.length ? 1 : 0);
