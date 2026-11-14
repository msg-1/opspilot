import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { aiService } from '../integrations/aiService';
import { tracesConfig } from '../integrations/traces';
import { audit } from '../lib/audit';
import { decrypt, hmacSha256Hex } from '../lib/crypto';
import { AppError, badRequest, conflict } from '../lib/errors';
import { INGESTION_SOURCES, type IngestionSource, type IntegrationId, noteCheck } from '../lib/integrationState';
import { assertSafeOutboundUrl } from '../lib/netguard';
import { prisma } from '../lib/prisma';
import { authOf, requirePermission, requireUser } from '../middleware/auth';
import { checkGithub } from './github';
import { getSettings } from './organization';
import { requireService } from './services';

/**
 * Integrations as an organisation sees them: what can be connected, what each source provides
 * and needs, and whether it works. "Works" is judged from what happened (data accepted, checks
 * answered), never from the fact that a key or a token was saved.
 *
 * The list is fixed: it is the set of sources this codebase really has. Nothing here returns a
 * credential, a webhook URL or the address of an installation-level service.
 */

export type IntegrationStatus = 'not_configured' | 'configured' | 'connected' | 'delivering' | 'degraded' | 'unavailable';

const DAY = 86_400_000;
const STALE_AFTER_MS = DAY;

const SOURCES: Record<IngestionSource, { name: string; scope: string; endpoint: string; provides: string; example: Record<string, unknown>; continuous: boolean }> = {
  logs: {
    name: 'Logs',
    scope: 'ingest:logs',
    endpoint: 'POST /api/v1/logs',
    provides: 'Application log lines. Investigations group them into error patterns, find new and spiking messages, and cite them as evidence.',
    example: { service: 'checkout-service', logs: [{ level: 'error', message: 'timeout acquiring connection from pool after 3000ms' }] },
    continuous: true,
  },
  metrics: {
    name: 'Metrics',
    scope: 'ingest:metrics',
    endpoint: 'POST /api/v1/monitoring/metrics',
    provides: 'Numeric samples per service (error rate, latency, throughput, saturation). They drive charts, alert rules and service health, and show investigations what moved and what held steady.',
    example: { samples: [{ service: 'checkout-service', metric: 'error_rate', value: 2.4 }] },
    continuous: true,
  },
  deployments: {
    name: 'Deployments',
    scope: 'ingest:deployments',
    endpoint: 'POST /api/v1/deployments',
    provides: 'Every release of a service, sent by your CI/CD pipeline. Investigations compare the start of a failure with what was deployed just before, and name the version to roll back to.',
    example: { service: 'checkout-service', version: 'v2.14.0', environment: 'production', status: 'SUCCEEDED', commitSha: '4f2a9c1' },
    continuous: false,
  },
  events: {
    name: 'Service events',
    scope: 'ingest:events',
    endpoint: 'POST /api/v1/service-events',
    provides: 'Changes that are not deployments: configuration changes, feature flags, scaling, restarts, maintenance. They are candidates for a cause, like deployments.',
    example: { service: 'checkout-service', type: 'config_change', title: 'DB_POOL_MAX lowered from 40 to 12' },
    continuous: false,
  },
};

interface IntegrationView {
  id: string;
  name: string;
  /** push: you send data to OPSILUME · pull: OPSILUME reads from the source · outbound: OPSILUME calls out · engine: part of the installation */
  kind: 'push' | 'pull' | 'outbound' | 'engine';
  /** organization: configured by this organisation · installation: set by whoever operates this installation */
  scope: 'organization' | 'installation';
  provides: string;
  requires: string[];
  status: IntegrationStatus;
  statusDetail: string;
  lastReceivedAt: Date | null;
  lastError: { at: Date; message: string } | null;
  lastCheck: { at: Date; ok: boolean; detail: string } | null;
  facts: { label: string; value: string }[];
  setup: { endpoint: string | null; apiKeyScope: string | null; example: string | null; settingsTab: 'keys' | 'github' | 'organisation' | null; canCheck: boolean };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const ago = (date: Date, now: Date) => {
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 120) return `${minutes} minutes ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};

type State = Awaited<ReturnType<typeof prisma.integrationState.findMany>>[number];

async function ingestionViews(organizationId: string, states: Map<string, State>, now: Date): Promise<{ views: IntegrationView[]; servicesWithTelemetry: number; anyData: boolean; anyKey: boolean; anyKeyUsed: boolean }> {
  const since = new Date(now.getTime() - DAY);
  const [keys, serviceCount, logs24h, logsUnlinked24h, logLatest, logServices, metrics24h, metricLatest, metricServices, deployments, deploymentLatest, events, eventLatest] = await Promise.all([
    prisma.apiKey.findMany({ where: { organizationId, revokedAt: null }, select: { scopes: true, lastUsedAt: true } }),
    prisma.service.count({ where: { organizationId } }),
    prisma.logEntry.count({ where: { organizationId, timestamp: { gte: since } } }),
    prisma.logEntry.count({ where: { organizationId, timestamp: { gte: since }, serviceId: null } }),
    prisma.logEntry.findFirst({ where: { organizationId }, orderBy: { timestamp: 'desc' }, select: { timestamp: true, ingestedAt: true } }),
    // Grouped in the database: a day of logs is far too much to fetch in order to count its services.
    prisma.logEntry.groupBy({ by: ['serviceId'], where: { organizationId, timestamp: { gte: since }, serviceId: { not: null } } }),
    prisma.metricSample.count({ where: { organizationId, timestamp: { gte: since } } }),
    prisma.metricSample.findFirst({ where: { organizationId }, orderBy: { timestamp: 'desc' }, select: { timestamp: true } }),
    prisma.metricSample.groupBy({ by: ['serviceId'], where: { organizationId, timestamp: { gte: since } } }),
    prisma.deployment.count({ where: { organizationId } }),
    prisma.deployment.findFirst({ where: { organizationId }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    prisma.serviceEvent.count({ where: { organizationId } }),
    prisma.serviceEvent.findFirst({ where: { organizationId }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
  ]);
  const stats: Record<IngestionSource, { recent: number; latest: Date | null; total: boolean; services: number | null; unlinked: number }> = {
    logs: { recent: logs24h, latest: logLatest?.timestamp ?? null, total: !!logLatest, services: logServices.length, unlinked: logsUnlinked24h },
    metrics: { recent: metrics24h, latest: metricLatest?.timestamp ?? null, total: !!metricLatest, services: metricServices.length, unlinked: 0 },
    deployments: { recent: deployments, latest: deploymentLatest?.startedAt ?? null, total: deployments > 0, services: null, unlinked: 0 },
    events: { recent: events, latest: eventLatest?.occurredAt ?? null, total: events > 0, services: null, unlinked: 0 },
  };

  const views = INGESTION_SOURCES.map((id): IntegrationView => {
    const source = SOURCES[id];
    const state = states.get(id);
    const stat = stats[id];
    const withScope = keys.filter((k) => k.scopes.includes(source.scope));
    const used = withScope.some((k) => k.lastUsedAt);
    const lastReceivedAt = [state?.lastSuccessAt, stat.latest].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const errorIsNewer = !!state?.lastErrorAt && (!state.lastSuccessAt || state.lastErrorAt > state.lastSuccessAt);
    const unknown = state?.unknownServices ?? [];
    const stale = source.continuous && !!lastReceivedAt && now.getTime() - lastReceivedAt.getTime() > STALE_AFTER_MS;

    let status: IntegrationStatus;
    let statusDetail: string;
    if (!stat.total && !state?.lastSuccessAt) {
      if (errorIsNewer) {
        status = 'degraded';
        statusDetail = 'Requests are arriving and being rejected. Nothing has been accepted yet.';
      } else if (!withScope.length) {
        status = 'not_configured';
        statusDetail = `No API key with the scope ${source.scope} exists, and no data has been received.`;
      } else if (used) {
        status = 'connected';
        statusDetail = 'An API key for this source has been used, but no data has been accepted yet.';
      } else {
        status = 'configured';
        statusDetail = `${plural(withScope.length, 'API key')} can send this data. None has been used yet.`;
      }
    } else if (errorIsNewer) {
      status = 'degraded';
      statusDetail = 'The most recent request was rejected. Data received earlier is still there.';
    } else if (stale) {
      status = 'degraded';
      statusDetail = `No data for ${ago(lastReceivedAt!, now).replace(' ago', '')}. This source normally sends continuously.`;
    } else if (id === 'logs' && stat.recent > 0 && stat.unlinked === stat.recent) {
      status = 'degraded';
      statusDetail = 'Log lines are arriving, but none of them belongs to a registered service, so investigations cannot use them.';
    } else if (id === 'logs' && stat.unlinked > 0) {
      // Judged from the stored lines themselves, so that linking them to a service clears it.
      status = 'degraded';
      statusDetail = `Data is arriving, but ${plural(stat.unlinked, 'line')} from the last 24 hours ${stat.unlinked === 1 ? 'names' : 'name'} a service that is not registered.`;
    } else if (id !== 'logs' && unknown.length) {
      status = 'degraded';
      statusDetail = `Data is arriving, but some of it names services that are not registered: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', …' : ''}.`;
    } else {
      status = 'delivering';
      statusDetail = source.continuous ? `Receiving data: ${plural(stat.recent, id === 'logs' ? 'log line' : 'sample')} in the last 24 hours.` : `Receiving data: ${plural(stat.recent, id === 'deployments' ? 'deployment' : 'event')} recorded.`;
    }

    const facts: IntegrationView['facts'] = [{ label: 'API keys with this scope', value: String(withScope.length) }];
    if (source.continuous) {
      facts.push({ label: 'Received in the last 24 hours', value: stat.recent.toLocaleString('en-GB') });
      facts.push({ label: 'Services sending', value: `${stat.services ?? 0} of ${serviceCount}` });
      if (id === 'logs' && stat.unlinked) facts.push({ label: 'Lines without a registered service (24 hours)', value: stat.unlinked.toLocaleString('en-GB') });
    } else {
      facts.push({ label: 'Recorded in total', value: stat.recent.toLocaleString('en-GB') });
    }
    return {
      id,
      name: source.name,
      kind: 'push',
      scope: 'organization',
      provides: source.provides,
      requires: [`An API key with the scope ${source.scope} (Settings → API keys). Only admins and owners can create one.`, 'Each service named in the data must be registered under Services, by its slug or id.'],
      status,
      statusDetail,
      lastReceivedAt,
      lastError: errorIsNewer || (state?.lastErrorAt && now.getTime() - state.lastErrorAt.getTime() < DAY) ? { at: state!.lastErrorAt!, message: state!.lastError ?? 'A request was rejected.' } : null,
      lastCheck: null,
      facts,
      setup: { endpoint: source.endpoint, apiKeyScope: source.scope, example: JSON.stringify(source.example), settingsTab: 'keys', canCheck: false },
    };
  });
  const telemetryServices = new Set([...logServices.map((s) => s.serviceId), ...metricServices.map((s) => s.serviceId)]);
  const ingestScopes: string[] = INGESTION_SOURCES.map((s) => SOURCES[s].scope);
  const ingestKeys = keys.filter((k) => k.scopes.some((s) => ingestScopes.includes(s)));
  return { views, servicesWithTelemetry: telemetryServices.size, anyData: Object.values(stats).some((s) => s.total), anyKey: ingestKeys.length > 0, anyKeyUsed: ingestKeys.some((k) => k.lastUsedAt) };
}

async function githubView(organizationId: string, state: State | undefined): Promise<IntegrationView> {
  const [integration, repos, linked, commits, pulls] = await Promise.all([
    prisma.githubIntegration.findUnique({ where: { organizationId } }),
    prisma.repository.findMany({ where: { organizationId }, select: { isMock: true, lastSyncedAt: true } }),
    prisma.repository.count({ where: { organizationId, isMock: false, serviceId: { not: null } } }),
    prisma.commit.count({ where: { repository: { organizationId, isMock: false } } }),
    prisma.pullRequest.count({ where: { repository: { organizationId, isMock: false } } }),
  ]);
  const real = repos.filter((r) => !r.isMock);
  const sample = repos.length - real.length;
  const hasToken = !!integration?.tokenEncrypted || !!env.GITHUB_TOKEN;
  const lastSynced = real.map((r) => r.lastSyncedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const syncFailed = integration?.lastSyncStatus === 'error';

  let status: IntegrationStatus;
  let statusDetail: string;
  if (state?.lastCheckOk === false) {
    status = 'unavailable';
    statusDetail = 'The last connection check failed.';
  } else if (!hasToken && !real.length) {
    status = 'not_configured';
    statusDetail = sample ? 'Only sample repositories are connected. No token is set and no real repository is connected.' : 'No token is set and no repository is connected.';
  } else if (!real.length) {
    status = state?.lastCheckOk || integration?.accountLogin ? 'connected' : 'configured';
    statusDetail = `${integration?.accountLogin ? `The token was accepted by GitHub (account ${integration.accountLogin}).` : 'A token is set.'} No repository is connected yet, so no commits or pull requests are read.`;
  } else if (syncFailed) {
    status = 'degraded';
    statusDetail = 'The last synchronisation failed for at least one repository.';
  } else if (!lastSynced) {
    status = 'connected';
    statusDetail = `${plural(real.length, 'repository', 'repositories')} connected. Nothing has been synchronised yet.`;
  } else if (commits + pulls === 0) {
    status = 'connected';
    statusDetail = 'Synchronisation works, but the connected repositories returned no commits or pull requests for the last 30 days.';
  } else if (!linked) {
    status = 'degraded';
    statusDetail = 'Commits and pull requests are being read, but no repository is linked to a service, so investigations cannot relate a change to what it affects.';
  } else {
    status = 'delivering';
    statusDetail = `Reading ${plural(real.length, 'repository', 'repositories')}: ${plural(commits, 'commit')} and ${plural(pulls, 'pull request')} stored.`;
  }
  return {
    id: 'github',
    name: 'GitHub',
    kind: 'pull',
    scope: 'organization',
    provides: 'Commits and pull requests of the repositories behind your services. Investigations link a deployment to the change it shipped and to the files it touched.',
    requires: [
      'A personal access token with read access to the repositories (fine-grained: Contents and Pull requests, read-only). Without one, only public repositories can be read, at 60 requests an hour.',
      'Each repository connected under Code changes and linked to the service it builds.',
      'Optional: a webhook with a shared secret, so that pushes and pull requests arrive without waiting for a synchronisation.',
    ],
    status,
    statusDetail,
    lastReceivedAt: lastSynced,
    lastError: syncFailed && integration?.lastSyncAt ? { at: integration.lastSyncAt, message: integration.lastSyncError ?? 'Synchronisation failed.' } : null,
    lastCheck: state?.lastCheckedAt ? { at: state.lastCheckedAt, ok: !!state.lastCheckOk, detail: state.lastCheckDetail ?? '' } : null,
    facts: [
      { label: 'Access', value: hasToken ? `Token${integration?.accountLogin ? ` (${integration.accountLogin})` : integration?.tokenEncrypted ? '' : ' (set for the installation)'}` : 'Unauthenticated (public repositories only)' },
      { label: 'Repositories connected', value: sample ? `${real.length} (and ${sample} with sample data)` : String(real.length) },
      { label: 'Linked to a service', value: `${linked} of ${real.length}` },
      { label: 'Webhook secret', value: integration?.webhookSecretEncrypted || env.GITHUB_WEBHOOK_SECRET ? 'Set' : 'Not set' },
    ],
    setup: { endpoint: null, apiKeyScope: null, example: null, settingsTab: 'github', canCheck: true },
  };
}

async function webhookView(organizationId: string, state: State | undefined): Promise<IntegrationView> {
  const settings = await getSettings(organizationId);
  const configured = !!settings.remediationWebhookUrl;
  // A check made before the address was last changed says nothing about the address there is now.
  const check = state?.lastCheckedAt && state.lastCheckedAt >= settings.updatedAt ? state : undefined;
  let status: IntegrationStatus = 'not_configured';
  let statusDetail = 'No webhook is set. Approved actions are carried out by a person, who then confirms it. That is a complete way of working, not a fault.';
  if (configured && !check) {
    status = 'configured';
    statusDetail = 'An address is saved. It has not been checked since it was last changed.';
  } else if (configured && check?.lastCheckOk) {
    status = 'connected';
    statusDetail = 'The receiver answered the last test request.';
  } else if (configured) {
    status = 'unavailable';
    statusDetail = 'The receiver did not accept the last test request. An approved action sent now would probably fail or end with an unknown outcome.';
  }
  return {
    id: 'remediation_webhook',
    name: 'Remediation webhook',
    kind: 'outbound',
    scope: 'organization',
    provides: 'A way to carry out approved actions. OPSILUME never changes a system itself: after the required approvals it sends the action, signed, to an endpoint you run (a pipeline, a runbook automation), which performs it.',
    requires: [
      'An HTTPS endpoint reachable from this installation, at a public address. Private, loopback and link-local addresses are refused.',
      'A shared secret, so the receiver can verify the signature (header X-OpsPilot-Signature, HMAC-SHA256 of the body).',
      'The receiver should honour the Idempotency-Key header: every attempt at one action carries the same key.',
    ],
    status,
    statusDetail,
    lastReceivedAt: null,
    lastError: null,
    lastCheck: check?.lastCheckedAt ? { at: check.lastCheckedAt, ok: !!check.lastCheckOk, detail: check.lastCheckDetail ?? '' } : null,
    facts: [
      { label: 'Execution', value: configured ? 'Sent to the webhook' : 'Manual, confirmed by a person' },
      { label: 'Signing secret', value: settings.remediationWebhookSecretEncrypted ? 'Set' : configured ? 'Not set: requests are unsigned' : 'Not set' },
    ],
    setup: { endpoint: null, apiKeyScope: null, example: null, settingsTab: 'organisation', canCheck: configured },
  };
}

// Installation-level services are probed at most this often, however many people have the page open.
const PROBE_TTL_MS = 15_000;
let probeCache: { at: number; traces: boolean | null; ai: Awaited<ReturnType<typeof aiService.status>> | null } | undefined;

async function probes() {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache;
  const [traces, ai] = await Promise.all([
    tracesConfig.url ? fetch(`${tracesConfig.url.replace(/\/$/, '')}/api/services`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false) : Promise.resolve(null),
    aiService.status().catch(() => null),
  ]);
  probeCache = { at: Date.now(), traces, ai };
  return probeCache;
}
/** For tests: forget the cached probe results. */
export const resetIntegrationProbes = () => (probeCache = undefined);

async function installationViews(): Promise<IntegrationView[]> {
  const { traces, ai } = await probes();
  const none = { lastReceivedAt: null, lastError: null, lastCheck: null, setup: { endpoint: null, apiKeyScope: null, example: null, settingsTab: null, canCheck: false } } as const;
  const model = ai?.llm.available ? `${ai.llm.provider}${ai.llm.model ? ` ${ai.llm.model}` : ''}` : null;
  return [
    {
      id: 'traces',
      name: 'Distributed traces',
      kind: 'pull',
      scope: 'installation',
      provides: 'Request traces of your services, read at investigation time: where time was lost and which call failed. Without it, every report lists traces as not examined.',
      requires: ['A Jaeger-compatible trace query API reachable from this installation (TRACES_URL). It is set by whoever operates the installation, for all organisations.', 'Service names in the trace store must match the service slugs registered here.'],
      status: traces === null ? 'not_configured' : traces ? 'connected' : 'unavailable',
      statusDetail: traces === null ? 'No trace store is connected to this installation.' : traces ? 'The trace store answers. Whether it holds traces for your services is known only when an investigation asks for them.' : 'A trace store is configured but does not answer.',
      facts: [],
      ...none,
    },
    {
      id: 'analysis_engine',
      name: 'Analysis engine',
      kind: 'engine',
      scope: 'installation',
      provides: 'What writes an investigation report. The rule-based engine needs no model and costs nothing; a language model, when the installation has one, reasons over the same evidence and is checked by the same guardrails.',
      requires: ['Nothing for the rule-based engine.', 'For a model: a provider key set by whoever operates the installation. It is never entered or shown here.'],
      status: !ai ? 'unavailable' : 'connected',
      statusDetail: !ai ? 'The analysis service does not answer. Investigations started now will fail and say so.' : model ? `A language model is active: ${model}. Investigations call it and are billed by its provider.` : 'The rule-based engine is active. No model is called and nothing is billed.',
      facts: ai ? [{ label: 'Engine', value: model ?? 'Rule-based (no model)' }] : [],
      ...none,
    },
  ];
}

/** Service names that arrived in log lines and match no registered service, from the last 7 days. */
async function unresolvedFromLogs(organizationId: string, now: Date) {
  const since = new Date(now.getTime() - 7 * DAY);
  return prisma.$queryRaw<{ ref: string; count: bigint; lastSeenAt: Date }[]>(Prisma.sql`
    SELECT "attributes"->>'unresolvedService' AS ref, count(*) AS count, max("timestamp") AS "lastSeenAt"
    FROM "LogEntry"
    WHERE "organizationId" = ${organizationId} AND "serviceId" IS NULL AND "timestamp" >= ${since} AND "attributes" ? 'unresolvedService'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
}

export async function integrationOverview(organizationId: string, now = new Date()) {
  const states = new Map((await prisma.integrationState.findMany({ where: { organizationId } })).map((s) => [s.integration, s]));
  const [ingestion, github, webhook, installation, fromLogs, serviceCount, completedInvestigations] = await Promise.all([
    ingestionViews(organizationId, states, now),
    githubView(organizationId, states.get('github')),
    webhookView(organizationId, states.get('remediation_webhook')),
    installationViews(),
    unresolvedFromLogs(organizationId, now),
    prisma.service.count({ where: { organizationId } }),
    prisma.investigation.count({ where: { organizationId, status: 'COMPLETED' } }),
  ]);
  const integrations = [...ingestion.views, github, webhook, ...installation];

  // Names that arrived without a matching service: from stored log lines (which can be linked
  // afterwards) and from what the other sources last reported (which was dropped or refused).
  const unresolved = new Map<string, { ref: string; sources: string[]; count: number | null; lastSeenAt: Date | null; linkable: boolean }>();
  for (const row of fromLogs) unresolved.set(row.ref, { ref: row.ref, sources: ['logs'], count: Number(row.count), lastSeenAt: row.lastSeenAt, linkable: true });
  for (const id of INGESTION_SOURCES) {
    const state = states.get(id);
    // What the source's most recent request reported. A later request without unknown names clears it.
    if (id === 'logs' || !state?.unknownServices.length) continue;
    for (const ref of state.unknownServices) {
      const entry = unresolved.get(ref) ?? { ref, sources: [], count: null, lastSeenAt: state.lastErrorAt ?? state.lastSuccessAt, linkable: false };
      if (!entry.sources.includes(id)) entry.sources.push(id);
      unresolved.set(ref, entry);
    }
  }
  const registered = new Set((await prisma.service.findMany({ where: { organizationId, slug: { in: [...unresolved.keys()] } }, select: { slug: true } })).map((s) => s.slug));
  // A name that has since been registered is only still a problem for the lines stored before that.
  const unresolvedServices = [...unresolved.values()].filter((u) => u.linkable || !registered.has(u.ref)).map((u) => ({ ...u, registered: registered.has(u.ref) }));

  const githubReady = ['connected', 'delivering', 'degraded'].includes(github.status);
  const steps = [
    { id: 'services', title: 'Register your services', done: serviceCount > 0, detail: serviceCount ? `${plural(serviceCount, 'service')} registered.` : 'Incoming data is matched to services by slug. Register at least the services you want to investigate.', href: '/services' },
    { id: 'source', title: 'Set up a data source', done: ingestion.anyKey || githubReady || ingestion.anyData, detail: ingestion.anyKey ? 'An API key for sending data exists.' : ingestion.anyData ? 'Data has been received.' : 'Create an API key with the scopes for the data you will send (logs and metrics matter most).', href: '/settings?tab=keys' },
    { id: 'connect', title: 'Send a first request', done: ingestion.anyKeyUsed || ingestion.anyData, detail: ingestion.anyKeyUsed || ingestion.anyData ? 'OPSILUME has received an authenticated request.' : 'Use the example under a source below. The status changes as soon as a request arrives.', href: '/integrations' },
    { id: 'data', title: 'Confirm that data is arriving', done: ingestion.views.some((v) => (v.id === 'logs' || v.id === 'metrics') && (v.status === 'delivering' || (v.status === 'degraded' && v.lastReceivedAt && now.getTime() - v.lastReceivedAt.getTime() < STALE_AFTER_MS))), detail: 'Logs or metrics accepted within the last 24 hours.', href: '/integrations' },
    { id: 'associate', title: 'Check that the data belongs to your services', done: ingestion.servicesWithTelemetry > 0 && !unresolvedServices.length, detail: unresolvedServices.length ? `${plural(unresolvedServices.length, 'service name')} in the data ${unresolvedServices.length === 1 ? 'matches' : 'match'} no registered service.` : ingestion.servicesWithTelemetry ? `${plural(ingestion.servicesWithTelemetry, 'service')} received logs or metrics in the last 24 hours.` : 'No registered service has received logs or metrics yet.', href: '/integrations' },
    { id: 'investigate', title: 'Run a first investigation', done: completedInvestigations > 0, detail: completedInvestigations ? `${plural(completedInvestigations, 'investigation')} completed.` : 'Ask a question about a service that is sending data, or declare an incident and investigate it.', href: '/investigations' },
  ];
  return { generatedAt: now, integrations, unresolvedServices, onboarding: { complete: steps.every((s) => s.done), steps } };
}

// ───────────────────────── Routes ─────────────────────────

export const integrationsRouter = Router();

integrationsRouter.get('/', requirePermission('read'), async (req, res) => {
  res.json(await integrationOverview(authOf(req).organizationId));
});

// A check reaches out to another system. One at a time per organisation and source, and not in quick succession.
const CHECK_COOLDOWN_MS = 5000;
const lastCheck = new Map<string, number>();
function claimCheck(organizationId: string, integration: IntegrationId) {
  const key = `${organizationId}:${integration}`;
  const now = Date.now();
  if (now - (lastCheck.get(key) ?? 0) < CHECK_COOLDOWN_MS) throw new AppError(429, 'rate_limited', 'This was checked a moment ago. Wait a few seconds and try again.');
  lastCheck.set(key, now);
}
/** For tests: allow the next check at once. */
export const resetCheckCooldown = () => lastCheck.clear();

integrationsRouter.post('/github/check', requirePermission('integration:manage'), requireUser, async (req, res) => {
  const { organizationId } = authOf(req);
  claimCheck(organizationId, 'github');
  const result = await checkGithub(organizationId);
  await noteCheck(organizationId, 'github', result.ok, result.detail);
  await audit(req, 'integration.check', 'integration', 'github', { ok: result.ok });
  res.json({ ok: result.ok, detail: result.detail });
});

/**
 * Sends one signed request with event "ping" to the organisation's remediation webhook, to find
 * out whether it is reachable and answers. It carries no action. The answer's body is not read
 * and nothing about the address is echoed back.
 */
integrationsRouter.post('/remediation-webhook/check', requirePermission('settings:manage'), requireUser, async (req, res) => {
  const { organizationId } = authOf(req);
  const settings = await getSettings(organizationId);
  if (!settings.remediationWebhookUrl) throw conflict('No remediation webhook is set for this organisation.');
  claimCheck(organizationId, 'remediation_webhook');
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } });
  let ok = false;
  let detail: string;
  try {
    // Checked again now: the host may resolve differently than when the address was saved.
    const target = await assertSafeOutboundUrl(settings.remediationWebhookUrl);
    const body = JSON.stringify({ event: 'ping', organization: org.slug, sentAt: new Date().toISOString() });
    const secret = settings.remediationWebhookSecretEncrypted ? decrypt(settings.remediationWebhookSecretEncrypted) : null;
    const response = await fetch(target, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'opspilot', 'x-opspilot-event': 'ping', ...(secret ? { 'x-opspilot-signature': `sha256=${hmacSha256Hex(secret, body)}` } : {}) },
      body,
      signal: AbortSignal.timeout(Math.min(env.REMEDIATION_WEBHOOK_TIMEOUT_MS, 10_000)),
    });
    await response.body?.cancel().catch(() => undefined);
    ok = response.ok;
    detail = response.ok
      ? `The receiver answered the test request (HTTP ${response.status}).${secret ? '' : ' No signing secret is set, so the request was unsigned.'}`
      : response.status >= 300 && response.status < 400
        ? `The receiver answered with a redirect (HTTP ${response.status}). Redirects are not followed; set the final address.`
        : `The receiver refused the test request (HTTP ${response.status}).`;
  } catch (err) {
    const error = err as Error;
    detail =
      err instanceof AppError
        ? `The address was refused: ${error.message}`
        : error.name === 'TimeoutError' || error.name === 'AbortError'
          ? 'The receiver did not answer within 10 seconds.'
          : 'The connection to the receiver failed. Check the address, the certificate and that it is reachable from this installation.';
  }
  await noteCheck(organizationId, 'remediation_webhook', ok, detail);
  await audit(req, 'integration.check', 'integration', 'remediation_webhook', { ok });
  res.json({ ok, detail });
});

/**
 * Log lines that named a service OPSILUME did not know are stored without one. Once the service
 * exists, this gives those lines to it, so that what was already sent is not lost.
 */
integrationsRouter.post('/unresolved-services/link', requirePermission('service:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z.object({ ref: z.string().trim().min(1).max(80), service: z.string().trim().min(1).max(80) }).parse(req.body);
  const service = await requireService(organizationId, body.service);
  const updated = await prisma.logEntry.updateMany({ where: { organizationId, serviceId: null, attributes: { path: ['unresolvedService'], equals: body.ref } }, data: { serviceId: service.id } });
  if (!updated.count) throw badRequest(`No stored log line names the service "${body.ref}".`);
  await audit(req, 'integration.link_service', 'service', service.id, { ref: body.ref, logLines: updated.count });
  res.json({ linked: updated.count, service: { id: service.id, name: service.name, slug: service.slug } });
});
