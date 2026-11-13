/**
 * OpenTelemetry bootstrap. Must be imported before anything else so the auto-instrumentations
 * can patch http/express/ioredis/fetch. Enabled with OTEL_ENABLED=true; traces are exported
 * over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (an OpenTelemetry Collector, Jaeger or Tempo).
 *
 * Locally: `npm run tracing:up`, then `npm run trace -- <investigation id>`. See
 * docs/tracing.md for what a trace contains and what is kept out of it.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { scrubbingExporter } from './lib/tracing';

const enabled = process.env.OTEL_ENABLED === 'true' || process.env.OTEL_ENABLED === '1';
const NOISE = new Set(['/health', '/ready', '/metrics', '/api/v1/system/health']);

if (enabled) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  // The API and the worker are the same image with different entry points.
  const isWorker = /worker\.[cm]?[jt]s$/.test(process.argv[1] ?? '');
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? (isWorker ? 'opspilot-worker' : 'opspilot-api'),
    // Every span passes the scrubber on its way out: no credentials, nothing identifying a person.
    traceExporter: scrubbingExporter(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    // No host or process detection: a machine name and an OS user name identify a person when
    // the services run on someone's laptop.
    autoDetectResources: false,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // One span per request handler is enough; a span for every middleware is noise.
        '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware', 'router'] as never },
        '@opentelemetry/instrumentation-router': { enabled: false },
        // Probes and scrapes would bury the traces worth reading.
        '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: (req) => NOISE.has((req.url ?? '').split('?')[0] ?? '') },
        // Command name only: arguments hold job payloads and cached values.
        '@opentelemetry/instrumentation-ioredis': { dbStatementSerializer: (command) => command },
      }),
    ],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
