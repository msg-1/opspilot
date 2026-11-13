import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  // Base URL at which the AI service can reach this API (tool calls)
  API_URL: z.string().optional(),
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  INTERNAL_SERVICE_TOKEN: z.string().min(32, 'INTERNAL_SERVICE_TOKEN must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters'),
  COOKIE_SECURE: bool,
  // Express "trust proxy" setting: false | true | hop count | loopback | uniquelocal | CIDR list.
  // Only set it when a reverse proxy you control sits in front of the API.
  TRUST_PROXY: z.string().default('false'),
  // Port for the worker's /health and /metrics endpoint
  WORKER_PORT: z.coerce.number().int().default(9464),
  // Allow remediation webhooks to target private or loopback addresses (local development only)
  REMEDIATION_WEBHOOK_ALLOW_PRIVATE: bool,
  // How long to wait for the remediation webhook before the outcome is recorded as unknown
  REMEDIATION_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
  // Base URL of a Jaeger-compatible trace query API (e.g. http://localhost:16686). Empty: no trace store
  TRACES_URL: z.string().optional().default(''),
  GITHUB_TOKEN: z.string().optional().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),
  LOG_LEVEL: z.string().default('info'),
  OTEL_ENABLED: bool,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
  // Per-organisation investigation limits. They bound model spend; 0 disables a limit.
  INVESTIGATION_MAX_CONCURRENT: z.coerce.number().int().min(0).default(3),
  INVESTIGATION_DAILY_LIMIT: z.coerce.number().int().min(0).default(50),
  AI_DAILY_COST_LIMIT_USD: z.coerce.number().min(0).default(5),
  // Run queue jobs in-process instead of through Redis (used by the test suite)
  QUEUE_INLINE: bool,
  // Redis key prefix for BullMQ. Processes that share a Redis but must not share queues use different prefixes.
  QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9:_-]+$/).default('bull'),
  // Base delay for exponential retry backoff of failed jobs
  QUEUE_BACKOFF_MS: z.coerce.number().int().min(1).default(5000),
  // How long a worker's claim on a job lasts without renewal, and how often claims are checked.
  // A job whose worker died is handed to another worker after roughly their sum.
  QUEUE_LOCK_MS: z.coerce.number().int().min(100).default(30_000),
  QUEUE_STALLED_INTERVAL_MS: z.coerce.number().int().min(100).default(30_000),
  // The longest one investigation may take, from the request to the AI service to its last event
  INVESTIGATION_TIMEOUT_MS: z.coerce.number().int().min(100).default(15 * 60_000),
  // On shutdown the worker lets running jobs finish for this long, then stops them and records them as interrupted
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail fast: a misconfigured process must not start.
  throw new Error(`Invalid environment configuration:\n${issues}\nSee .env.example.`);
}

export const env = parsed.data;

// The placeholders shipped in .env.example are public knowledge. They are tolerated for
// local development only; anything else must use real secrets.
if (env.NODE_ENV === 'production') {
  const placeholders = [
    ['JWT_SECRET', env.JWT_SECRET.startsWith('dev-only-change-me')],
    ['INTERNAL_SERVICE_TOKEN', env.INTERNAL_SERVICE_TOKEN.startsWith('dev-only-change-me')],
    ['ENCRYPTION_KEY', /^0+$/.test(env.ENCRYPTION_KEY)],
  ].filter(([, bad]) => bad);
  if (placeholders.length) {
    throw new Error(`Refusing to start in production with placeholder secrets: ${placeholders.map(([name]) => name).join(', ')}. Generate real values (openssl rand -hex 32).`);
  }
}
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
