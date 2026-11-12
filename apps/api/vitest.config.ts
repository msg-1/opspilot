import { defineConfig } from 'vitest/config';

// Integration tests run against the real Postgres test database (opspilot_test, created by
// infra/postgres/init.sql). Queue jobs run inline, so no Redis or worker is needed.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://opspilot:opspilot@localhost:5432/opspilot_test?schema=public',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
      INTERNAL_SERVICE_TOKEN: 'test-internal-token-test-internal-token-0000',
      ENCRYPTION_KEY: 'ab'.repeat(32),
      QUEUE_INLINE: 'true',
      BCRYPT_ROUNDS: '4',
      AI_SERVICE_URL: 'http://127.0.0.1:9',
      GITHUB_TOKEN: '',
      GITHUB_WEBHOOK_SECRET: '',
    },
  },
});
