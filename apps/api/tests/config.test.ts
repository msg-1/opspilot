import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Loads the environment module in a child process with the given variables. */
function loadEnv(overrides: Record<string, string>) {
  const base = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'a'.repeat(40),
    INTERNAL_SERVICE_TOKEN: 'b'.repeat(40),
    ENCRYPTION_KEY: 'ab'.repeat(32),
  };
  return spawnSync('npx', ['tsx', '-e', "require('./src/config/env')"], { cwd: process.cwd(), env: { ...base, ...overrides }, encoding: 'utf8' });
}

describe('environment validation', () => {
  it('refuses to start in production with the published placeholder secrets', () => {
    const result = loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'dev-only-change-me-jwt-secret-0000000000000000', ENCRYPTION_KEY: '0'.repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('placeholder secrets: JWT_SECRET, ENCRYPTION_KEY');
  });

  it('accepts the placeholders in development and real secrets in production', () => {
    expect(loadEnv({ NODE_ENV: 'development', JWT_SECRET: 'dev-only-change-me-jwt-secret-0000000000000000' }).status).toBe(0);
    expect(loadEnv({ NODE_ENV: 'production' }).status).toBe(0);
  });

  it('names the variable that is malformed', () => {
    const result = loadEnv({ ENCRYPTION_KEY: 'too-short' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENCRYPTION_KEY must be 64 hex characters');
  });
});
