/**
 * Background terminal host. Runs as its own detached process (the Electron binary in plain
 * Node mode) so the shells it owns outlive the app: quitting, restarting, or installing an
 * update only drops the app's connection, and the next launch reattaches to the same shells.
 *
 * Started by hostLauncher.ts. Keep this entry free of `electron` imports; there is no
 * Electron runtime in this process.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import {
  createLineReader,
  encodeLine,
  type HelloResult,
  type HostMessage,
  type HostRequestEnvelope,
  hostProof,
  type ProveResult,
  PTY_HOST_PROTOCOL_VERSION,
  ptyHostPaths,
} from './protocol';
import { PtySessionManager, type SessionListener } from './sessionManager';

/** Exit code telling the launcher another host already owns the endpoint. */
const EXIT_ENDPOINT_TAKEN = 3;
/** How long a host with no shells and no app connected lingers before exiting. */
const IDLE_EXIT_MS = 15_000;
/** A freshly started host gets longer, so a slow app start can still reach it. */
const STARTUP_IDLE_EXIT_MS = 60_000;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const userDataDir = argValue('--user-data');
const appVersion = argValue('--app-version') ?? 'unknown';
if (!userDataDir) {
  process.exit(2);
}

const paths = ptyHostPaths(userDataDir);
mkdirSync(paths.runtimeDir, { recursive: true });

function log(message: string): void {
  try {
    try {
      if (statSync(paths.logFile).size > 1024 * 1024) unlinkSync(paths.logFile);
    } catch {
      // no log yet
    }
    appendFileSync(paths.logFile, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {
    // logging must never take the host down
  }
}

// The launcher lets go of stdio once the host is ready; a write to a dead pipe must not kill
// the shells with it. Unexpected errors are logged and survived for the same reason: losing
// every running terminal is worse than whatever state one failed call left behind.
process.stdout?.on?.('error', () => undefined);
process.stderr?.on?.('error', () => undefined);
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${String(error)}`));

const token = randomBytes(32).toString('hex');
const clients = new Set<Socket>();
let idleTimer: NodeJS.Timeout | null = null;
let server: Server | null = null;

const manager = new PtySessionManager(
  () => scheduleIdleCheck(IDLE_EXIT_MS),
  (message) => log(`[pty] ${message}`),
);

function scheduleIdleCheck(delay: number): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (clients.size > 0 || manager.size > 0) return;
  idleTimer = setTimeout(() => {
    if (clients.size === 0 && manager.size === 0) shutdown('idle');
  }, delay);
  idleTimer.unref?.();
}

function shutdown(reason: string): void {
  log(`shutting down (${reason})`);
  manager.killAll();
  for (const socket of clients) socket.destroy();
  server?.close();
  // Give the pty kills a beat to reach their children before the process goes.
  setTimeout(() => process.exit(0), 200);
}

function tokensMatch(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function handleConnection(socket: Socket): void {
  let authenticated = false;
  let compatible = false;

  const send = (message: HostMessage): void => {
    if (!socket.destroyed) socket.write(encodeLine(message));
  };
  const reply = (id: number | undefined, result?: unknown): void => {
    if (id !== undefined) send({ kind: 'response', id, ok: true, result });
  };
  const fail = (id: number | undefined, error: string): void => {
    if (id !== undefined) send({ kind: 'response', id, ok: false, error });
  };

  const listener: SessionListener = {
    onData: (sessionId, data) => send({ kind: 'event', event: 'data', sessionId, data }),
    onExit: (sessionId, exitCode) => send({ kind: 'event', event: 'exit', sessionId, exitCode }),
  };

  const handle = async (request: HostRequestEnvelope): Promise<void> => {
    if (request.type === 'prove') {
      // Answered before hello on purpose: the app checks this host holds the token before it
      // sends the token, so a process squatting on the endpoint never learns it.
      if (typeof request.nonce !== 'string' || request.nonce.length < 32) {
        fail(request.id, 'bad nonce');
        socket.destroy();
        return;
      }
      const result: ProveResult = { proof: hostProof(token, request.nonce) };
      reply(request.id, result);
      return;
    }
    if (request.type === 'hello') {
      if (!tokensMatch(request.token)) {
        fail(request.id, 'unauthorized');
        socket.destroy();
        return;
      }
      authenticated = true;
      compatible = request.protocolVersion === PTY_HOST_PROTOCOL_VERSION;
      clients.add(socket);
      scheduleIdleCheck(IDLE_EXIT_MS);
      const result: HelloResult = {
        protocolVersion: PTY_HOST_PROTOCOL_VERSION,
        appVersion,
        pid: process.pid,
        sessionCount: manager.size,
      };
      reply(request.id, result);
      return;
    }
    if (!authenticated) {
      socket.destroy();
      return;
    }
    if (request.type === 'shutdown') {
      reply(request.id);
      if (request.payload.killSessions || manager.size === 0) {
        shutdown('requested');
      }
      return;
    }
    if (!compatible) {
      fail(request.id, 'protocol mismatch');
      return;
    }
    switch (request.type) {
      case 'createOrAttach':
        reply(request.id, await manager.createOrAttach(request.payload, listener));
        return;
      case 'write':
        manager.write(request.payload.sessionId, request.payload.data);
        reply(request.id);
        return;
      case 'resize':
        manager.resize(request.payload.sessionId, request.payload.cols, request.payload.rows);
        reply(request.id);
        return;
      case 'kill':
        manager.kill(request.payload.sessionId);
        reply(request.id);
        return;
      case 'list':
        reply(request.id, manager.list());
        return;
    }
  };

  const read = createLineReader(
    (message) => {
      const request = message as HostRequestEnvelope;
      handle(request).catch((error: unknown) => {
        log(`request ${request.type} failed: ${error instanceof Error ? error.stack : error}`);
        fail(request.id, error instanceof Error ? error.message : String(error));
      });
    },
    () => socket.destroy(),
  );

  socket.setNoDelay(true);
  socket.on('data', read);
  socket.on('error', () => undefined);
  socket.on('close', () => {
    clients.delete(socket);
    manager.detachListener(listener);
    scheduleIdleCheck(IDLE_EXIT_MS);
  });
}

/** True when something is already answering on the endpoint. */
function endpointAlive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

function listen(endpoint: string, retried = false): void {
  const candidate = createServer(handleConnection);
  candidate.once('error', async (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && !retried && process.platform !== 'win32') {
      // A leftover socket file from a host that died. Only clear it once nothing answers.
      if (!(await endpointAlive(endpoint))) {
        try {
          unlinkSync(endpoint);
        } catch {
          // someone else removed it first
        }
        listen(endpoint, true);
        return;
      }
    }
    log(`could not listen on ${endpoint}: ${error.message}`);
    process.send?.({ type: 'failed', code: error.code ?? 'unknown' });
    process.exit(error.code === 'EADDRINUSE' ? EXIT_ENDPOINT_TAKEN : 1);
  });
  candidate.listen(endpoint, () => {
    server = candidate;
    // Only the process that won the endpoint publishes a token, so a loser can never
    // overwrite the secret the running host checks against.
    writeFileSync(paths.tokenFile, token, { mode: 0o600 });
    try {
      chmodSync(paths.tokenFile, 0o600);
    } catch {
      // not supported on this file system
    }
    log(`listening (app ${appVersion}, protocol ${PTY_HOST_PROTOCOL_VERSION})`);
    scheduleIdleCheck(STARTUP_IDLE_EXIT_MS);
    process.send?.({ type: 'ready', pid: process.pid });
  });
}

listen(paths.endpoint);
