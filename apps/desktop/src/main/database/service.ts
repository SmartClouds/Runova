import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  classifyStatement,
  type DbEngine,
  type DetectedDatabase,
  detectContainer,
  engineFromContainer,
  engineInfo,
  type FoundSignIn,
  findSignIns,
  formatConnectionUrl,
  MAX_ENV_FILE_BYTES,
  parseDotenv,
  type SchemaTable,
} from '@runova/core';
import type {
  DatabaseCandidate,
  DatabaseConnectCandidateInput,
  DatabaseConnection,
  DatabaseConnectResult,
  DatabaseDiscovery,
  DatabaseRevealedSignIn,
  DatabaseSaveInput,
  DatabaseSession,
  DatabaseSignIn,
  DatabaseSignInInput,
  DatabaseSignIns,
  DatabaseTarget,
  DbAiContext,
  DbAiContextInput,
  DbListObjectsInput,
  DbObjectNode,
  DbObjectRef,
  DbQueryInput,
  DbQueryOutcome,
  DbReadRowsInput,
  DbRowsPage,
  DbSetting,
  DbTableDescription,
  DbUser,
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
import { type LocalContainer, type LocalDocker, localEngine } from './localDocker';

/**
 * The Database section in main: finds database containers, connects in one click, and holds the
 * open sessions. Passwords come from the vault or a container's environment and never leave main.
 */

/** A session nobody used for this long is closed, along with its tunnel. */
const IDLE_MS = 30 * 60_000;
const DEFAULT_MAX_ROWS = 1000;
const MAX_ROWS = 50_000;
/** How much of a schema the AI gets: tables described in full, then names only. */
const AI_DESCRIBED_TABLES = 60;
const AI_SCHEMAS = 8;
const AI_SAMPLED_TABLES = 8;
const AI_SAMPLE_ROWS = 3;

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
  /**
   * A compose project's .env: over the server's SSH connection, or from this computer's disk for
   * null. Null when there is no such file or it cannot be read.
   */
  readEnvFile: (serverId: string | null, path: string) => Promise<string | null>;
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
  return list.groups.flatMap((group) => {
    const found = group.containers.flatMap((container) => {
      const engine = engineFromContainer({
        image: container.image,
        privatePorts: container.ports
          .filter((port) => port.protocol === 'tcp')
          .map((port) => port.privatePort),
      });
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
    });
    return withoutOneShots(found);
  });
}

/**
 * Drops a stopped container that runs the same image as a running database in its project: a
 * one-shot that ran against it (an init or a migration step), not a database of its own.
 */
function withoutOneShots<
  T extends { running: boolean; engine: DbEngine; image: string; project: string | null },
>(found: T[]): T[] {
  return found.filter(
    (candidate) =>
      candidate.running ||
      candidate.project === null ||
      !found.some(
        (other) =>
          other.running &&
          other.project === candidate.project &&
          other.engine === candidate.engine &&
          other.image === candidate.image,
      ),
  );
}

/** The .env Compose reads for a project, next to the folder it was started from. */
function envFilePath(serverId: string | null, workingDir: string): string {
  if (serverId) return `${workingDir.replace(/\/+$/, '')}/.env`;
  return join(workingDir, '.env');
}

const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

function envRecord(variables: ContainerEnvVariable[]): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.value]));
}

/** Every port a database listens on, inside the container and on its host. */
function portsOf(pairs: [number, number | null | undefined][]): number[] {
  return [...new Set(pairs.flatMap(([inside, host]) => (host ? [inside, host] : [inside])))];
}

/** A database container read in full: what it runs, how to reach it, and its project. */
interface ReadContainer {
  containerId: string;
  containerName: string;
  project: string | null;
  service: string | null;
  workingDir: string | null;
  env: Record<string, string>;
  detected: DetectedDatabase;
  target: DatabaseTarget;
  /** The ports it listens on inside the container and on the host. */
  ports: number[];
  /** The environments of the other containers in its project. */
  siblings: () => Promise<{
    list: { name: string; env: Record<string, string> }[];
    unread: string[];
  }>;
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
        found = withoutOneShots(
          (await this.deps.localDocker.listDatabases()).map((container) => ({
            key: sourceKey(null, container.name),
            source: 'local' as const,
            serverId: null,
            containerId: container.id,
            containerName: container.name,
            image: container.image,
            engine: localEngine(container) as DbEngine,
            running: container.running,
            project: container.project,
          })),
        );
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
   * Reads a database container: its engine, sign-in and address, and how to read the rest of its
   * project. A server asks for a step-up before it shows an environment; the proof goes with the
   * first read only, and the step-up it opens covers the others.
   */
  private async readContainer(input: DatabaseConnectCandidateInput): Promise<ReadContainer> {
    if (input.serverId) return this.readServerContainer(input.serverId, input);
    const container = await this.deps.localDocker.inspect(input.containerId);
    const detected = detectContainer(container);
    if (!detected) throw new Error(`${container.name} does not run a database Runova knows.`);
    return {
      containerId: container.id,
      containerName: container.name,
      project: container.project,
      service: container.service ?? null,
      workingDir: container.workingDir ?? null,
      env: container.env,
      detected,
      target: {
        kind: 'localContainer',
        containerId: container.id,
        containerName: container.name,
        port: detected.containerPort,
      },
      ports: portsOf(container.ports.map((port) => [port.containerPort, port.hostPort])),
      siblings: async () => {
        if (!container.project) return { list: [], unread: [] };
        const all = await this.deps.localDocker.listProject(container.project);
        return {
          list: all
            .filter((one) => one.id !== container.id)
            .map((one) => ({ name: one.name, env: one.env })),
          unread: [],
        };
      },
    };
  }

  private async readServerContainer(
    serverId: string,
    input: DatabaseConnectCandidateInput,
  ): Promise<ReadContainer> {
    const details = await this.deps.serverDocker.inspect(serverId, input.containerId);
    const variables = await this.deps.serverDocker.revealEnv({
      serverId,
      containerId: input.containerId,
      ...(input.password ? { password: input.password } : {}),
      ...(input.totpCode ? { totpCode: input.totpCode } : {}),
    });
    const env = envRecord(variables);
    const { summary } = details;
    const tcp = summary.ports.filter((port) => port.protocol === 'tcp');
    const detected = detectContainer({
      image: summary.image,
      env,
      ports: tcp.map((port) => ({
        containerPort: port.privatePort,
        hostPort: port.hostPort ?? null,
      })),
    });
    if (!detected) throw new Error(`${summary.name} does not run a database Runova knows.`);
    const project = summary.composeProject ?? null;
    const workingDir = details.labels.find((one) => one.name === WORKING_DIR_LABEL)?.value;
    return {
      containerId: summary.id,
      containerName: summary.name,
      project,
      service: summary.composeService ?? null,
      workingDir: workingDir || null,
      env,
      detected,
      target: {
        kind: 'server',
        serverId,
        ...serverAddress(details, detected.containerPort, detected.hostPort),
        containerId: summary.id,
        containerName: summary.name,
      },
      ports: portsOf(tcp.map((port) => [port.privatePort, port.hostPort])),
      siblings: async () => {
        if (!project) return { list: [], unread: [] };
        const list = await this.deps.serverDocker.listContainers(serverId);
        const others = list.groups
          .flatMap((group) => group.containers)
          .filter((one) => one.composeProject === project && one.id !== summary.id);
        const read = await Promise.allSettled(
          others.map((one) => this.deps.serverDocker.revealEnv({ serverId, containerId: one.id })),
        );
        const out: Awaited<ReturnType<ReadContainer['siblings']>> = { list: [], unread: [] };
        read.forEach((result, index) => {
          const name = others[index]?.name ?? '';
          if (result.status === 'fulfilled') out.list.push({ name, env: envRecord(result.value) });
          else out.unread.push(name);
        });
        return out;
      },
    };
  }

  /** Saves the connection for one sign-in to a container, then opens it. */
  private async saveAndConnect(
    read: ReadContainer,
    credentials: {
      user: string | null;
      password?: string;
      database: string | null;
      authDatabase: string | null;
    },
    key: string,
    /** Named in the connection, for a sign-in other than the one a card's Connect uses. */
    nameUser: string | null,
  ): Promise<DatabaseConnectResult> {
    const existing = await this.deps.connections.bySource(key);
    const { project, containerName } = read;
    const base =
      project && !containerName.includes(project) ? `${project} / ${containerName}` : containerName;
    const saved = await this.deps.connections.save(
      {
        ...(existing ? { id: existing.id } : {}),
        name: nameUser ? `${base} (${nameUser})` : base,
        engine: read.detected.engine,
        target: read.target,
        user: credentials.user,
        database: credentials.database,
        authDatabase: credentials.authDatabase,
        readOnly: existing?.readOnly ?? false,
        ...(credentials.password === undefined ? {} : { password: credentials.password }),
      },
      { sourceKey: key },
    );
    return this.connect(saved.id);
  }

  /**
   * One click on a container card: reads the engine and sign-in from the container, saves the
   * connection and opens it. A server asks for a step-up before it shows the environment; that
   * refusal reaches the renderer, which asks and calls again with the proof.
   */
  async connectCandidate(input: DatabaseConnectCandidateInput): Promise<DatabaseConnectResult> {
    const read = await this.readContainer(input);
    const { detected } = read;
    const password = detected.credentials.password ?? input.databasePassword;
    if (detected.needsPassword && password === undefined) {
      return {
        needsPassword: true,
        reason: 'missing',
        engine: detected.engine,
        user: detected.credentials.user ?? null,
      };
    }
    return this.saveAndConnect(
      read,
      {
        user: detected.credentials.user ?? null,
        database: detected.credentials.database ?? null,
        authDatabase: detected.credentials.authDatabase ?? null,
        ...(password === undefined ? {} : { password }),
      },
      sourceKey(input.serverId, read.containerName),
      null,
    );
  }

  /** Every sign-in a container's project writes down: its owner, the .env, the apps' URLs. */
  private async gatherSignIns(input: DatabaseConnectCandidateInput) {
    const read = await this.readContainer(input);
    const envPath = read.workingDir ? envFilePath(input.serverId, read.workingDir) : null;
    const [envText, siblings] = await Promise.all([
      envPath ? this.deps.readEnvFile(input.serverId, envPath).catch(() => null) : null,
      read.siblings(),
    ]);
    const envEntries =
      envText !== null && Buffer.byteLength(envText) <= MAX_ENV_FILE_BYTES
        ? parseDotenv(envText)
        : null;
    const signIns = findSignIns({
      engine: read.detected.engine,
      database: {
        name: read.containerName,
        service: read.service,
        env: read.env,
        ports: read.ports,
      },
      envFile: envPath && envEntries ? { path: envPath, entries: envEntries } : null,
      siblings: siblings.list,
    });
    const base = sourceKey(input.serverId, read.containerName);
    // The first owner keeps the key a card's Connect saves under, so the two stay one connection.
    const keyOf = (signIn: FoundSignIn) =>
      signIn.owner && signIn.id === signIns[0]?.id ? base : `${base}:${signIn.id}`;
    return {
      read,
      signIns,
      keyOf,
      envFile: envPath ? { path: envPath, found: envEntries !== null } : null,
      unread: siblings.unread,
    };
  }

  /** The sign-ins for a container, without their passwords. */
  async listSignIns(input: DatabaseConnectCandidateInput): Promise<DatabaseSignIns> {
    const gathered = await this.gatherSignIns(input);
    const signIns: DatabaseSignIn[] = [];
    for (const signIn of gathered.signIns) {
      const saved = await this.deps.connections.bySource(gathered.keyOf(signIn));
      signIns.push({
        id: signIn.id,
        user: signIn.user,
        database: signIn.database,
        hasPassword: signIn.password !== undefined,
        owner: signIn.owner,
        origin: signIn.origin,
        alsoIn: signIn.alsoIn,
        connectionId: saved?.id ?? null,
      });
    }
    return { signIns, envFile: gathered.envFile, unread: gathered.unread };
  }

  private async findSignIn(input: DatabaseSignInInput) {
    const gathered = await this.gatherSignIns(input);
    const signIn = gathered.signIns.find((one) => one.id === input.signInId);
    if (!signIn) throw new Error('That sign-in is gone. Look again for the current ones.');
    return { ...gathered, signIn };
  }

  /** Connects with one of the sign-ins `listSignIns` found. */
  async connectSignIn(input: DatabaseSignInInput): Promise<DatabaseConnectResult> {
    const { read, signIn, keyOf } = await this.findSignIn(input);
    const password = signIn.password ?? input.databasePassword;
    const passwordless = signIn.owner && !read.detected.needsPassword;
    if (password === undefined && !passwordless && engineInfo(signIn.engine).passwordRequired) {
      return { needsPassword: true, reason: 'missing', engine: signIn.engine, user: signIn.user };
    }
    const key = keyOf(signIn);
    return this.saveAndConnect(
      read,
      {
        user: signIn.user,
        database: signIn.database,
        authDatabase: signIn.authDatabase ?? null,
        ...(password === undefined ? {} : { password }),
      },
      key,
      key === sourceKey(input.serverId, read.containerName) ? null : signIn.user,
    );
  }

  /**
   * Shows one sign-in on purpose: the URL as the project's containers reach the database (by its
   * service name), with the password. Read again each time and never kept.
   */
  async revealSignIn(input: DatabaseSignInInput): Promise<DatabaseRevealedSignIn> {
    const { read, signIn } = await this.findSignIn(input);
    if (signIn.engine === 'sqlite') throw new Error('A SQLite file has no sign-in to show.');
    const url = formatConnectionUrl(
      {
        engine: signIn.engine,
        host: read.service ?? read.containerName,
        port: read.detected.containerPort,
        ...(signIn.user ? { user: signIn.user } : {}),
        ...(signIn.password !== undefined ? { password: signIn.password } : {}),
        ...(signIn.database ? { database: signIn.database } : {}),
        ...(signIn.authDatabase ? { authDatabase: signIn.authDatabase } : {}),
        tls: false,
      },
      { withPassword: true },
    );
    return { url, password: signIn.password ?? null };
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

  /**
   * The tables and columns the AI is shown, from the database the editor points at. Rows only
   * come along when the user allowed sample rows, a few per table.
   */
  aiContext(input: DbAiContextInput): Promise<DbAiContext> {
    return this.withSession(input.sessionId, async (session) => {
      const stored = await this.deps.connections.get(session.connectionId);
      const database = input.database ?? stored.database ?? null;
      const driver = session.driver;
      const top = await driver.listObjects(null, null);
      let containers = top.filter((node) => node.kind === 'database');
      let tables = top.filter((node) => !node.hasChildren);
      if (containers.length > 0) {
        const chosen = containers.find((node) => node.name === database) ?? containers[0];
        containers = chosen ? [chosen] : [];
        tables = [];
        for (const node of containers) {
          const inside = await driver.listObjects(node.ref, node.kind);
          const schemas = inside.filter((child) => child.kind === 'schema').slice(0, AI_SCHEMAS);
          tables.push(...inside.filter((child) => !child.hasChildren));
          for (const schema of schemas) {
            tables.push(...(await driver.listObjects(schema.ref, schema.kind)));
          }
        }
      }
      const schema: SchemaTable[] = [];
      const samples: DbAiContext['samples'] = [];
      for (const [index, node] of tables.entries()) {
        const name = [node.ref.schema, node.ref.name].filter(Boolean).join('.');
        if (index >= AI_DESCRIBED_TABLES || node.kind === 'key') {
          schema.push({ name: node.detail ? `${name} (${node.detail})` : name, columns: [] });
          continue;
        }
        try {
          const table = await driver.describe(node.ref);
          schema.push({
            name,
            columns: table.columns.map((column) => ({
              name: column.name,
              type: column.type,
              ...(column.primaryKey ? { primaryKey: true } : {}),
            })),
          });
          if (input.includeSamples && samples.length < AI_SAMPLED_TABLES) {
            const page = await driver.readRows({ ref: node.ref, limit: AI_SAMPLE_ROWS, offset: 0 });
            samples.push({
              table: name,
              columns: page.result.columns.map((column) => column.name),
              rows: page.result.rows,
            });
          }
        } catch {
          schema.push({ name, columns: [] });
        }
      }
      return { database: containers[0]?.name ?? database, schema, samples };
    });
  }

  /** The server's settings, or none where the engine has none to show. */
  settings(sessionId: string): Promise<DbSetting[]> {
    return this.withSession(
      sessionId,
      async (session) => (await session.driver.settings?.()) ?? [],
    );
  }

  users(sessionId: string): Promise<DbUser[]> {
    return this.withSession(sessionId, async (session) => (await session.driver.users?.()) ?? []);
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

let running: DatabaseService | null = null;

/** Main keeps the one service the Database page uses, so AI access reaches the same sessions. */
export function setDatabaseService(service: DatabaseService | null): void {
  running = service;
}

/** The Database page's service, or null before main has set it up. */
export function getDatabaseService(): DatabaseService | null {
  return running;
}
