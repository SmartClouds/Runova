import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getCliDefinition } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeEditDenyRule,
  claudeExtraDirectories,
  writeScopeArgs,
  writeScopeNote,
} from './writeScope';

/**
 * A version bump started in one project (MyWebSite) rewrote the version across another one
 * (CuraLink), because Claude Code's user settings listed CuraLink as an extra working directory
 * and `acceptEdits` approves edits in all of them. These pin the guard that fences it off.
 */

let root: string;
let configDir: string;
let project: string;
let otherProject: string;
let env: NodeJS.ProcessEnv;

async function writeSettings(dir: string, file: string, additionalDirectories: unknown) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), JSON.stringify({ permissions: { additionalDirectories } }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'runova-write-scope-'));
  configDir = path.join(root, 'claude-config');
  project = path.join(root, 'MyWebSite');
  otherProject = path.join(root, 'CuraLink');
  await mkdir(project, { recursive: true });
  await mkdir(otherProject, { recursive: true });
  env = { CLAUDE_CONFIG_DIR: configDir };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('claudeEditDenyRule', () => {
  it('writes a Windows folder the way Claude Code matches it', () => {
    expect(claudeEditDenyRule('e:\\CuraLink')).toBe('Edit(//e/CuraLink/**)');
    expect(claudeEditDenyRule('E:\\CuraLink\\')).toBe('Edit(//e/CuraLink/**)');
    expect(claudeEditDenyRule('C:/Users/me/work')).toBe('Edit(//c/Users/me/work/**)');
  });

  it('writes a POSIX folder as an absolute rule', () => {
    expect(claudeEditDenyRule('/Users/me/CuraLink')).toBe('Edit(//Users/me/CuraLink/**)');
    expect(claudeEditDenyRule('/Users/me/CuraLink/')).toBe('Edit(//Users/me/CuraLink/**)');
  });
});

describe('claudeExtraDirectories', () => {
  it('finds another project listed in the user settings', async () => {
    await writeSettings(configDir, 'settings.json', [otherProject]);
    expect(await claudeExtraDirectories(project, env)).toEqual([otherProject]);
  });

  it('reads the project settings too, and lists each folder once', async () => {
    await writeSettings(configDir, 'settings.json', [otherProject]);
    await writeSettings(path.join(project, '.claude'), 'settings.local.json', [
      otherProject,
      path.join(root, 'shared'),
    ]);
    expect(await claudeExtraDirectories(project, env)).toEqual([
      otherProject,
      path.join(root, 'shared'),
    ]);
  });

  it('leaves out folders inside the project and folders that hold it', async () => {
    // Denying a parent of the project would deny the project itself.
    await writeSettings(configDir, 'settings.json', [project, path.join(project, 'docs'), root]);
    expect(await claudeExtraDirectories(project, env)).toEqual([]);
  });

  it('is empty when there are no settings or they are not JSON', async () => {
    expect(await claudeExtraDirectories(project, env)).toEqual([]);
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'settings.json'), '{ not json');
    expect(await claudeExtraDirectories(project, env)).toEqual([]);
  });
});

describe('writeScopeArgs', () => {
  const claude = getCliDefinition('claude-code');
  const codex = getCliDefinition('codex-cli');
  if (!claude || !codex) throw new Error('registry is missing a CLI these tests use');

  it('denies Claude Code every edit in another project it can reach', async () => {
    await writeSettings(configDir, 'settings.json', [otherProject]);
    expect(await writeScopeArgs(claude, project, env)).toEqual([
      '--disallowedTools',
      claudeEditDenyRule(otherProject),
    ]);
  });

  it('adds nothing when Claude Code has no extra folders', async () => {
    expect(await writeScopeArgs(claude, project, env)).toEqual([]);
  });

  it('adds nothing for a CLI that does not read Claude Code settings', async () => {
    await writeSettings(configDir, 'settings.json', [otherProject]);
    expect(await writeScopeArgs(codex, project, env)).toEqual([]);
  });
});

describe('writeScopeNote', () => {
  it('names the project folder and rules out every other one', () => {
    const note = writeScopeNote(project);
    expect(note).toContain(`project folder ${project}.`);
    expect(note).toMatch(/Only create, edit or delete files inside that folder/);
    expect(note).toMatch(/never change anything there/);
    expect(note).not.toContain('\u2014');
  });
});
