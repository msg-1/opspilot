import type { RequestHandler } from 'express';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'opspilot_api_' });

export const httpDuration = new client.Histogram({
  name: 'opspilot_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const logsIngested = new client.Counter({
  name: 'opspilot_logs_ingested_total',
  help: 'Log entries ingested',
  registers: [registry],
});

export const jobsProcessed = new client.Counter({
  name: 'opspilot_jobs_processed_total',
  help: 'Background jobs processed',
  labelNames: ['queue', 'status'] as const,
  registers: [registry],
});

export const jobDuration = new client.Histogram({
  name: 'opspilot_job_duration_seconds',
  help: 'Background job duration',
  labelNames: ['queue'] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60, 180, 600],
  registers: [registry],
});

export const investigationsTotal = new client.Counter({
  name: 'opspilot_investigations_total',
  help: 'AI investigations by final status and provider',
  labelNames: ['status', 'provider'] as const,
  registers: [registry],
});

export const httpMetrics: RequestHandler = (req, res, next) => {
  const stop = httpDuration.startTimer();
  res.on('finish', () => {
    // Use the matched route pattern, not the raw URL, to keep label cardinality bounded.
    const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
    stop({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
};
