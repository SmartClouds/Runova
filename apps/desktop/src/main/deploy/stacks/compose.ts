import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import {
  analyzeComposePorts,
  type ComposePortBinding,
  type ComposeProject,
  type ComposeRisk,
  type ComposeRiskSeverity,
  type DockerignoreMatcher,
  dockerCleanPath,
  lintComposeProject,
  MAX_COMPOSE_FILE_BYTES,
  type Project,
  parseComposeFile,
  parseDockerignore,
  renderComposeEnv,
  renderLoopbackOverride,
} from '@runova/core';
import type { ExplorerFileIndex } from '../../../shared/apiTypes';
import type {
  DeployComposeDiscovery,
  DeployComposeFile,
  DeployImageSource,
  DeployStackPreview,
  DeployStackPreviewInput,
  DeployStackServicePreview,
} from '../../../shared/deployStacksTypes';
import type { ResolvedProjectEnvironment } from '../../ipc/environments';

/**
 * The Apps wizard's view of a project (E07): which compose files it has, and what one of them
 * turns into on a server with a given environment. Everything is read here, in the main process;
 * the renderer gets service names, ports, env keys and findings, never an env value.
 */

/** compose.yaml, compose.yml, docker-compose.yml, docker-compose.prod.yaml and so on. */
const COMPOSE_FILE = /^(?:compose\.ya?ml|docker-compose[^/]*\.ya?ml)$/i;

/** More than any project has; a list past this is a folder of fixtures, not choices. */
export const MAX_DISCOVERED_FILES = 50;

const SEVERITY_ORDER: Record<ComposeRiskSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface StackSourceDeps {
  project: (projectId: string) => Promise<Project>;
  index: (folder: string) => Promise<ExplorerFileIndex>;
  environment: (
    projectId: string,
    environmentId: string,
    fileIds?: readonly string[],
  ) => Promise<ResolvedProjectEnvironment>;
}

/** A compose file read from a project, with everything a preview or an upload needs. */
export interface ReadStackSource {
  project: Project;
  /** The project folder, resolved. */
  root: string;
  composePath: string;
  /** The compose file's own folder: the compose project directory and the build context root. */
  composeDir: string;
  composeText: string;
  environment: ResolvedProjectEnvironment | null;
}

export function isComposeFileName(name: string): boolean {
  return COMPOSE_FILE.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The compose files of a project, shallowest first, each with its service count or why it cannot be read. */
export async function discoverComposeFiles(
  deps: StackSourceDeps,
  projectId: string,
): Promise<DeployComposeDiscovery> {
  const project = await deps.project(projectId);
  const index = await deps.index(project.folderPath);
  const found = index.files
    .filter((path) => isComposeFileName(posix.basename(path)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const files: DeployComposeFile[] = [];
  for (const path of found.slice(0, MAX_DISCOVERED_FILES)) {
    try {
      const text = await readComposeText(index.root, path);
      const parsed = parseComposeFile(text);
      files.push(
        parsed.ok
          ? { path, services: parsed.project.services.length }
          : { path, services: null, error: parsed.reason },
      );
    } catch (error) {
      files.push({ path, services: null, error: (error as Error).message });
    }
  }
  return {
    projectId,
    projectName: project.name,
    files,
    truncated: index.truncated || found.length > MAX_DISCOVERED_FILES,
  };
}

/** Reads a compose file by its path relative to the project, refusing anything that leaves it. */
async function readComposeText(root: string, composePath: string): Promise<string> {
  if (
    typeof composePath !== 'string' ||
    composePath === '' ||
    isAbsolute(composePath) ||
    composePath.includes('\\') ||
    composePath.split('/').includes('..')
  ) {
    throw new Error('Pick a compose file inside the project.');
  }
  if (!isComposeFileName(posix.basename(composePath))) {
    throw new Error('That is not a compose file (compose.yaml or docker-compose.yml).');
  }
  const full = resolve(root, ...composePath.split('/'));
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(full)]);
  if (!within(realRoot, realFile)) throw new Error('That compose file leads out of the project.');
  const info = await lstat(realFile);
  if (!info.isFile()) throw new Error('That compose file is not a file.');
  if (info.size > MAX_COMPOSE_FILE_BYTES) {
    throw new Error(
      `The compose file is larger than ${MAX_COMPOSE_FILE_BYTES / (1024 * 1024)} MB.`,
    );
  }
  return readFile(realFile, 'utf8');
}

export async function readStackSource(
  deps: StackSourceDeps,
  input: {
    projectId: string;
    composePath: string;
    environmentId: string | null;
    envFileIds?: string[] | null;
  },
): Promise<ReadStackSource> {
  const project = await deps.project(input.projectId);
  const root = resolve(project.folderPath);
  const composeText = await readComposeText(root, input.composePath);
  const environment = input.environmentId
    ? input.envFileIds
      ? await deps.environment(input.projectId, input.environmentId, input.envFileIds)
      : await deps.environment(input.projectId, input.environmentId)
    : null;
  const composeDir = dirname(resolve(root, ...input.composePath.split('/')));
  return { project, root, composePath: input.composePath, composeDir, composeText, environment };
}

const relativeSource = (value: unknown): boolean =>
  typeof value === 'string' && (value === '.' || value.startsWith('./') || value.startsWith('../'));

/**
 * Why the compose folder has to go to the server with the files, or null: a service builds, or
 * the file reads something relative to itself (env files, bind mounts, secrets and configs).
 */
export function buildContextReason(project: ComposeProject): string | null {
  for (const { name, definition } of project.services) {
    if (definition.build !== undefined) return `${name} builds from the project.`;
  }
  for (const { name, definition } of project.services) {
    const envFiles = Array.isArray(definition.env_file)
      ? definition.env_file
      : definition.env_file === undefined
        ? []
        : [definition.env_file];
    for (const entry of envFiles) {
      const path = typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined;
      if (typeof path === 'string' && !path.startsWith('/')) {
        return `${name} reads ${path} from the project.`;
      }
    }
    for (const entry of Array.isArray(definition.volumes) ? definition.volumes : []) {
      const source =
        typeof entry === 'string' ? entry.split(':')[0] : isRecord(entry) ? entry.source : null;
      if (relativeSource(source) && (typeof entry === 'string' || entry.type === 'bind')) {
        return `${name} mounts ${String(source)} from the project.`;
      }
    }
  }
  for (const kind of ['configs', 'secrets'] as const) {
    const section = project.data[kind];
    if (!isRecord(section)) continue;
    for (const [name, item] of Object.entries(section)) {
      if (isRecord(item) && typeof item.file === 'string' && !item.file.startsWith('/')) {
        return `The ${kind === 'secrets' ? 'secret' : 'config'} ${name} comes from ${item.file} in the project.`;
      }
    }
  }
  return null;
}

/** A path on this computer the compose file reads, as written: not absolute, not a home path. */
const projectPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  !value.startsWith('/') &&
  !value.startsWith('~') &&
  !/^[A-Za-z]:[\\/]/.test(value);

/** Every path the compose file reads relative to its folder, as written (E105). */
function projectReferences(project: ComposeProject): string[] {
  const found: string[] = [];
  for (const { definition } of project.services) {
    const envFiles = Array.isArray(definition.env_file)
      ? definition.env_file
      : definition.env_file === undefined
        ? []
        : [definition.env_file];
    for (const entry of envFiles) {
      const path = typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined;
      if (projectPath(path)) found.push(path);
    }
    for (const entry of Array.isArray(definition.volumes) ? definition.volumes : []) {
      const source =
        typeof entry === 'string' ? entry.split(':')[0] : isRecord(entry) ? entry.source : null;
      if (relativeSource(source) && (typeof entry === 'string' || entry.type === 'bind')) {
        found.push(source as string);
      }
    }
  }
  for (const kind of ['configs', 'secrets'] as const) {
    const section = project.data[kind];
    if (!isRecord(section)) continue;
    for (const item of Object.values(section)) {
      if (isRecord(item) && projectPath(item.file)) found.push(item.file);
    }
  }
  return found;
}

const cleaned = (path: string): string => dockerCleanPath(path.replaceAll('\\', '/'));

const outside = (path: string): boolean => path === '..' || path.startsWith('../');

/**
 * The files and folders the compose file reads from its own folder, relative to it, sorted:
 * what a registry or release deploy sends besides the compose file and the .env (E105).
 */
export function projectFilesOf(project: ComposeProject): string[] {
  const paths = projectReferences(project)
    .map(cleaned)
    .filter((path) => path !== '.' && path !== '' && !outside(path));
  return [...new Set(paths)].sort();
}

/**
 * Why each image source cannot deploy a compose file, or null when it can (E105). A registry or
 * release deploy builds nothing, so a service that builds has to name the image to pull or load
 * instead, and it sends only files from the compose folder.
 */
export function sourceBlocking(project: ComposeProject): Record<DeployImageSource, string | null> {
  const unnamed = project.services.find(
    ({ definition }) =>
      definition.build !== undefined &&
      (typeof definition.image !== 'string' || definition.image === ''),
  );
  const climbing = projectReferences(project).find((path) => outside(cleaned(path)));
  const away = climbing
    ? `The compose file reads ${climbing}, outside its own folder, so it cannot go with the compose file. Move it into the compose folder.`
    : null;
  return {
    registry: unnamed
      ? `${unnamed.name} builds from source and names no image:, so there is nothing to pull. Add the image your pipeline publishes as image:, or deploy from a local folder to build it on the server.`
      : away,
    release: unnamed
      ? `${unnamed.name} builds from source and names no image:, so the release image cannot stand in for it. Set image: to the name your pipeline saves, or deploy from a local folder.`
      : away,
    local: null,
  };
}

/** The env files each service cannot start without, as written: every entry but `required: false`. */
function requiredEnvFiles(project: ComposeProject): Array<{ service: string; path: string }> {
  const found: Array<{ service: string; path: string }> = [];
  for (const { name, definition } of project.services) {
    const entries = Array.isArray(definition.env_file)
      ? definition.env_file
      : definition.env_file === undefined
        ? []
        : [definition.env_file];
    for (const entry of entries) {
      const path =
        typeof entry === 'string'
          ? entry
          : isRecord(entry) && entry.required !== false
            ? entry.path
            : undefined;
      if (projectPath(path)) found.push({ service: name, path });
    }
  }
  return found;
}

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

/** The compose folder's .dockerignore, or null. A broken one is reported when the folder is packed. */
async function dockerignoreOf(folder: string): Promise<DockerignoreMatcher | null> {
  const text = await readFile(join(folder, '.dockerignore'), 'utf8').catch(() => null);
  if (text === null) return null;
  const parsed = parseDockerignore(text);
  return parsed.ok ? parsed.matcher : null;
}

function envFileReason(service: string, path: string, why: string): string {
  return `${service} reads ${path} (env_file), but ${why}, so the server would not get it and Compose would stop with "env file not found". The environment picked in Source does not stand in for it: its values only fill the \${...} in the compose file. List the variables ${service} needs under environment: instead (for example NAME: \${NAME}), or mark the entry required: false if ${service} can start without it.`;
}

/**
 * Why each image source would leave out an env file a service needs, or null. A registry or
 * release deploy sends a file the compose file reads only when it is in the compose folder here,
 * and a local folder deploy sends that folder minus what .dockerignore leaves out. Without this
 * the deploy failed on the server, after the upload (an env_file: .env next to a .env.prod).
 */
export async function envFileBlocking(
  project: ComposeProject,
  composeDir: string,
): Promise<Record<DeployImageSource, string | null>> {
  const blocked: Record<DeployImageSource, string | null> = {
    registry: null,
    release: null,
    local: null,
  };
  let matcher: DockerignoreMatcher | null | undefined;
  for (const { service, path } of requiredEnvFiles(project)) {
    const clean = cleaned(path);
    if (outside(clean)) {
      // sourceBlocking already refuses this for a registry or release deploy.
      blocked.local ??= envFileReason(service, path, "it is outside the compose file's folder");
      continue;
    }
    if (!(await isFile(resolve(composeDir, ...clean.split('/'))))) {
      const reason = envFileReason(
        service,
        path,
        `there is no ${clean} in the compose file's folder`,
      );
      blocked.registry ??= reason;
      blocked.release ??= reason;
      blocked.local ??= reason;
      continue;
    }
    if (matcher === undefined) matcher = await dockerignoreOf(composeDir);
    if (matcher?.excludes(clean)) {
      blocked.local ??= envFileReason(service, path, '.dockerignore leaves it out');
    }
  }
  return blocked;
}

/** A preview with what the files on this computer block added to what the compose file blocks. */
export async function withEnvFileBlocking<
  T extends {
    project: ComposeProject | null;
    sourceBlocking: Record<DeployImageSource, string | null>;
  },
>(preview: T, composeDir: string): Promise<T> {
  if (!preview.project) return preview;
  const files = await envFileBlocking(preview.project, composeDir);
  const own = preview.sourceBlocking;
  return {
    ...preview,
    sourceBlocking: {
      registry: own.registry ?? files.registry,
      release: own.release ?? files.release,
      local: own.local ?? files.local,
    },
  };
}

/**
 * Dockerfiles inside the compose folder, relative to it, that must go into the context even when
 * .dockerignore leaves them out (Docker always sends a build's own Dockerfile).
 */
export function dockerfilesOf(project: ComposeProject): string[] {
  const files = new Set<string>();
  for (const { definition } of project.services) {
    const { build } = definition;
    let context: string | null = null;
    let dockerfile = 'Dockerfile';
    if (typeof build === 'string') context = build;
    if (isRecord(build)) {
      context = typeof build.context === 'string' ? build.context : '.';
      if (typeof build.dockerfile === 'string') dockerfile = build.dockerfile;
    }
    if (context === null || /^[a-z][a-z0-9+.-]*:\/\//i.test(context)) continue;
    const path = dockerCleanPath(posix.join(context, dockerfile));
    if (path !== '..' && !path.startsWith('../') && !path.startsWith('/')) files.add(path);
  }
  return [...files];
}

function servicePreview(
  project: ComposeProject,
): Map<string, Omit<DeployStackServicePreview, 'name'>> {
  const ports = analyzeComposePorts(project);
  const services = new Map<string, Omit<DeployStackServicePreview, 'name'>>();
  project.services.forEach(({ name, definition }, index) => {
    const info = ports[index];
    services.set(name, {
      image: typeof definition.image === 'string' ? definition.image : null,
      builds: definition.build !== undefined,
      ports: info.bindings,
      publishes: info.bindings.length > 0,
      hostNetwork: info.hostNetwork,
    });
  });
  return services;
}

/** Variables compose reads from the shell when no .env sets them; never worth a warning. */
const SHELL_ONLY = new Set(['PWD', 'HOME', 'USER']);

/**
 * What a compose file and environment turn into on the server: services, the ports once the
 * loopback override applies, the override itself, the findings and what needs acknowledging,
 * the env keys (not values), and whether a build context goes too. `blocking` says why it cannot
 * be deployed at all.
 */
export async function previewStack(
  deps: StackSourceDeps,
  input: DeployStackPreviewInput,
): Promise<DeployStackPreview> {
  const source = await readStackSource(deps, input);
  // The rendered .env holds the values: it stays here, and so does the parsed file.
  const {
    envText: _envText,
    project: _project,
    ...preview
  } = await withEnvFileBlocking(
    previewFromSource(source, input.proxiedServices, input.selinuxEnforcing === true),
    source.composeDir,
  );
  return preview;
}

export function previewFromSource(
  source: ReadStackSource,
  proxiedServices: readonly string[] | undefined,
  selinuxEnforcing: boolean,
): DeployStackPreview & { envText: string | null; project: ComposeProject | null } {
  const entries = source.environment?.entries ?? [];
  const empty = {
    projectName: source.project.name,
    composePath: source.composePath,
    composeName: null,
    services: [],
    envKeys: entries.map((entry) => entry.key),
    envFiles: source.environment?.files.map((file) => file.fileName) ?? [],
    missingVariables: [],
    proxiedServices: [],
    bindings: [],
    overrideText: '',
    risks: [],
    requiresAcknowledgment: [],
    buildContext: null,
    projectFiles: [],
    sourceBlocking: { registry: null, release: null, local: null },
    envText: null,
    project: null,
  };
  const env = renderComposeEnv(entries);
  if (!env.ok) return { ...empty, blocking: env.reason };
  const parsed = parseComposeFile(source.composeText, {
    environment: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
  });
  if (!parsed.ok) {
    const reason = parsed.line ? `Line ${parsed.line}: ${parsed.reason}` : parsed.reason;
    return {
      ...empty,
      envText: env.text,
      blocking: parsed.unsetVariable
        ? unsetVariableReason(reason, parsed.unsetVariable, source.environment)
        : reason,
    };
  }
  const { project } = parsed;
  if (project.services.length === 0) {
    return { ...empty, envText: env.text, blocking: 'The compose file has no services.' };
  }

  const services = servicePreview(project);
  const canProxy = (name: string) => {
    const service = services.get(name);
    return !!service && service.publishes && !service.hostNetwork;
  };
  const proxied = (proxiedServices ?? [...services.keys()]).filter(canProxy);
  const override = renderLoopbackOverride(project, proxied);
  const rebound = override.ok ? override.override.rebound : [];
  const bindings: ComposePortBinding[] = [];
  for (const [name, service] of services) {
    if (proxied.includes(name)) {
      bindings.push(...rebound.filter((binding) => binding.service === name));
    } else {
      bindings.push(...service.ports);
    }
  }
  const risks = [...lintComposeProject(project, { proxiedServices: proxied, selinuxEnforcing })]
    .map((found, order) => ({ found, order }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.found.severity] - SEVERITY_ORDER[b.found.severity] || a.order - b.order,
    )
    .map(({ found }) => found);

  return {
    ...empty,
    composeName: project.name,
    services: [...services].map(([name, service]) => ({ name, ...service })),
    missingVariables: project.missingVariables.filter((name) => !SHELL_ONLY.has(name)),
    proxiedServices: proxied,
    bindings,
    overrideText: override.ok ? override.override.text : '',
    risks,
    requiresAcknowledgment: needsAcknowledgment(risks),
    buildContext: buildContextReason(project),
    projectFiles: projectFilesOf(project),
    sourceBlocking: sourceBlocking(project),
    blocking: override.ok ? null : override.reason,
    envText: env.text,
    project,
  };
}

/**
 * A required variable with no value, said in terms of what the user picked. The compose file's
 * own message usually says to set it in .env, but Runova only sends the environment picked in
 * the wizard, never the .env files in the project folder, so the fix is in that pick.
 */
function unsetVariableReason(
  reason: string,
  name: string,
  environment: ResolvedProjectEnvironment | null,
): string {
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  if (!environment) {
    return `${sentence} No environment is picked for this app, so nothing sets ${name}. Go back to Source and pick the environment that holds your .env values.`;
  }
  if (environment.files.length === 0) {
    return `${sentence} The environment ${environment.name} has no files yet, so nothing sets ${name}. Add your .env file to it in the project's Environments tab.`;
  }
  const files = environment.files.map((file) => file.fileName).join(', ');
  return `${sentence} The env files picked from ${environment.name} (${files}) do not set ${name}. Add it in the project's Environments tab, or tick the file that has it.`;
}

/** Every finding but the low ones waits for its own acknowledgment. */
export function needsAcknowledgment(risks: readonly ComposeRisk[]): string[] {
  return risks.filter((found) => found.severity !== 'low').map((found) => found.id);
}
