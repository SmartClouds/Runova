import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoredProjectEnvironment } from '../../../shared/apiTypes';
import { tempDir } from '../../../test/main/fixtures';
import { useTempUserData } from '../../../test/main/ipcHarness';
import { closeSqliteHandlesAfterEach } from '../../../test/main/sqliteHandles';
import type { AiTool, ToolContext } from '../registry';

/**
 * The environment tools an agent uses to read and change a project's env files: the same saves,
 * history and encryption as the Environments tab, with the approval showing what changes.
 */

const userData = useTempUserData();
closeSqliteHandlesAfterEach();

const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let folder: string;
let tools: Map<string, AiTool>;
let service: typeof import('../../environments/service');

beforeEach(async () => {
  folder = tempDir('ai-env-');
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: folder, createdAt: '2026-01-01T00:00:00Z' },
    {
      id: 'p2',
      name: 'Blog',
      folderPath: tempDir('ai-env-other-'),
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
  service = await import('../../environments/service');
  const { environmentTools } = await import('./environments');
  tools = new Map(environmentTools.map((tool) => [tool.name, tool]));
});

function tool(name: string): AiTool {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

async function run(name: string, args: Record<string, unknown>, ctx = context) {
  const parsed = tool(name).input.parse(args);
  return tool(name).run(parsed, ctx);
}

async function preview(name: string, args: Record<string, unknown>) {
  return tool(name).preview(tool(name).input.parse(args), context);
}

function stored(): StoredProjectEnvironment[] {
  return JSON.parse(readFileSync(userData.dataFile('project-environments.json'), 'utf-8'));
}

async function staging() {
  return service.saveEnvironment({ projectId: 'p1', name: 'Staging', kind: 'staging' });
}

describe('env_list', () => {
  it('lists the project environments with their files and no secrets', async () => {
    const env = await staging();
    await service.saveEnvFile({ environmentId: env.id, fileName: '.env', content: 'A=1\nB=2\n' });
    await service.saveEnvCredential({
      environmentId: env.id,
      label: 'DB',
      username: 'app',
      url: '',
      secret: 'hunter2',
    });

    const result = await run('env_list', {});

    expect(result.data).toEqual([
      expect.objectContaining({
        id: env.id,
        name: 'Staging',
        kind: 'staging',
        files: [expect.objectContaining({ fileName: '.env', keyCount: 2 })],
        credentials: [expect.objectContaining({ label: 'DB', hasSecret: true })],
      }),
    ]);
    expect(JSON.stringify(result.data)).not.toContain('hunter2');
    expect(JSON.stringify(result.data)).not.toContain('A=1');
  });
});

describe('env_save_file', () => {
  it('replaces a file found by environment name, keeping the old version in the history', async () => {
    const env = await staging();
    await service.saveEnvFile({ environmentId: env.id, fileName: '.env', content: 'A=1\n' });

    const result = await run('env_save_file', {
      environment: 'staging',
      fileName: '.env',
      content: 'A=2\nB=3\n',
    });

    expect(result.text).toContain('Saved .env in Staging (2 keys)');
    const [file] = (await service.listEnvironments('p1'))[0].files;
    expect(await service.readEnvFile(env.id, file.id)).toBe('A=2\nB=3\n');
    expect(await service.envFileHistory(env.id, file.id)).toHaveLength(1);
    // Still encrypted on disk.
    expect(JSON.stringify(stored())).not.toContain('B=3');
  });

  it('adds a new file, and creates the environment when asked to', async () => {
    const result = await run('env_save_file', {
      environment: 'Production',
      fileName: '.env.production',
      content: 'X=1',
      createEnvironment: true,
    });

    expect(result.text).toContain('Created the Production environment');
    const [env] = await service.listEnvironments('p1');
    expect(env).toMatchObject({ name: 'Production', kind: 'production' });
    expect(env.files.map((file) => file.fileName)).toEqual(['.env.production']);
  });

  it('names the environments there are when it cannot find the one asked for', async () => {
    await staging();
    await expect(
      run('env_save_file', { environment: 'qa', fileName: '.env', content: 'A=1' }),
    ).rejects.toThrow(/No environment named qa.*Staging/);
  });

  it('shows the change as a diff with the values marked secret', async () => {
    const env = await staging();
    await service.saveEnvFile({ environmentId: env.id, fileName: '.env', content: 'A=1\n' });

    const shown = await preview('env_save_file', {
      environment: 'Staging',
      fileName: '.env',
      content: 'A=2\n',
    });

    expect(shown).toMatchObject({
      title: 'Update .env in Staging',
      diff: { fileName: '.env', before: 'A=1\n', after: 'A=2\n', secret: true },
    });
    expect(
      (
        await preview('env_save_file', {
          environment: 'Staging',
          fileName: '.env.local',
          content: 'B=1',
        })
      ).title,
    ).toBe('Create .env.local in Staging');
  });

  it('works on the project the call names, not only the tab project', async () => {
    const other = await service.saveEnvironment({
      projectId: 'p2',
      name: 'Dev',
      kind: 'development',
    });
    await run(
      'env_save_file',
      { projectId: 'p2', environment: 'Dev', fileName: '.env', content: 'A=1' },
      {
        ...context,
        projectId: 'p2',
      },
    );
    expect((await service.listEnvironments('p2'))[0].files).toHaveLength(1);
    expect(other.projectId).toBe('p2');
  });
});

describe('env_import_file', () => {
  it('saves a file from disk under its own name, so "update it with this file" works', async () => {
    const env = await staging();
    await service.saveEnvFile({ environmentId: env.id, fileName: '.env', content: 'A=1\n' });
    const source = join(folder, 'new-values.env');
    writeFileSync(source, 'A=9\nC=4\n');

    const shown = await preview('env_import_file', {
      environment: 'Staging',
      path: 'new-values.env',
      fileName: '.env',
    });
    expect(shown.diff).toMatchObject({ before: 'A=1\n', after: 'A=9\nC=4\n' });
    expect(shown.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'From', value: source })]),
    );

    await run('env_import_file', { environment: 'Staging', path: source, fileName: '.env' });

    const [file] = (await service.listEnvironments('p1'))[0].files;
    expect(await service.readEnvFile(env.id, file.id)).toBe('A=9\nC=4\n');
  });

  it('takes the name from the file when it is already an env file name', async () => {
    await staging();
    writeFileSync(join(folder, '.env.local'), 'L=1');

    await run('env_import_file', { environment: 'Staging', path: '.env.local' });

    expect((await service.listEnvironments('p1'))[0].files[0].fileName).toBe('.env.local');
  });

  it('refuses a missing file and a name that is not an env file name', async () => {
    await staging();
    await expect(
      run('env_import_file', { environment: 'Staging', path: 'nope.env' }),
    ).rejects.toThrow(/Could not read/);
    writeFileSync(join(folder, 'values.txt'), 'A=1');
    await expect(
      run('env_import_file', { environment: 'Staging', path: 'values.txt' }),
    ).rejects.toThrow(/fileName/);
  });
});

describe('env_read_file and history', () => {
  it('reads a file, lists its versions and restores one', async () => {
    const env = await staging();
    await service.saveEnvFile({ environmentId: env.id, fileName: '.env', content: 'A=1\n' });
    await run('env_save_file', { environment: 'Staging', fileName: '.env', content: 'A=2\n' });

    expect((await run('env_read_file', { environment: 'Staging', fileName: '.env' })).text).toBe(
      'A=2\n',
    );

    const history = (await run('env_history', { environment: 'Staging', fileName: '.env' }))
      .data as {
      id: string;
    }[];
    expect(history).toHaveLength(1);

    const shown = await preview('env_restore_version', {
      environment: 'Staging',
      fileName: '.env',
      versionId: history[0].id,
    });
    expect(shown.diff).toMatchObject({ before: 'A=2\n', after: 'A=1\n' });

    await run('env_restore_version', {
      environment: 'Staging',
      fileName: '.env',
      versionId: history[0].id,
    });
    expect((await run('env_read_file', { environment: 'Staging', fileName: '.env' })).text).toBe(
      'A=1\n',
    );
  });
});

describe('env_remove_file and env_write_to_folder', () => {
  it('writes a saved file into the project folder, refusing to overwrite unless told to', async () => {
    const env = await staging();
    await service.saveEnvFile({ environmentId: env.id, fileName: '.env', content: 'A=1\n' });
    writeFileSync(join(folder, '.env'), 'OLD=1');

    const refused = await run('env_write_to_folder', { environment: 'Staging', fileName: '.env' });
    expect(refused.text).toContain('already exists');
    expect(readFileSync(join(folder, '.env'), 'utf-8')).toBe('OLD=1');

    await run('env_write_to_folder', { environment: 'Staging', fileName: '.env', overwrite: true });
    expect(readFileSync(join(folder, '.env'), 'utf-8')).toBe('A=1\n');
  });

  it('removes a file', async () => {
    const env = await staging();
    await service.saveEnvFile({ environmentId: env.id, fileName: '.env', content: 'A=1\n' });

    expect(
      (await preview('env_remove_file', { environment: 'Staging', fileName: '.env' })).title,
    ).toBe('Delete .env from Staging');
    await run('env_remove_file', { environment: 'Staging', fileName: '.env' });
    expect((await service.listEnvironments('p1'))[0].files).toEqual([]);
  });
});

describe('env_create', () => {
  it('adds an environment with a kind guessed from the name', async () => {
    await run('env_create', { name: 'Production' });
    expect(await service.listEnvironments('p1')).toEqual([
      expect.objectContaining({ name: 'Production', kind: 'production' }),
    ]);
  });
});
