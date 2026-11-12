import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env, isTest } from './config/env';
import { logger } from './lib/logger';
import { httpMetrics, registry } from './lib/metrics';
import { authenticate, authenticateTool } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { analyticsRouter, dashboardRouter, postmortemRouter } from './modules/analytics';
import { authRouter } from './modules/auth';
import { githubRouter, githubWebhookRouter } from './modules/github';
import { incidentsRouter } from './modules/incidents';
import { investigationsRouter } from './modules/investigations';
import { knowledgeRouter } from './modules/knowledge';
import { logsRouter } from './modules/logs';
import { monitoringRouter } from './modules/monitoring';
import { apiKeysRouter, auditRouter, membersRouter, notificationsRouter, settingsRouter, teamsRouter } from './modules/organization';
import { remediationRouter } from './modules/remediation';
import { deploymentsRouter, serviceEventsRouter, servicesRouter } from './modules/services';
import { healthRouter, systemRouter } from './modules/system';
import { toolsRouter } from './modules/tools';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN.split(',').map((o) => o.trim()), credentials: true }));
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '5mb',
      // The raw body is needed to verify GitHub webhook signatures.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' || req.url === '/metrics' },
        // One compact line per request; headers and bodies are never logged.
        serializers: {
          req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      }),
    );
  }
  app.use(httpMetrics);

  app.use(healthRouter);
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  const v1 = express.Router();
  v1.use(
    rateLimit({
      windowMs: 60_000,
      limit: 1200,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => isTest,
      message: { error: { code: 'rate_limited', message: 'Too many requests' } },
    }),
  );

  // Public / self-authenticating routes
  v1.use('/auth', authRouter);
  v1.use('/webhooks/github', githubWebhookRouter);
  // AI agent + MCP tool API (accepts the short-lived tool token as well)
  v1.use('/tools', authenticateTool, toolsRouter);

  // Everything below requires a user session or an API key
  v1.use(authenticate);
  v1.use('/dashboard', dashboardRouter);
  v1.use('/incidents', incidentsRouter);
  v1.use('/incidents', postmortemRouter);
  v1.use('/services', servicesRouter);
  v1.use('/deployments', deploymentsRouter);
  v1.use('/service-events', serviceEventsRouter);
  v1.use('/logs', logsRouter);
  v1.use('/monitoring', monitoringRouter);
  v1.use('/github', githubRouter);
  v1.use('/knowledge', knowledgeRouter);
  v1.use('/investigations', investigationsRouter);
  v1.use('/remediations', remediationRouter);
  v1.use('/analytics', analyticsRouter);
  v1.use('/members', membersRouter);
  v1.use('/teams', teamsRouter);
  v1.use('/settings', settingsRouter);
  v1.use('/api-keys', apiKeysRouter);
  v1.use('/audit-logs', auditRouter);
  v1.use('/notifications', notificationsRouter);
  v1.use('/system', systemRouter);

  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
