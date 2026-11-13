import { type ChildProcess, spawn } from 'node:child_process';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type Socket, connect, createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';

/**
 * Fault injection for the reliability tests. Nothing here stops or changes a real Redis or
 * PostgreSQL: an outage is produced by a TCP proxy in front of it that stops forwarding, and
 * the AI service is a scripted HTTP server in this process. A worker "crash" is a real worker
 * process, started for the test and killed.
 */

/** A port derived from the process id, so files and runs do not collide. */
export const testPort = (offset: number) => 21_000 + ((process.pid * 7 + offset * 131) % 20_000);

export const hostPort = (url: string, fallbackPort: number) => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || fallbackPort };
};

/** Forwards a local port to a real server, and can be switched off and on like a network cable. */
export function tcpProxy(listenPort: number, target: { host: string; port: number }) {
  const sockets = new Set<Socket>();
  let server: ReturnType<typeof createTcpServer> | undefined;
  const up = () =>
    new Promise<void>((resolve, reject) => {
      if (server) return resolve();
      server = createTcpServer((client) => {
        const upstream = connect(target.port, target.host);
        for (const s of [client, upstream]) {
          sockets.add(s);
          s.on('error', () => undefined);
          s.on('close', () => sockets.delete(s));
        }
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      server.once('error', reject);
      server.listen(listenPort, '127.0.0.1', () => resolve());
    });
  /** Drops every connection and refuses new ones. */
  const down = () =>
    new Promise<void>((resolve) => {
      const closing = server;
      server = undefined;
      for (const s of sockets) s.destroy();
      if (!closing) return resolve();
      closing.close(() => resolve());
    });
  return { up, down, port: listenPort };
}

type RunHandler = (req: IncomingMessage, res: ServerResponse, call: { n: number; body: Record<string, unknown>; line: (event: unknown) => void }) => void | Promise<void>;

/**
 * A stand-in for the AI service that the real client talks to over HTTP. `onRun` scripts what
 * POST /v1/investigations/run does: answer, stall, break off, send rubbish.
 */
export function aiStub(port: number) {
  let server: Server | undefined;
  const state = {
    runs: [] as { investigationId: string; question: string }[],
    /** Runs whose connection was closed from the other side before the stub had finished answering. */
    abandoned: 0,
    onRun: (async (_req, res, { line }) => {
      line({ type: 'final', report: EMPTY_REPORT });
      res.end();
    }) as RunHandler,
  };
  const start = () =>
    new Promise<void>((resolve, reject) => {
      if (server) return resolve();
      server = createServer((req, res) => {
        if (req.method === 'GET' && req.url?.startsWith('/v1/status')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'test', model: 'unit', dimensions: 768 } }));
          return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/investigations/run') {
          res.writeHead(404).end();
          return;
        }
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          state.runs.push({ investigationId: String(body.investigationId), question: String(body.question) });
          res.on('close', () => {
            if (!res.writableEnded) state.abandoned += 1;
          });
          const line = (event: unknown) => {
            if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson' });
            res.write(`${typeof event === 'string' ? event : JSON.stringify(event)}\n`);
          };
          void Promise.resolve(state.onRun(req, res, { n: state.runs.length, body, line })).catch(() => res.destroy());
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      const closing = server;
      server = undefined;
      if (!closing) return resolve();
      closing.closeAllConnections();
      closing.close(() => resolve());
    });
  const reset = () => {
    state.runs = [];
    state.abandoned = 0;
    state.onRun = async (_req, res, { line }) => {
      line({ type: 'final', report: EMPTY_REPORT });
      res.end();
    };
  };
  return { start, stop, reset, state, url: `http://127.0.0.1:${port}` };
}

export const EMPTY_REPORT = { summary: 'Nothing conclusive was found.', confidence: 0.1, analysisMode: 'heuristic', timeline: [], facts: [], assumptions: [], uncertainties: [], hypotheses: [], nextSteps: [], recommendedActions: [] };

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(value)?.slice(0, 600)}`);
    await pause(40);
  }
}

/**
 * Starts the real worker (src/worker.ts) as its own process, so that killing it is a real
 * crash: no finally block runs and nothing in memory survives.
 */
export async function spawnWorker(env: Record<string, string>) {
  const port = Number(env.WORKER_PORT);
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c) => (output += c));
  child.stderr?.on('data', (c) => (output += c));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code, signal) => resolve(signal ? null : code)));
  const probe = async (path: string) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } catch {
      return { status: 0, body: {} as Record<string, unknown> };
    }
  };
  // Listening means the process is up; it says nothing about Redis or the database.
  await until(() => probe('/health'), (r) => r.status === 200 || child.exitCode !== null, 'the worker process to start', 30_000);
  if (child.exitCode !== null) throw new Error(`worker exited at start:\n${output.slice(-2000)}`);
  return {
    probe,
    exited,
    alive: () => child.exitCode === null && child.signalCode === null,
    output: () => output,
    /** A crash: the process is gone without running any of its own shutdown code. */
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
    /** A polite stop, as `docker stop` or a deployment sends it. Resolves with the exit code. */
    terminate: async () => {
      child.kill('SIGTERM');
      return exited;
    },
  };
}
