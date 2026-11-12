/**
 * OpenTelemetry bootstrap. Must be imported before anything else so the auto-instrumentations
 * can patch http/express/pg/ioredis. Enabled with OTEL_ENABLED=true; traces are exported over
 * OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (e.g. an OpenTelemetry Collector, Jaeger or Tempo).
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

const enabled = process.env.OTEL_ENABLED === 'true' || process.env.OTEL_ENABLED === '1';

if (enabled) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'opspilot-api',
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
