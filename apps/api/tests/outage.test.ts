import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REPORT, aiStub, pause, tcpProxy, until } from './faults';

// PostgreSQL going away and coming back. The application reaches the test database through a
// proxy that can be switched off; the database server itself is never stopped. Jobs run
// in-process here, and the AI service is a scripted stub reached by the real client.
const settings = vi.hoisted(() => {
  const port = (offset: number) => 21_000 + ((process.pid * 7 + offset * 131) % 20_000);
  const real = new URL(process.env.DATABASE_URL!);
  const target = { host: real.hostname, port: Number(real.port) || 5432 };
  real.hostname = '127.0.0.1';
  real.port = String(port(4));
  // Fail in seconds, not in the driver's default half-minute.
  real.searchParams.set('connect_timeout', '2');
  real.searchParams.set('pool_timeout', '3');
  process.env.DATABASE_URL = real.toString();
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${port(5)}`;
  return { target, dbPort: port(4), aiPort: port(5) };
});

import { terminalWriteRetry } from '../src/modules/investigations/persistence';
import { runInvestigation } from '../src/modules/investigations';
import { reapStranded } from '../src/modules/system';
import { api, createOrg, createService, prisma } from './helpers';

const db = tcpProxy(settings.dbPort, settings.target);
const ai = aiStub(settings.aiPort);

type Org = Awaited<ReturnType<typeof createOrg>>;
const read = async (org: Org, id: string) => (await org.owner.get(`/api/v1/investigations/${id}`)).body;
const evidence = { type: 'evidence', evidence: { ref: 'E1', kind: 'log_pattern', title: '12× ERROR in checkout', summary: 'pattern', sourceType: 'log_pattern', sourceId: 'p1' } };

/** A run that gathers one piece of evidence and then waits to be told to send its report. */
function gatedRun() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  ai.state.onRun = async (_req, res, { line }) => {
    line({ type: 'meta', provider: 'heuristic', model: null });
    line(evidence);
    await gate;
    line({ type: 'final', report: EMPTY_REPORT });
    res.end();
  };
  return () => release();
}

beforeAll(async () => {
  await db.up();
  await ai.start();
});
beforeEach(async () => {
  ai.reset();
  terminalWriteRetry.attempts = 6;
  terminalWriteRetry.baseMs = 250;
  await db.up();
});
afterAll(async () => {
  await db.up();
  await prisma.$disconnect();
  await ai.stop();
  await db.down();
});

describe('PostgreSQL outage', () => {
  it('is reported as unavailable, without detail, and everything works again when it is back', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Orders');
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing' }).expect(201)).body;
    expect((await api().get('/ready')).body).toMatchObject({ status: 'ready', database: true });

    await db.down();
    const ready = await api().get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: 'not_ready', database: false });
    // Liveness is a different question: the process is up.
    expect((await api().get('/health')).status).toBe(200);
    for (const attempt of [org.owner.get('/api/v1/incidents'), org.owner.post('/api/v1/incidents').send({ title: 'Written during the outage' }), org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing?' })]) {
      const res = await attempt;
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('service_unavailable');
      // No host, port, query or driver text reaches the caller.
      expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|prisma|database server|ECONN|\d{5}/i);
    }
    expect(ai.state.runs).toHaveLength(0);

    await db.up();
    // No restart and no repair: the same process, the same session, the same data.
    await until(async () => (await api().get('/ready')).status, (s) => s === 200, 'the API to be ready again');
    const incidents = (await org.owner.get('/api/v1/incidents').expect(200)).body.data as { id: string; title: string }[];
    expect(incidents.map((i) => i.title)).toEqual(['Checkout failing']); // the write refused during the outage was not half-applied
    expect((await org.owner.get(`/api/v1/incidents/${incident.id}`).expect(200)).body.title).toBe('Checkout failing');
    const started = await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing?', incidentId: incident.id }).expect(202);
    expect(await read(org, started.body.id)).toMatchObject({ status: 'COMPLETED', report: expect.objectContaining({ summary: EMPTY_REPORT.summary }) });
  });

  it('returns during an investigation: it is recorded as failed for that reason, with no report', async () => {
    const org = await createOrg();
    const release = gatedRun();
    const request = org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing?' }).then((r) => r);
    const row = await until(() => prisma.investigation.findFirst({ where: { organizationId: org.organizationId }, include: { evidence: true } }), (i) => i?.evidence.length === 1, 'the run to be under way');
    await db.down();
    release(); // the report arrives while nothing can be written
    await pause(1200);
    await db.up();
    await request;

    const failed = await until(() => read(org, row!.id), (i) => i.status !== 'RUNNING', 'the failure to be recorded');
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toContain('The database could not be reached while the investigation was running');
    expect(failed.error).not.toMatch(/127\.0\.0\.1|prisma|\d{5}/i);
    expect(failed).toMatchObject({ report: null, outcome: null, hypotheses: [], remediations: [] });
    expect(failed.evidence).toHaveLength(1);
    // It is not reported as completed anywhere.
    expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: 'investigation.complete' } })).toBe(0);
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, type: 'investigation.completed' } })).toBe(0);

    ai.reset();
    const next = await org.owner.post('/api/v1/investigations').send({ question: 'And now?' }).expect(202);
    expect((await read(org, next.body.id)).status).toBe('COMPLETED');
  });

  it('is still away when a worker picks an investigation up: the worker waits for it and runs the investigation', async () => {
    // Found by the drills on CI: the job arrived while the worker's connections were still
    // recovering, failed on its first query, and the investigation stayed QUEUED.
    const org = await createOrg();
    const row = await prisma.investigation.create({ data: { organizationId: org.organizationId, question: 'Why is checkout failing?', status: 'QUEUED' } });
    await db.down();
    const run = runInvestigation(row.id);
    await pause(900);
    await db.up();
    await run;
    expect(await read(org, row.id)).toMatchObject({ status: 'COMPLETED', report: expect.objectContaining({ summary: EMPTY_REPORT.summary }) });
    expect(ai.state.runs).toHaveLength(1);
  });

  it('outlasts the attempts to record the failure: the run stays in progress, never completed, until the sweep ends it', async () => {
    const org = await createOrg();
    terminalWriteRetry.attempts = 2;
    terminalWriteRetry.baseMs = 50;
    const release = gatedRun();
    const request = org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing?' }).then((r) => r);
    const row = await until(() => prisma.investigation.findFirst({ where: { organizationId: org.organizationId }, include: { evidence: true } }), (i) => i?.evidence.length === 1, 'the run to be under way');
    await db.down();
    release();
    expect((await request).status).toBe(503);
    await db.up();
    await until(async () => (await api().get('/ready')).status, (s) => s === 200, 'the API to be ready again');

    // Nothing could be written, so nothing was: it still says RUNNING, which is stale but not false success.
    expect(await read(org, row!.id)).toMatchObject({ status: 'RUNNING', report: null, hypotheses: [], remediations: [] });
    // Too recent for the sweep to judge…
    await reapStranded();
    expect((await read(org, row!.id)).status).toBe('RUNNING');
    // …and ended by it once it is older than any run can be.
    await reapStranded(new Date(Date.now() + 21 * 60_000));
    const swept = await read(org, row!.id);
    expect(swept.status).toBe('FAILED');
    expect(swept.error).toContain('the worker stopped before this investigation finished');
    expect(swept.steps.at(-1)).toMatchObject({ title: 'Investigation interrupted' });
    // Running the sweep again changes nothing.
    await reapStranded(new Date(Date.now() + 21 * 60_000));
    expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: 'investigation.interrupted' } })).toBe(1);
  });
});
