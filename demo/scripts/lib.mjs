// Shared by the demo scripts. No dependencies: Node 22 only.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_FILE = join(ROOT, 'demo', '.state.json');
export const ENV_FILE = join(ROOT, 'demo', '.env.demo');
export const API = process.env.OPSILUME_API_URL ?? 'http://localhost:4000';
export const JAEGER = process.env.DEMO_JAEGER_URL ?? 'http://localhost:16686';
export const SERVICE_URLS = { 'shop-gateway': 'http://localhost:8088', 'shop-orders': 'http://localhost:8089', 'shop-payments': 'http://localhost:8090' };
export const ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN ?? 'local-demo';
export const ACCOUNT = { email: process.env.DEMO_EMAIL ?? 'shop-demo@example.com', password: process.env.DEMO_PASSWORD ?? 'OpsPilot-demo-1', name: 'Shop Demo Owner', organizationName: 'Shop Demo' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const iso = (d = new Date()) => d.toISOString();
export const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

/** docker compose, always with the profiles the demo uses and never with a paid model. */
export function compose(args, { quiet = false, env = {} } = {}) {
  const result = spawnSync('docker', ['compose', '--profile', 'app', '--profile', 'demo', ...args], {
    cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8',
    env: { ...process.env, AI_PROVIDER: 'deterministic', TRACES_URL: 'http://demo-jaeger:16686', ...env },
  });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed${quiet ? `: ${result.stderr}` : ''}`);
  return result.stdout ?? '';
}

export function state() {
  if (!existsSync(STATE_FILE)) throw new Error('demo/.state.json not found. Run `npm run demo:up` (or `npm run demo:setup`) first.');
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

export function ingestKey() {
  if (!existsSync(ENV_FILE)) throw new Error('demo/.env.demo not found. Run `npm run demo:setup` first.');
  const line = readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('OPSPILOT_API_KEY='));
  if (!line) throw new Error('demo/.env.demo has no OPSPILOT_API_KEY');
  return line.slice('OPSPILOT_API_KEY='.length).trim();
}

/** A signed-in session against the OPSILUME API (cookies kept in memory). */
export class Session {
  cookies = new Map();

  async request(method, path, body, { key } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-api-key'] = key;
    else if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${API}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, ok: res.ok, data };
  }

  async must(method, path, body, opts) {
    const res = await this.request(method, path, body, opts);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.data?.error ?? res.data).slice(0, 300)}`);
    return res.data;
  }
  get = (path) => this.must('GET', path);
  post = (path, body = {}) => this.must('POST', path, body);

  /** Signs in, registering the demo organisation on first use. */
  async signIn() {
    const login = await this.request('POST', '/auth/login', { email: ACCOUNT.email, password: ACCOUNT.password });
    if (login.ok) return login.data;
    const registered = await this.request('POST', '/auth/register', ACCOUNT);
    if (!registered.ok) throw new Error(`Could not sign in or register the demo account: ${registered.status} ${JSON.stringify(registered.data?.error ?? registered.data)}`);
    return registered.data;
  }
}

export async function admin(service, path, body) {
  const res = await fetch(`${SERVICE_URLS[service]}/admin${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${service} admin${path} → ${res.status}`);
  return res.json();
}

export async function waitFor(what, check, { timeoutMs = 120_000, everyMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''}`);
    await sleep(everyMs);
  }
}

/**
 * Refuses to continue unless investigations run on the rule-based engine. The demo scripts
 * start investigations, and an investigation on a paid model costs money.
 */
export async function assertNoPaidModel(session) {
  // The AI service may have just been restarted: give it a minute before giving up.
  const status = await waitFor('the AI service', async () => {
    const current = await session.get('/system/status');
    return current.ai?.reachable ? current : null;
  }, { timeoutMs: 90_000 });
  const llm = status.ai?.llm;
  if (llm?.available && !['heuristic', 'mock'].includes(llm.provider)) {
    throw new Error(`A paid model is active (${llm.provider} / ${llm.model}). Start the stack with \`npm run demo:up\`, which sets AI_PROVIDER=deterministic.`);
  }
  return llm;
}

export function dockerRunning(name) {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
}
