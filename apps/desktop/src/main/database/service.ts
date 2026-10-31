import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { classifyStatement, type DbEngine, detectContainer, engineFromImage } from '@runova/core';
import type {
  DatabaseCandidate,
  DatabaseConnectCandidateInput,
  DatabaseConnection,
  DatabaseConnectResult,
  DatabaseDiscovery,
  DatabaseSaveInput,
  DatabaseSession,
  DatabaseTarget,
  DbListObjectsInput,
  DbObjectNode,
  DbObjectRef,
  DbQueryInput,
  DbQueryOutcome,
  DbReadRowsInput,
  DbRowsPage,
  DbTableDescription,
} from '../../shared/databaseTypes';
import type {
  ContainerDetails,
  ContainerEnvVariable,
  ContainerList,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployRevealEnvInput } from '../../shared/deployDockerTypes';
import type { DatabaseConnectionStore } from './connectionStore';
import type { OpenDriver } from './drivers';
import { describeError } from './drivers/shared';
import type { DbDriver, DriverConnectOptions, DriverError } from './drivers/types';
import { openLocalForward } from './forward';
import type { LocalContainer, LocalDocker } from './localDocker';

/**
 * The Database section in main: finds database containers, connects in one click, and holds the
 * open sessions. Passwords come from the vault or a container's environment and never leave main.
 */

/** A session nobody used for this long is closed, along with its tunnel. */
const IDLE_MS = 30 * 60_000;
const DEFAULT_MAX_ROWS = 1000;
const MAX_ROWS = 50_000;

export interface ServerDocker {
  listContainers: (serverId: string) => Promise<ContainerList>;
  inspect: (serverId: string, containerId: string) => Promise<ContainerDetails>;
  revealEnv: (input: DeployRevealEnvInput) => Promise<ContainerEnvVariable[]>;
}

export interface DatabaseServiceDeps {
  connections: DatabaseConnectionStore;
  openDriver: OpenDriver;
  serverDocker: ServerDocker;
  /** A stream to a host and port as the server sees it, inside the server's SSH connection. */
  serverStream: (serverId: string, host: string, port: number) => Promise<Duplex>;
  localDocker: LocalDocker;
  /** Docker Desktop (Windows, macOS) cannot reach container addresses from this computer. */
  containerAddressesReachable: boolean;
  now?: () => number;
}

interface Session {
  id: string;
  connectionId: string;
  engine: DbEngine;
  readOnly: boolean;
  driver: DbDriver;
  cleanup: (() => Promise<void>)[];
  running: Map<string, AbortController>;
  lastUsed: number;
}

function sourceKey(serverId: string | null, containerName: string): string {
  return serverId ? `server:${serverId}:${containerName}` : `local:${containerName}`;
}

function serverCandidates(
  serverId: string,
  list: ContainerList,
): Omit<DatabaseCandidate, 'connectionId'>[] {
  return list.groups.flatMap((group) =>
    group.containers.flatMap((container) => {
      const engine = engineFromImage(container.image);
      if (!engine) return [];
      return [
        {
          key: sourceKey(serverId, container.name),
          source: 'server' as const,
          serverId,
          containerId: container.id,
          containerName: container.name,
          image: container.image,
          engine,
          running: container.state === 'running',
          project: container.composeProject ?? group.project ?? null,
        },
      ];
    }),
  );
}

/** How a database in a server container is reached from the server: its address, or its port. */
function serverAddress(details: ContainerDetails, containerPort: number, hostPort: number | null) {
  const ip = details.networks.find((network) => network.ipAddress)?.ipAddress;
  if (ip) return { host: ip, port: containerPort };
  return { host: '127.0.0.1', port: hostPort ?? containerPort };
}

export class DatabaseService {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DatabaseServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------------- connections

  listConnections(): Promise<DatabaseConnection[]> {
    return this.deps.connections.list();
  }

  saveConnection(input: DatabaseSaveInput): Promise<DatabaseConnection> {
    return this.deps.connections.save(input);
  }

  async removeConnection(id: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.connectionId === id) await this.disconnect(session.id);
    }
    await this.deps.connections.remove(id);
  }

  /** Finds the database containers on a server, or in this computer's Docker for null. */
  async discover(serverId: string | null): Promise<DatabaseDiscovery> {
    const problems: DatabaseDiscovery['problems'] = [];
    let found: Omit<DatabaseCandidate, 'connectionId'>[] = [];
    try {
      if (serverId) {
        found = serverCandidates(serverId, await this.deps.serverDocker.listContainers(serverId));
      } else {
        found = (await this.deps.localDocker.listDatabases()).map((container) => ({
          key: sourceKey(null, container.name),
          source: 'local' as const,
          serverId: null,
          containerId: container.id,
          containerName: container.name,
          image: container.image,
          engine: engineFromImage(container.image) as DbEngine,
          running: container.running,
          project: container.project,
        }));
      }
    } catch (error) {
      problems.push({
        source: serverId ? 'server' : 'local',
        message: serverId
          ? describeError(error)
          : 'Docker on this computer is not running, so its containers cannot be listed.',
      });
    }
    const candidates: DatabaseCandidate[] = [];
    for (const candidate of found) {
      const saved = await this.deps.connections.bySource(candidate.key);
      candidates.push({ ...candidate, connectionId: saved?.id ?? null });
    }
    candidates.sort(
      (a, b) =>
        Number(b.running) - Number(a.running) || a.containerName.localeCompare(b.containerName),
    );
    return { candidates, problems };
  }

  /**
   * One click on a container card: reads the engine and sign-in from the container, saves the
   * connection and opens it. A server asks for a step-up before it shows the environment; that
   * refusal reaches the renderer, which asks and calls again with the proof.
   */
  async connectCandidate(input: DatabaseConnectCandidateInput): Promise<DatabaseConnectResult> {
    let image: string;
    let containerName: string;
    let project: string | null;
    let env: Record<string, string>;
    let target: DatabaseTarget;
    let detected: ReturnType<typeof detectContainer>;

    if (input.serverId) {
      const details = await this.deps.serverDocker.inspect(input.serverId, input.containerId);
      const variables = await this.deps.serverDocker.revealEnv({
        serverId: input.serverId,
        containerId: input.containerId,
        ...(input.password ? { password: input.password } : {}),
        ...(input.totpCode ? { totpCode: input.totpCode } : {}),
      });
      env = Object.fromEntries(variables.map((variable) => [variable.name, variable.value]));
      image = details.summary.image;
      containerName = details.summary.name;
      project = details.summary.composeProject ?? null;
      detected = detectContainer({
        image,
        env,
        ports: details.summary.ports
          .filter((port) => port.protocol === 'tcp')
          .map((port) => ({ containerPort: port.privatePort, hostPort: port.hostPort ?? null })),
      });
      if (!detected) throw new Error(`${containerName} does not run a database Runova knows.`);
      const address = serverAddress(details, detected.containerPort, detected.hostPort);
      target = {
        kind: 'server',
        serverId: input.serverId,
        ...address,
        containerId: details.summary.id,
        containerName,
      };
    } else {
      const container = await this.deps.localDocker.inspect(input.containerId);
      image = container.image;
      containerName = container.name;
      project = container.project;
      env = container.env;
      detected = detectContainer(container);
      if (!detected) throw new Error(`${containerName} does not run a database Runova knows.`);
      target = {
        kind: 'localContainer',
        containerId: container.id,
        containerName,
        port: detected.containerPort,
      };
    }

    const password = detected.credentials.password ?? input.databasePassword;
    if (detected.needsPassword && password === undefined) {
      return {
        needsPassword: true,
        reason: 'missing',
        engine: detected.engine,
        user: detected.credentials.user ?? null,
      };
    }
    const key = sourceKey(input.serverId, containerName);
    const existing = await this.deps.connections.bySource(key);
    const saved = await this.deps.connections.save(
      {
        ...(existing ? { id: existing.id } : {}),
        name:
          project && !containerName.includes(project)
            ? `${project} / ${containerName}`
            : containerName,
        engine: detected.engine,
        target,
        user: detected.credentials.user ?? null,
        database: detected.credentials.database ?? null,
        authDatabase: detected.credentials.authDatabase ?? null,
        readOnly: existing?.readOnly ?? false,
        ...(password === undefined ? {} : { password }),
      },
      { sourceKey: key },
    );
    return this.connect(saved.id);
  }

  /** Opens a saved connection. Answers `needsPassword` when the server refused the sign-in. */
  async connect(connectionId: string, password?: string): Promise<DatabaseConnectResult> {
    const stored = await this.deps.connections.get(connectionId);
    if (password !== undefined) {
      await this.deps.connections.save({ ...stored, password }, { sourceKey: stored.sourceKey });
    }
    const secret = password ?? (await this.deps.connections.password(connectionId));
    const cleanup: (() => Promise<void>)[] = [];
    const runCleanup = async () => {
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
    };
    let driver: DbDriver;
    try {
      const where = await this.reach(stored.target, cleanup);
      const options: DriverConnectOptions = {
        engine: stored.engine,
        ...where,
        ...(stored.user ? { user: stored.user } : {}),
        ...(secret !== undefined ? { password: secret } : {}),
        ...(stored.database ? { database: stored.database } : {}),
        ...(stored.authDatabase ? { authDatabase: stored.authDatabase } : {}),
        tls: stored.tls,
        srv: stored.srv,
      };
      driver = await this.deps.openDriver(options);
    } catch (error) {
      await runCleanup();
      if ((error as Partial<DriverError>).authFailed === true) {
        return { needsPassword: true, reason: 'refused', engine: stored.engine, user: stored.user };
      }
      throw new Error(describeError(error));
    }
    const session: Session = {
      id: randomUUID(),
      connectionId,
      engine: stored.engine,
      readOnly: stored.readOnly,
      driver,
      cleanup,
      running: new Map(),
      lastUsed: this.now(),
    };
    this.sessions.set(session.id, session);
    this.startSweeper();
    await this.deps.connections.touch(connectionId, this.now());
    let serverVersion = '';
    try {
      serverVersion = await driver.serverVersion();
    } catch {
      // The version is only shown; a server that will not say is still usable.
    }
    const result: DatabaseSession = {
      sessionId: session.id,
      connection: await this.deps.connections.summary(connectionId),
      serverVersion,
    };
    return result;
  }

  /** Where the driver should connect: a forward for a server, a published port or helper locally. */
  private async reach(
    target: DatabaseTarget,
    cleanup: (() => Promise<void>)[],
  ): Promise<Pick<DriverConnectOptions, 'host' | 'port' | 'file'>> {
    switch (target.kind) {
      case 'direct':
        return { host: target.host, port: target.port };
      case 'sqliteFile':
        return { host: '', port: null, file: target.path };
      case 'server': {
        const { port } = target;
        let { host } = target;
        // A container gets a new address when it is recreated, so it is looked up again by name.
        if (target.containerName && host !== '127.0.0.1') {
          try {
            const details = await this.deps.serverDocker.inspect(
              target.serverId,
              target.containerName,
            );
            host = details.networks.find((network) => network.ipAddress)?.ipAddress ?? host;
          } catch {
            // Keep the saved address; the connection error says more than this would.
          }
        }
        const forward = await openLocalForward(() =>
          this.deps.serverStream(target.serverId, host, port),
        );
        cleanup.push(forward.close);
        return { host: forward.host, port: forward.port };
      }
      case 'localContainer': {
        let container: LocalContainer;
        try {
          container = await this.deps.localDocker.inspect(target.containerName);
        } catch {
          container = await this.deps.localDocker.inspect(target.containerId);
        }
        if (!container.running)
          throw new Error(`${container.name} is not running. Start it, then connect.`);
        const published = container.ports.find(
          (port) => port.containerPort === target.port,
        )?.hostPort;
        if (published) return { host: '127.0.0.1', port: published };
        const network = container.networks[0];
        if (this.deps.containerAddressesReachable && network?.ip) {
          return { host: network.ip, port: target.port };
        }
        if (!network) throw new Error(`${container.name} is on no network Runova can reach.`);
        const helper = await this.deps.localDocker.startHelper({
          network: network.name,
          host: container.name,
          port: target.port,
        });
        cleanup.push(helper.stop);
        return { host: '127.0.0.1', port: helper.port };
      }
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const controller of session.running.values()) controller.abort();
    await session.driver.close().catch(() => undefined);
    for (const step of session.cleanup.splice(0).reverse()) await step().catch(() => undefined);
    if (this.sessions.size === 0) this.stopSweeper();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  // ---------------------------------------------------------------------------------- browsing

  listObjects(input: DbListObjectsInput): Promise<DbObjectNode[]> {
    return this.withSession(input.sessionId, (session) =>
      session.driver.listObjects(input.parent, input.parentKind, input.search),
    );
  }

  describe(sessionId: string, ref: DbObjectRef): Promise<DbTableDescription> {
    return this.withSession(sessionId, (session) => session.driver.describe(ref));
  }

  readRows(input: DbReadRowsInput): Promise<DbRowsPage> {
    const { sessionId, ...rest } = input;
    return this.withSession(sessionId, (session) => session.driver.readRows(rest));
  }

  // ---------------------------------------------------------------------------------- queries

  async query(input: DbQueryInput): Promise<DbQueryOutcome> {
    const session = this.session(input.sessionId);
    const classification = classifyStatement(session.engine, input.text);
    const isRead = classification.kind === 'read';
    const held =
      !isRead &&
      !input.confirmed &&
      (input.origin === 'ai' || session.readOnly || classification.destructive);
    if (held) return { status: 'needsConfirmation', classification };

    const controller = new AbortController();
    session.running.get(input.queryId)?.abort();
    session.running.set(input.queryId, controller);
    session.lastUsed = this.now();
    try {
      const outcome = await session.driver.query(input.text, {
        database: input.database ?? null,
        maxRows: Math.min(Math.max(1, input.maxRows ?? DEFAULT_MAX_ROWS), MAX_ROWS),
        readOnly: isRead,
        signal: controller.signal,
      });
      if (outcome.cancelled) return { status: 'cancelled', results: outcome.results };
      if (outcome.error) {
        return {
          status: 'failed',
          results: outcome.results,
          error: outcome.error.message,
          statementIndex: outcome.error.statementIndex,
        };
      }
      return { status: 'done', results: outcome.results };
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled', results: [] };
      return { status: 'failed', results: [], error: describeError(error), statementIndex: null };
    } finally {
      if (session.running.get(input.queryId) === controller) session.running.delete(input.queryId);
      session.lastUsed = this.now();
    }
  }

  cancelQuery(sessionId: string, queryId: string): boolean {
    const controller = this.sessions.get(sessionId)?.running.get(queryId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // ---------------------------------------------------------------------------------- internals

  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('This connection was closed. Connect again to carry on.');
    return session;
  }

  private async withSession<T>(
    sessionId: string,
    work: (session: Session) => Promise<T>,
  ): Promise<T> {
    const session = this.session(sessionId);
    session.lastUsed = this.now();
    try {
      return await work(session);
    } catch (error) {
      throw new Error(describeError(error));
    } finally {
      session.lastUsed = this.now();
    }
  }

  /** Closes sessions left idle, so tunnels and helper containers do not pile up. */
  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - IDLE_MS;
    for (const session of [...this.sessions.values()]) {
      if (session.running.size === 0 && session.lastUsed < cutoff)
        await this.disconnect(session.id);
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000);
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
