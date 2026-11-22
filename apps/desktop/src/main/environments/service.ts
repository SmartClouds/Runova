import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  countDotenvKeys,
  type DotenvEntry,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  guessEnvironmentKind,
  isEnvFileName,
  isEnvTemplateFileName,
  MAX_ENV_FILE_BYTES,
  type Project,
  parseDotenv,
} from '@runova/core';
import type {
  EnvCredentialSecrets,
  EnvFileOrigin,
  EnvFileVersionSummary,
  EnvFolderFile,
  EnvImportPick,
  EnvImportResult,
  EnvLinkPreview,
  EnvWriteResult,
  LinkEnvFileInput,
  ProjectEnvironment,
  SaveEnvCredentialInput,
  SaveEnvFileInput,
  SaveEnvironmentInput,
  SecretEnvelope,
  StoredEnvCredential,
  StoredEnvFile,
  StoredEnvFileVersion,
  StoredProjectEnvironment,
} from '../../shared/apiTypes';
import { envFileHistoryDb } from '../envFileHistoryDb';
import { gitOrNull, isGitRepo } from '../git/plumbing';
import { pruneOrphanHealthTargets } from '../health/store';
import { decryptSecret, encryptSecret } from '../ssh/vault';
import { store } from '../store';
import type { LinkedEnvFile, LinkUpdateOutcome } from './fileLinks';
import { envFileLinkState, setEnvFileLinkState } from './linkStates';

/**
 * A project's environments: named sets of env files and credentials, kept encrypted in
 * project-environments.json with every replaced file version in the history database. The
 * Environments tab (through IPC) and AI access both work through these functions, so every change
 * takes the same queue, the same checks and the same history.
 */

const MAX_NAME_LENGTH = 60;

export function toPublicEnvironment(environment: StoredProjectEnvironment): ProjectEnvironment {
  const versionCounts = envFileHistoryDb.countByFile(environment.files.map((file) => file.id));
  return {
    ...environment,
    files: environment.files.map(({ contentEnvelope: _content, link, ...file }) => ({
      ...file,
      versionCount: versionCounts.get(file.id) ?? 0,
      ...(link ? { link: { path: link.path, state: envFileLinkState(file.id) } } : {}),
    })),
    credentials: environment.credentials.map(
      ({ secretEnvelope, notesEnvelope, ...credential }) => ({
        ...credential,
        hasSecret: secretEnvelope != null,
        hasNotes: notesEnvelope != null,
      }),
    ),
  };
}

/**
 * Every change reads the whole list, edits it and writes it back, so two quick saves would
 * otherwise race and one would be lost. Running them one after another avoids that.
 */
let updateQueue: Promise<unknown> = Promise.resolve();

function mutate<T>(
  change: (environments: StoredProjectEnvironment[]) => Promise<T> | T,
  /** Says whether the change touched anything worth writing; a check that found nothing doesn't. */
  changed: (result: T) => boolean = () => true,
): Promise<T> {
  const next = updateQueue.then(async () => {
    const environments = await store.getProjectEnvironments();
    const result = await change(environments);
    if (changed(result)) await store.setProjectEnvironments(environments);
    return result;
  });
  updateQueue = next.catch(() => undefined);
  return next;
}

/** An environment's files read back in plain text, for the main process only. */
export interface ResolvedEnvFile {
  fileName: string;
  entries: DotenvEntry[];
}

export interface ResolvedProjectEnvironment {
  id: string;
  name: string;
  /** In the order they are kept, which is the order they apply in. */
  files: ResolvedEnvFile[];
  /** Every key once, the last file that sets it winning, in first-seen order. */
  entries: Array<Pick<DotenvEntry, 'key' | 'value'>>;
}

/**
 * The decrypted entries of one of a project's environments. Only main-process callers (the
 * Apps deploy) use it; nothing here is ever sent to the renderer. It waits for saves already
 * queued, so it reads what the Environments tab shows once they land. `fileIds` keeps only those
 * files (still in the environment's order, and the others are never decrypted); left out, all apply.
 */
export async function resolveProjectEnvironment(
  projectId: string,
  environmentId: string,
  fileIds?: readonly string[],
): Promise<ResolvedProjectEnvironment> {
  await updateQueue;
  const environment = findEnvironment(await store.getProjectEnvironments(), environmentId);
  if (environment.projectId !== projectId) {
    throw new Error('That environment belongs to another project.');
  }
  let picked = environment.files;
  if (fileIds) {
    if (fileIds.length === 0) throw new Error("Pick at least one of the environment's files.");
    const known = new Set(environment.files.map((file) => file.id));
    if (fileIds.some((id) => !known.has(id))) {
      throw new Error('One of the picked env files is no longer in the environment.');
    }
    const wanted = new Set(fileIds);
    picked = environment.files.filter((file) => wanted.has(file.id));
  }
  const files: ResolvedEnvFile[] = [];
  const merged = new Map<string, string>();
  for (const file of picked) {
    const entries = parseDotenv(await decryptSecret(file.contentEnvelope));
    files.push({ fileName: file.fileName, entries });
    for (const { key, value } of entries) merged.set(key, value);
  }
  return {
    id: environment.id,
    name: environment.name,
    files,
    entries: [...merged].map(([key, value]) => ({ key, value })),
  };
}

function findEnvironment(
  environments: StoredProjectEnvironment[],
  id: string,
): StoredProjectEnvironment {
  const environment = environments.find((e) => e.id === id);
  if (!environment) throw new Error('That environment no longer exists.');
  return environment;
}

async function readEnvironment(id: string): Promise<StoredProjectEnvironment> {
  return findEnvironment(await store.getProjectEnvironments(), id);
}

function findFile(environment: StoredProjectEnvironment, fileId: string): StoredEnvFile {
  const file = environment.files.find((f) => f.id === fileId);
  if (!file) throw new Error('That env file no longer exists.');
  return file;
}

function findCredential(
  environment: StoredProjectEnvironment,
  credentialId: string,
): StoredEnvCredential {
  const credential = environment.credentials.find((c) => c.id === credentialId);
  if (!credential) throw new Error('That credential no longer exists.');
  return credential;
}

function findVersion(fileId: string, versionId: string): StoredEnvFileVersion {
  const version = envFileHistoryDb.get(fileId, versionId);
  if (!version) throw new Error('That version is no longer in the history.');
  return version;
}

/** Puts `file` as it is now into its history, just before a save replaces it. */
function keepVersion(
  environment: StoredProjectEnvironment,
  file: StoredEnvFile,
  replacedAt: number,
): void {
  envFileHistoryDb.add({
    projectId: environment.projectId,
    environmentId: environment.id,
    fileId: file.id,
    fileName: file.fileName,
    keyCount: file.keyCount,
    origin: file.origin,
    savedAt: file.updatedAt,
    replacedAt,
    contentEnvelope: file.contentEnvelope,
  });
}

/**
 * Replaces `environment.files[index]` with `content`, or adds a new file when index is -1. The
 * version it replaces goes into the history first, unless nothing actually changed, in which case
 * the file is left exactly as it was. A save that only changes the name counts as a rename.
 * Encrypting happens before the history is touched, so a locked vault leaves no stray version.
 */
async function writeFileRecord(
  environment: StoredProjectEnvironment,
  index: number,
  fileName: string,
  content: string,
  origin: EnvFileOrigin,
): Promise<void> {
  const existing = index >= 0 ? environment.files[index] : undefined;
  let nextOrigin = origin;
  if (existing) {
    const contentChanged = (await decryptSecret(existing.contentEnvelope)) !== content;
    const renamed = existing.fileName !== fileName;
    if (!contentChanged && !renamed) return;
    if (!contentChanged) nextOrigin = 'renamed';
  }
  const record: StoredEnvFile = {
    id: existing?.id ?? randomUUID(),
    fileName,
    keyCount: countDotenvKeys(content),
    origin: nextOrigin,
    contentEnvelope: await encryptSecret(content),
    updatedAt: Date.now(),
    // A linked file stays linked through every save, whatever caused it.
    ...(existing?.link ? { link: existing.link } : {}),
  };
  if (existing) {
    keepVersion(environment, existing, record.updatedAt);
    environment.files[index] = record;
  } else {
    environment.files.push(record);
  }
  environment.updatedAt = record.updatedAt;
}

async function requireProject(projectId: string): Promise<Project> {
  const project = (await store.getProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error('That project no longer exists.');
  return project;
}

function cleanName(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('Give the environment a name.');
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function cleanKind(kind: string): EnvironmentKind {
  return (ENVIRONMENT_KINDS as readonly string[]).includes(kind)
    ? (kind as EnvironmentKind)
    : 'custom';
}

function assertFileName(fileName: string): void {
  if (!isEnvFileName(fileName)) {
    throw new Error('Use a file name like .env or .env.production, without folders.');
  }
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, 'utf-8') > MAX_ENV_FILE_BYTES) {
    throw new Error('That file is larger than 1 MB.');
  }
}

function newEnvironment(
  environments: StoredProjectEnvironment[],
  projectId: string,
  name: string,
  kind: EnvironmentKind,
): StoredProjectEnvironment {
  const siblings = environments.filter((e) => e.projectId === projectId);
  const now = Date.now();
  const environment: StoredProjectEnvironment = {
    id: randomUUID(),
    projectId,
    name: cleanName(name),
    kind: cleanKind(kind),
    order: siblings.reduce((max, e) => Math.max(max, e.order + 1), 0),
    files: [],
    credentials: [],
    createdAt: now,
    updatedAt: now,
  };
  environments.push(environment);
  return environment;
}

/** Adds the file, or replaces the contents of one with the same name. */
async function upsertFileByName(
  environment: StoredProjectEnvironment,
  fileName: string,
  content: string,
): Promise<void> {
  const index = environment.files.findIndex((f) => f.fileName === fileName);
  await writeFileRecord(environment, index, fileName, content, 'imported');
}

/** undefined keeps the stored value, an empty string removes it, anything else replaces it. */
async function nextEnvelope(
  value: string | undefined,
  current: SecretEnvelope | undefined,
): Promise<SecretEnvelope | undefined> {
  if (value === undefined) return current;
  if (value === '') return undefined;
  return encryptSecret(value);
}

export async function listEnvironments(projectId: string): Promise<ProjectEnvironment[]> {
  return (await store.getProjectEnvironments())
    .filter((e) => e.projectId === projectId)
    .sort((a, b) => a.order - b.order)
    .map(toPublicEnvironment);
}

export function saveEnvironment(input: SaveEnvironmentInput): Promise<ProjectEnvironment> {
  return mutate(async (environments) => {
    if (!input.id) {
      await requireProject(input.projectId);
      return toPublicEnvironment(
        newEnvironment(environments, input.projectId, input.name, input.kind),
      );
    }
    const environment = findEnvironment(environments, input.id);
    environment.name = cleanName(input.name);
    environment.kind = cleanKind(input.kind);
    environment.updatedAt = Date.now();
    return toPublicEnvironment(environment);
  });
}

export async function removeEnvironment(id: string): Promise<void> {
  await mutate((environments) => {
    const index = environments.findIndex((e) => e.id === id);
    if (index >= 0) environments.splice(index, 1);
    envFileHistoryDb.removeForEnvironment(id);
  });
  // A healthcheck of this environment stays, just no longer tied to it.
  await pruneOrphanHealthTargets({ environmentIds: [id] });
}

export function reorderEnvironments(projectId: string, orderedIds: string[]): Promise<void> {
  return mutate((environments) => {
    for (const environment of environments) {
      if (environment.projectId !== projectId) continue;
      const position = orderedIds.indexOf(environment.id);
      if (position >= 0) environment.order = position;
    }
  });
}

export async function saveEnvFile(input: SaveEnvFileInput): Promise<ProjectEnvironment> {
  const { saved, write } = await mutate(async (environments) => {
    const environment = findEnvironment(environments, input.environmentId);
    assertFileName(input.fileName);
    assertContentSize(input.content);
    const clash = environment.files.find((f) => f.fileName === input.fileName && f.id !== input.id);
    if (clash) throw new Error(`${input.fileName} is already saved in this environment.`);

    const index = input.id ? environment.files.findIndex((f) => f.id === input.id) : -1;
    await writeFileRecord(
      environment,
      index,
      input.fileName,
      input.content,
      index >= 0 ? 'edited' : 'created',
    );
    const record = environment.files[index >= 0 ? index : environment.files.length - 1];
    return {
      saved: toPublicEnvironment(environment),
      write: await linkedWriteFor(environment, record, input.content),
    };
  });
  return write ? afterLinkedWrite(input.environmentId, write) : saved;
}

export function removeEnvFile(environmentId: string, fileId: string): Promise<void> {
  return mutate((environments) => {
    const environment = findEnvironment(environments, environmentId);
    environment.files = environment.files.filter((f) => f.id !== fileId);
    environment.updatedAt = Date.now();
    envFileHistoryDb.removeForFile(fileId);
    setEnvFileLinkState(fileId, undefined);
  });
}

export async function readEnvFile(environmentId: string, fileId: string): Promise<string> {
  const file = findFile(await readEnvironment(environmentId), fileId);
  return decryptSecret(file.contentEnvelope);
}

export async function envFileHistory(
  environmentId: string,
  fileId: string,
): Promise<EnvFileVersionSummary[]> {
  // Wait for saves already queued, so a version they add is in the list.
  await updateQueue;
  findFile(await readEnvironment(environmentId), fileId);
  return envFileHistoryDb.list(fileId);
}

export async function readEnvFileVersion(
  environmentId: string,
  fileId: string,
  versionId: string,
): Promise<string> {
  findFile(await readEnvironment(environmentId), fileId);
  return decryptSecret(findVersion(fileId, versionId).contentEnvelope);
}

export async function restoreEnvFileVersion(
  environmentId: string,
  fileId: string,
  versionId: string,
): Promise<ProjectEnvironment> {
  const { saved, write } = await mutate(async (environments) => {
    const environment = findEnvironment(environments, environmentId);
    const index = environment.files.findIndex((f) => f.id === fileId);
    if (index < 0) throw new Error('That env file no longer exists.');
    const content = await decryptSecret(findVersion(fileId, versionId).contentEnvelope);
    // The contents come back; the file keeps the name it has today.
    const { fileName } = environment.files[index];
    await writeFileRecord(environment, index, fileName, content, 'restored');
    return {
      saved: toPublicEnvironment(environment),
      write: await linkedWriteFor(environment, environment.files[index], content),
    };
  });
  return write ? afterLinkedWrite(environmentId, write) : saved;
}

export function saveEnvCredential(input: SaveEnvCredentialInput): Promise<ProjectEnvironment> {
  return mutate(async (environments) => {
    const environment = findEnvironment(environments, input.environmentId);
    const label = String(input.label ?? '').trim();
    if (!label) throw new Error('Give the credential a label.');
    const existing = input.id ? findCredential(environment, input.id) : undefined;

    const record: StoredEnvCredential = {
      id: existing?.id ?? randomUUID(),
      label: label.slice(0, 120),
      username: String(input.username ?? '').trim(),
      url: String(input.url ?? '').trim(),
      secretEnvelope: await nextEnvelope(input.secret, existing?.secretEnvelope),
      notesEnvelope: await nextEnvelope(input.notes, existing?.notesEnvelope),
      updatedAt: Date.now(),
    };
    const index = environment.credentials.findIndex((c) => c.id === record.id);
    if (index >= 0) environment.credentials[index] = record;
    else environment.credentials.push(record);
    environment.updatedAt = record.updatedAt;
    return toPublicEnvironment(environment);
  });
}

export function removeEnvCredential(environmentId: string, credentialId: string): Promise<void> {
  return mutate((environments) => {
    const environment = findEnvironment(environments, environmentId);
    environment.credentials = environment.credentials.filter((c) => c.id !== credentialId);
    environment.updatedAt = Date.now();
  });
}

export async function revealEnvCredential(
  environmentId: string,
  credentialId: string,
): Promise<EnvCredentialSecrets> {
  const credential = findCredential(await readEnvironment(environmentId), credentialId);
  return {
    secret: credential.secretEnvelope ? await decryptSecret(credential.secretEnvelope) : '',
    notes: credential.notesEnvelope ? await decryptSecret(credential.notesEnvelope) : '',
  };
}

/** The saved password of a credential, or an error when it has none. */
export async function envCredentialSecret(
  environmentId: string,
  credentialId: string,
): Promise<string> {
  const credential = findCredential(await readEnvironment(environmentId), credentialId);
  if (!credential.secretEnvelope) throw new Error('No password is saved for that credential.');
  return decryptSecret(credential.secretEnvelope);
}

export async function scanEnvFolder(projectId: string): Promise<EnvFolderFile[]> {
  const project = await requireProject(projectId);
  const saved = (await store.getProjectEnvironments()).filter((e) => e.projectId === projectId);
  const entries = await readdir(project.folderPath, { withFileTypes: true });
  const files: EnvFolderFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isEnvFileName(entry.name)) continue;
    const { size } = await stat(join(project.folderPath, entry.name));
    files.push({
      fileName: entry.name,
      size,
      guessedKind: guessEnvironmentKind(entry.name),
      isTemplate: isEnvTemplateFileName(entry.name),
      tooLarge: size > MAX_ENV_FILE_BYTES,
      savedInEnvironmentId: saved.find((e) => e.files.some((f) => f.fileName === entry.name))?.id,
    });
  }
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function importEnvFromFolder(
  projectId: string,
  picks: EnvImportPick[],
): Promise<EnvImportResult> {
  const project = await requireProject(projectId);
  return mutate(async (environments) => {
    const errors: string[] = [];
    let imported = 0;
    // Several files can ask for the same new environment; they should land in one.
    const created = new Map<string, StoredProjectEnvironment>();

    for (const pick of picks) {
      try {
        assertFileName(pick.fileName);
        const path = join(project.folderPath, pick.fileName);
        if ((await stat(path)).size > MAX_ENV_FILE_BYTES) {
          throw new Error('it is larger than 1 MB');
        }
        const content = await readFile(path, 'utf-8');

        let target: StoredProjectEnvironment;
        if (pick.environmentId) {
          target = findEnvironment(environments, pick.environmentId);
          if (target.projectId !== projectId) throw new Error('wrong project');
        } else if (pick.newEnvironment) {
          const key = `${pick.newEnvironment.kind}:${pick.newEnvironment.name.trim().toLowerCase()}`;
          target =
            created.get(key) ??
            newEnvironment(
              environments,
              projectId,
              pick.newEnvironment.name,
              pick.newEnvironment.kind,
            );
          created.set(key, target);
        } else {
          throw new Error('no environment chosen');
        }

        await upsertFileByName(target, pick.fileName, content);
        if (pick.link) {
          const record = target.files.find((f) => f.fileName === pick.fileName);
          if (record) record.link = { path: pick.fileName, linkedAt: Date.now() };
        }
        imported++;
      } catch (error) {
        errors.push(`${pick.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { imported, errors };
  });
}

export async function writeEnvToFolder(
  environmentId: string,
  fileId: string,
  overwrite: boolean,
): Promise<EnvWriteResult> {
  const environment = await readEnvironment(environmentId);
  const file = findFile(environment, fileId);
  const project = await requireProject(environment.projectId);
  assertFileName(file.fileName);
  const path = join(project.folderPath, file.fileName);

  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (exists && !overwrite) return { status: 'exists', path };

  await writeFile(path, await decryptSecret(file.contentEnvelope), 'utf-8');

  // `check-ignore` exits non-zero when the path is not ignored, which gitOrNull turns into null.
  const notIgnored =
    (await isGitRepo(project.folderPath)) &&
    (await gitOrNull(project.folderPath, ['check-ignore', '-q', '--', file.fileName])) === null;
  return { status: 'written', path, notIgnored };
}

/* Linked files: a saved env file that follows a file in the project folder (see fileLinks.ts). */

/** The link's path and where it points, checked to stay inside the project folder. */
function resolveInProject(folder: string, path: string): { absolute: string; relative: string } {
  const absolute = resolve(folder, String(path ?? ''));
  const inside = relative(folder, absolute);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('Pick a file inside the project folder.');
  }
  return { absolute, relative: inside.split(sep).join('/') };
}

async function projectFolderOf(projectId: string): Promise<string> {
  const { folderPath } = await requireProject(projectId);
  if (!folderPath) throw new Error('This project has no folder on this computer.');
  return folderPath;
}

/** The contents of a file about to be linked, with a message fit to show when it won't do. */
async function readLinkTarget(absolute: string, shown: string): Promise<string> {
  const info = await stat(absolute).catch(() => null);
  if (!info) throw new Error(`${shown} is not in the project folder.`);
  if (info.isDirectory()) throw new Error(`${shown} is a folder.`);
  if (info.size > MAX_ENV_FILE_BYTES) throw new Error('That file is larger than 1 MB.');
  return readFile(absolute, 'utf-8');
}

/** A path picked anywhere, as the link would keep it, or an error when it is outside the project. */
export async function envLinkPathFor(projectId: string, absolutePath: string): Promise<string> {
  return resolveInProject(await projectFolderOf(projectId), absolutePath).relative;
}

export async function inspectEnvLinkFile(
  environmentId: string,
  fileId: string,
  path: string,
): Promise<EnvLinkPreview> {
  const environment = await readEnvironment(environmentId);
  const file = findFile(environment, fileId);
  const target = resolveInProject(await projectFolderOf(environment.projectId), path);
  const content = await readLinkTarget(target.absolute, target.relative);
  return {
    path: target.relative,
    keyCount: countDotenvKeys(content),
    sameAsSaved: (await decryptSecret(file.contentEnvelope)) === content,
  };
}

/**
 * Links a saved env file to a file in the project. The saved copy takes the file's contents right
 * away (what it held goes into the history) and follows the file from then on.
 */
export function linkEnvFile(input: LinkEnvFileInput): Promise<ProjectEnvironment> {
  return mutate(async (environments) => {
    const environment = findEnvironment(environments, input.environmentId);
    const index = environment.files.findIndex((f) => f.id === input.fileId);
    if (index < 0) throw new Error('That env file no longer exists.');
    const target = resolveInProject(await projectFolderOf(environment.projectId), input.path);
    const content = await readLinkTarget(target.absolute, target.relative);
    const { fileName } = environment.files[index];
    await writeFileRecord(environment, index, fileName, content, 'linked');
    environment.files[index].link = { path: target.relative, linkedAt: Date.now() };
    environment.updatedAt = Date.now();
    setEnvFileLinkState(input.fileId, 'watching');
    return toPublicEnvironment(environment);
  });
}

/** Stops following the file. The saved contents and their history stay as they are. */
export function unlinkEnvFile(environmentId: string, fileId: string): Promise<ProjectEnvironment> {
  return mutate((environments) => {
    const environment = findEnvironment(environments, environmentId);
    const file = findFile(environment, fileId);
    delete file.link;
    environment.updatedAt = Date.now();
    setEnvFileLinkState(fileId, undefined);
    return toPublicEnvironment(environment);
  });
}

/** Every linked file of every project, where it sits on this computer. */
export async function linkedEnvFiles(): Promise<LinkedEnvFile[]> {
  const [projects, environments] = await Promise.all([
    store.getProjects(),
    store.getProjectEnvironments(),
  ]);
  const folders = new Map(projects.map((project) => [project.id, project.folderPath]));
  const linked: LinkedEnvFile[] = [];
  for (const environment of environments) {
    if (!folders.has(environment.projectId)) continue;
    const folder = folders.get(environment.projectId);
    for (const file of environment.files) {
      if (!file.link) continue;
      let path: string | null = null;
      if (folder) {
        try {
          path = resolveInProject(folder, file.link.path).absolute;
        } catch {
          // A link that points outside the folder (from a damaged sync) is never followed.
          continue;
        }
      }
      linked.push({
        projectId: environment.projectId,
        environmentId: environment.id,
        fileId: file.id,
        path,
      });
    }
  }
  return linked;
}

/**
 * Reads a linked file into its saved copy, keeping what it replaces in the history. Throws while
 * the vault is locked, so the link manager can wait for the unlock.
 */
export function updateEnvFileFromDisk(linked: LinkedEnvFile): Promise<LinkUpdateOutcome> {
  return mutate<LinkUpdateOutcome>(
    async (environments) => {
      const environment = environments.find((e) => e.id === linked.environmentId);
      const index = environment?.files.findIndex((f) => f.id === linked.fileId) ?? -1;
      const record = environment?.files[index];
      if (!environment || !record?.link) return 'gone';
      const project = (await store.getProjects()).find((p) => p.id === environment.projectId);
      if (!project?.folderPath) return 'gone';
      const { absolute } = resolveInProject(project.folderPath, record.link.path);

      const info = await stat(absolute).catch(() => null);
      if (!info || info.isDirectory()) return 'missing';
      if (info.size > MAX_ENV_FILE_BYTES) return 'tooLarge';
      const content = await readFile(absolute, 'utf-8');
      await writeFileRecord(environment, index, record.fileName, content, 'fileChanged');
      return environment.files[index] === record ? 'unchanged' : 'updated';
    },
    (outcome) => outcome === 'updated',
  );
}

interface LinkedWrite {
  fileId: string;
  /** Absolute. */
  path: string;
  /** As the link keeps it, for messages. */
  shown: string;
  content: string;
}

/** Where a save of a linked file has to go, or null for a file that isn't linked. */
async function linkedWriteFor(
  environment: StoredProjectEnvironment,
  file: StoredEnvFile,
  content: string,
): Promise<LinkedWrite | null> {
  if (!file.link) return null;
  const target = resolveInProject(await projectFolderOf(environment.projectId), file.link.path);
  return { fileId: file.id, path: target.absolute, shown: file.link.path, content };
}

function writeFailure(error: unknown): string {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case 'EISDIR':
      return 'a folder has that name';
    case 'ENOENT':
      return 'its folder is gone';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EBUSY':
      return 'another program has it open';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

const linkedWriteListeners = new Set<(fileId: string) => void>();

/** Runs `listener` after Runova itself wrote a linked file, so its watcher can take note. */
export function onLinkedFileWritten(listener: (fileId: string) => void): () => void {
  linkedWriteListeners.add(listener);
  return () => linkedWriteListeners.delete(listener);
}

/**
 * Writes a saved linked file out to the project. The save itself already happened; a failed
 * write says so, and the link shows the error until the next good write or change on disk.
 */
async function afterLinkedWrite(
  environmentId: string,
  write: LinkedWrite,
): Promise<ProjectEnvironment> {
  try {
    await writeFile(write.path, write.content, 'utf-8');
  } catch (error) {
    setEnvFileLinkState(write.fileId, 'error');
    throw new Error(`Saved in Runova, but couldn't write ${write.shown}: ${writeFailure(error)}.`);
  }
  setEnvFileLinkState(write.fileId, 'watching');
  for (const listener of linkedWriteListeners) listener(write.fileId);
  return toPublicEnvironment(await readEnvironment(environmentId));
}
