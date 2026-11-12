import pino from 'pino';
import { env, isProd, isTest } from '../config/env';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'opspilot-api' },
  // Never let credentials reach the logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-internal-token"]',
      '*.password',
      '*.token',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
  transport: !isProd && !isTest ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } } : undefined,
});
