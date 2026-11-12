import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://opspilot:opspilot@localhost:5432/opspilot_test?schema=public';

export default async function setup() {
  if (!/test/.test(new URL(url).pathname)) throw new Error(`Refusing to run tests against a non-test database: ${url}`);
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  // Start every run from an empty database.
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  await prisma.$disconnect();
}
