// OpenTelemetry: automatic spans for HTTP, Express, PostgreSQL and Redis, exported over OTLP.
// Loaded with --require before the service so the libraries are patched before they are used.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    serviceName: process.env.SERVICE_NAME,
    traceExporter: new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Health checks, metric scrapes and log shipping are not user traffic.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => ['/health', '/metrics'].includes(req.url) || req.url.startsWith('/admin'),
          ignoreOutgoingRequestHook: (req) => String(req.path || '').startsWith('/api/v1/'),
        },
      }),
    ],
  });
  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
}
