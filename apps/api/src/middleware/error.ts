import { Prisma } from '@prisma/client';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
};

/** Single place where every error becomes an HTTP response: { error: { code, message, details? } }. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ');
      res.status(409).json({ error: { code: 'conflict', message: `A record with the same ${target ?? 'value'} already exists` } });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'not_found', message: 'Resource not found' } });
      return;
    }
    if (err.code === 'P2003') {
      res.status(400).json({ error: { code: 'bad_request', message: 'Referenced record does not exist' } });
      return;
    }
  }
  const dbDown = err instanceof Prisma.PrismaClientInitializationError || (err instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017'].includes(err.code));
  if (dbDown) {
    logger.error({ code: (err as { code?: string }).code ?? (err as { errorCode?: string }).errorCode }, 'database unavailable');
    res.setHeader('Retry-After', '5');
    res.status(503).json({ error: { code: 'service_unavailable', message: 'The database is temporarily unavailable. Try again in a few seconds.' } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
    return;
  }
  logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on our side' } });
};
