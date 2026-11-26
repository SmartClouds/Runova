import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/main/fixtures';
import type { ResolvedProjectEnvironment } from '../../ipc/environments';
import {
  buildContextReason,
  discoverComposeFiles,
  dockerfilesOf,
  isComposeFileName,
  previewFromSource,
  previewStack,
  projectFilesOf,
  readStackSource,
  type StackSourceDeps,
  sourceBlocking,
} from './compose';

/**
 * What the Apps wizard learns about a project's compose file: found through the file index,
 * read only from inside the project, and previewed with the environment's values, which never
 * come back out.
 */

const SECRET = 'pg-very-secret-1234';

const COMPOSE = `name: shop
services:
  web:
    image: nginx:1.29
    restart: unless-stopped
    ports:
      - "8080:80"
  api:
    build: ./api
    environment:
      DATABASE_URL: postgres://shop:\${DB_PASSWORD}@db/shop
      TOKEN: \${MISSING_TOKEN}
    ports:
      - "3000"
  tools:
    image: busybox
    network_mode: host
`;

function project(folder: string): Project {
  return { id: 'p1', name: 'Shop', folderPath: folder } as Project;
}

function environment(entries: Array<{ key: string; value: string }>): ResolvedProjectEnvironment {
  return {
    id: 'e1',
    name: 'Production',
    files: [{ fileName: '.env', entries: entries.map((entry, i) => ({ ...entry, line: i + 1 })) }],
    entries,
  };
}

function deps(folder: string, files: string[] = [], env = environment([])): StackSourceDeps {
  return {
    project: async (id) => {
      if (id !== 'p1') throw new Error('That project no longer exists.');
      return project(folder);
    },
    index: async (root) => ({ root, files, truncated: false }),
    environment: async () => env,
  };
}

function folderWith(files: Record<string, string>): string {
  const folder = tempDir('runova-stack-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(folder, path, '..'), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  return folder;
}

describe('isComposeFileName', () => {
  it('knows the names Compose looks for and the docker-compose variants', () => {
    for (const name of [
      'compose.yaml',
      'compose.yml',
      'docker-compose.yml',
      'docker-compose.prod.yaml',
    ]) {
      expect(isComposeFileName(name)).toBe(true);
    }
    for (const name of ['compose.override.yaml', 'compose.json', 'my-compose.yml', 'values.yaml']) {
      expect(isComposeFileName(name)).toBe(false);
    }
  });
});

describe('discoverComposeFiles', () => {
  it('lists compose files shallowest first with their service counts or why they cannot be read', async () => {
    const folder = folderWith({
      'compose.yaml': COMPOSE,
      'deploy/docker-compose.prod.yml': 'services: [',
      'src/index.ts': '',
    });
    const found = await discoverComposeFiles(
      deps(folder, ['src/index.ts', 'deploy/docker-compose.prod.yml', 'compose.yaml']),
      'p1',
    );
    expect(found.projectName).toBe('Shop');
    expect(found.truncated).toBe(false);
    expect(found.files).toEqual([
      { path: 'compose.yaml', services: 3 },
      {
        path: 'deploy/docker-compose.prod.yml',
        services: null,
        error: expect.stringContaining('not valid YAML'),
      },
    ]);
  });

  it('says a listed file that has gone missing cannot be read', async () => {
    const folder = folderWith({});
    const found = await discoverComposeFiles(deps(folder, ['compose.yaml']), 'p1');
    expect(found.files[0]).toMatchObject({ path: 'compose.yaml', services: null });
    expect(found.files[0].error).toBeTruthy();
  });
});

describe('readStackSource', () => {
  it('refuses paths that leave the project, and files that are not compose files', async () => {
    const folder = folderWith({ 'compose.yaml': COMPOSE, 'notes.yaml': 'a: 1' });
    const source = deps(folder);
    for (const composePath of ['../compose.yaml', '/etc/compose.yaml', 'a\\compose.yaml', '']) {
      await expect(
        readStackSource(source, { projectId: 'p1', composePath, environmentId: null }),
      ).rejects.toThrow('Pick a compose file inside the project.');
    }
    await expect(
      readStackSource(source, { projectId: 'p1', composePath: 'notes.yaml', environmentId: null }),
    ).rejects.toThrow('That is not a compose file');
  });

  it('refuses a compose file that is a link out of the project', async () => {
    const outside = folderWith({ 'compose.yaml': COMPOSE });
    const folder = folderWith({});
    try {
      symlinkSync(join(outside, 'compose.yaml'), join(folder, 'compose.yaml'));
    } catch {
      return; // Windows without the right to make links.
    }
    await expect(
      readStackSource(deps(folder), {
        projectId: 'p1',
        composePath: 'compose.yaml',
        environmentId: null,
      }),
    ).rejects.toThrow('leads out of the project');
  });

  it('asks the environment for the picked files only, and for all of them otherwise', async () => {
    const folder = folderWith({ 'compose.yaml': COMPOSE });
    const calls: unknown[][] = [];
    const source: StackSourceDeps = {
      ...deps(folder),
      environment: async (...args) => {
        calls.push(args);
        return environment([]);
      },
    };
    const input = { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' };
    await readStackSource(source, { ...input, envFileIds: ['f2', 'f1'] });
    await readStackSource(source, { ...input, envFileIds: null });
    await readStackSource(source, input);
    await readStackSource(source, { ...input, environmentId: null, envFileIds: ['f1'] });
    expect(calls).toEqual([
      ['p1', 'e1', ['f2', 'f1']],
      ['p1', 'e1'],
      ['p1', 'e1'],
    ]);
  });

  it('refuses a compose file over 1 MB', async () => {
    const folder = folderWith({ 'compose.yaml': `# ${'x'.repeat(1024 * 1024)}\n` });
    await expect(
      readStackSource(deps(folder), {
        projectId: 'p1',
        composePath: 'compose.yaml',
        environmentId: null,
      }),
    ).rejects.toThrow('larger than 1 MB');
  });
});

describe('previewStack', () => {
  it('keeps every publishing service on 127.0.0.1 by default and never returns an env value', async () => {
    const folder = folderWith({ 'compose.yaml': COMPOSE });
    const preview = await previewStack(
      deps(folder, [], environment([{ key: 'DB_PASSWORD', value: SECRET }])),
      { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' },
    );

    expect(preview.blocking).toBeNull();
    expect(preview.composeName).toBe('shop');
    expect(preview.services.map((service) => service.name)).toEqual(['web', 'api', 'tools']);
    expect(preview.services[1]).toMatchObject({ image: null, builds: true, publishes: true });
    expect(preview.services[2]).toMatchObject({ hostNetwork: true, publishes: false });
    expect(preview.proxiedServices).toEqual(['web', 'api']);
    expect(preview.bindings.map((binding) => [binding.service, binding.hostIp])).toEqual([
      ['web', '127.0.0.1'],
      ['api', '127.0.0.1'],
    ]);
    expect(preview.overrideText).toContain('!override');
    expect(preview.envKeys).toEqual(['DB_PASSWORD']);
    expect(preview.envFiles).toEqual(['.env']);
    expect(preview.missingVariables).toEqual(['MISSING_TOKEN']);
    expect(preview.buildContext).toBe('api builds from the project.');
    // Worst first: host networking (high) before the low-severity advice.
    expect(preview.risks[0].id).toBe('host-network:tools');
    expect(preview.requiresAcknowledgment).toEqual(['host-network:tools']);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
  });

  it('lists the keys and file names of the picked env files only', async () => {
    const folder = folderWith({ 'compose.yaml': COMPOSE });
    const files: Record<
      string,
      { fileName: string; entries: Array<{ key: string; value: string }> }
    > = {
      f1: { fileName: '.env', entries: [{ key: 'DB_PASSWORD', value: SECRET }] },
      f2: { fileName: '.env.local', entries: [{ key: 'MISSING_TOKEN', value: 't' }] },
    };
    const source: StackSourceDeps = {
      ...deps(folder),
      environment: async (_project, _environment, ids = ['f1', 'f2']) => {
        const picked = ids.map((id) => files[id]);
        const entries = picked.flatMap((file) => file.entries);
        return {
          id: 'e1',
          name: 'Production',
          files: picked.map((file) => ({
            fileName: file.fileName,
            entries: file.entries.map((entry, i) => ({ ...entry, line: i + 1 })),
          })),
          entries,
        };
      },
    };
    const input = { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' };
    const one = await previewStack(source, { ...input, envFileIds: ['f1'] });
    expect(one.envFiles).toEqual(['.env']);
    expect(one.envKeys).toEqual(['DB_PASSWORD']);
    expect(one.missingVariables).toEqual(['MISSING_TOKEN']);
    const both = await previewStack(source, input);
    expect(both.envFiles).toEqual(['.env', '.env.local']);
    expect(both.envKeys).toEqual(['DB_PASSWORD', 'MISSING_TOKEN']);
    expect(both.missingVariables).toEqual([]);
  });

  it('reports the public port of a service left public, which then needs an acknowledgment', async () => {
    const folder = folderWith({ 'compose.yaml': COMPOSE });
    const preview = await previewStack(deps(folder), {
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: null,
      proxiedServices: ['api', 'tools', 'nope'],
    });
    expect(preview.proxiedServices).toEqual(['api']);
    expect(preview.bindings.find((binding) => binding.service === 'web')?.hostIp).toBeNull();
    expect(preview.requiresAcknowledgment).toContain('public-port:web:*:8080:80/tcp');
  });

  it('blocks a file that does not parse, with its line', async () => {
    const folder = folderWith({ 'compose.yaml': 'services:\n  web:\n    image: [\n' });
    const preview = await previewStack(deps(folder), {
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: null,
    });
    expect(preview.blocking).toMatch(/not valid YAML/);
    expect(preview.services).toEqual([]);
  });

  it('blocks an environment with a key a .env cannot hold', async () => {
    const folder = folderWith({ 'compose.yaml': COMPOSE });
    const preview = await previewStack(
      deps(folder, [], environment([{ key: 'BAD KEY', value: '1' }])),
      { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' },
    );
    expect(preview.blocking).toMatch(/BAD KEY/);
  });

  it('blocks a file without services', async () => {
    const folder = folderWith({ 'compose.yaml': 'name: empty\nservices: {}\n' });
    const preview = await previewStack(deps(folder), {
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: null,
    });
    expect(preview.blocking).toBe('The compose file has no services.');
  });

  describe('a required variable with no value', () => {
    const REQUIRED = `services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: \${POSTGRES_USER:?set POSTGRES_USER in .env}
`;
    const prefix =
      'services.postgres.environment.POSTGRES_USER: POSTGRES_USER is required: set POSTGRES_USER in .env.';

    it('says to pick an environment when none is picked', async () => {
      const folder = folderWith({ 'compose.yaml': REQUIRED, '.env': 'POSTGRES_USER=app\n' });
      const preview = await previewStack(deps(folder), {
        projectId: 'p1',
        composePath: 'compose.yaml',
        environmentId: null,
      });
      expect(preview.blocking).toBe(
        `${prefix} No environment is picked for this app, so nothing sets POSTGRES_USER. Go back to Source and pick the environment that holds your .env values.`,
      );
    });

    it('names the picked files when none of them sets it', async () => {
      const folder = folderWith({ 'compose.yaml': REQUIRED });
      const preview = await previewStack(
        deps(folder, [], environment([{ key: 'POSTGRES_DB', value: 'shop' }])),
        { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' },
      );
      expect(preview.blocking).toBe(
        `${prefix} The env files picked from Production (.env) do not set POSTGRES_USER. Add it in the project's Environments tab, or tick the file that has it.`,
      );
    });

    it('says when the picked environment has no files', async () => {
      const folder = folderWith({ 'compose.yaml': REQUIRED });
      const empty: ResolvedProjectEnvironment = {
        id: 'e1',
        name: 'Production',
        files: [],
        entries: [],
      };
      const preview = await previewStack(deps(folder, [], empty), {
        projectId: 'p1',
        composePath: 'compose.yaml',
        environmentId: 'e1',
      });
      expect(preview.blocking).toBe(
        `${prefix} The environment Production has no files yet, so nothing sets POSTGRES_USER. Add your .env file to it in the project's Environments tab.`,
      );
    });

    it('deploys once the picked environment sets it', async () => {
      const folder = folderWith({ 'compose.yaml': REQUIRED });
      const preview = await previewStack(
        deps(folder, [], environment([{ key: 'POSTGRES_USER', value: 'app' }])),
        { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' },
      );
      expect(preview.blocking).toBeNull();
      expect(preview.services.map((service) => service.name)).toEqual(['postgres']);
    });

    it('leaves a broken ${...} as the file problem it is', async () => {
      const folder = folderWith({
        'compose.yaml': 'services:\n  web:\n    image: nginx:${TAG\n',
      });
      const preview = await previewStack(deps(folder), {
        projectId: 'p1',
        composePath: 'compose.yaml',
        environmentId: null,
      });
      expect(preview.blocking).not.toMatch(/environment/i);
    });
  });

  it('keeps the rendered .env for the upload, never in what the renderer gets', async () => {
    const folder = folderWith({ 'compose.yaml': COMPOSE });
    const source = await readStackSource(
      deps(folder, [], environment([{ key: 'DB_PASSWORD', value: SECRET }])),
      { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' },
    );
    const full = previewFromSource(source, undefined, false);
    expect(full.envText).toContain(`DB_PASSWORD="${SECRET}"`);
  });
});

describe('buildContextReason and dockerfilesOf', () => {
  async function parsed(text: string) {
    const folder = folderWith({ 'compose.yaml': text });
    const source = await readStackSource(deps(folder), {
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: null,
    });
    const project = previewFromSource(source, undefined, false).project;
    if (!project) throw new Error('did not parse');
    return project;
  }

  it('sends the folder for env files, bind mounts and secret files read from the project', async () => {
    expect(
      buildContextReason(await parsed('services:\n  a:\n    image: x\n    env_file: ./a.env\n')),
    ).toBe('a reads ./a.env from the project.');
    expect(
      buildContextReason(
        await parsed('services:\n  a:\n    image: x\n    volumes:\n      - ./conf:/etc/conf:ro\n'),
      ),
    ).toBe('a mounts ./conf from the project.');
    expect(
      buildContextReason(
        await parsed('services:\n  a:\n    image: x\nsecrets:\n  key:\n    file: ./key.txt\n'),
      ),
    ).toBe('The secret key comes from ./key.txt in the project.');
    expect(
      buildContextReason(
        await parsed(
          'services:\n  a:\n    image: x\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n',
        ),
      ),
    ).toBeNull();
  });

  it('names the Dockerfiles that must go in, and none from outside the folder or the network', async () => {
    const project = await parsed(
      [
        'services:',
        '  a:',
        '    build: ./api',
        '  b:',
        '    build:',
        '      context: web',
        '      dockerfile: docker/Prod.Dockerfile',
        '  c:',
        '    build: ../elsewhere',
        '  d:',
        '    build: https://github.com/example/repo.git',
        '',
      ].join('\n'),
    );
    expect(dockerfilesOf(project)).toEqual(['api/Dockerfile', 'web/docker/Prod.Dockerfile']);
  });
});

describe('projectFilesOf and sourceBlocking (E105)', () => {
  async function parsed(text: string) {
    const folder = folderWith({ 'compose.yaml': text });
    const source = await readStackSource(deps(folder), {
      projectId: 'p1',
      composePath: 'compose.yaml',
      environmentId: null,
    });
    const project = previewFromSource(source, undefined, false).project;
    if (!project) throw new Error('did not parse');
    return project;
  }

  it('lists the files the compose file reads from its folder, once each, without the ones on the server', async () => {
    const project = await parsed(
      [
        'services:',
        '  web:',
        '    image: ghcr.io/acme/web:1.0',
        '    env_file: [./web.env, /etc/shared.env]',
        '    volumes:',
        '      - ./nginx.conf:/etc/nginx/nginx.conf:ro',
        '      - ./nginx.conf:/etc/nginx/again.conf:ro',
        '      - type: bind',
        '        source: ./static',
        '        target: /srv',
        '      - data:/data',
        '      - /var/log:/logs',
        'secrets:',
        '  key:',
        '    file: ./secrets/key.txt',
        'volumes:',
        '  data: {}',
        '',
      ].join('\n'),
    );

    expect(projectFilesOf(project)).toEqual(['nginx.conf', 'secrets/key.txt', 'static', 'web.env']);
  });

  it('lets a registry or release deploy pull what it builds only when it names an image', async () => {
    const named = await parsed(
      'services:\n  api:\n    build: ./api\n    image: ghcr.io/acme/api:1.4\n',
    );
    const unnamed = await parsed('services:\n  api:\n    build: ./api\n');

    expect(sourceBlocking(named)).toEqual({ registry: null, release: null, local: null });
    const blocked = sourceBlocking(unnamed);
    expect(blocked.registry).toContain('api builds from source and names no image');
    expect(blocked.release).toContain('api builds from source and names no image');
    expect(blocked.local).toBeNull();
  });

  it('refuses a registry or release deploy that would need files from outside the compose folder', async () => {
    const project = await parsed(
      'services:\n  web:\n    image: nginx:1.29\n    volumes:\n      - ../shared:/srv\n',
    );

    const blocked = sourceBlocking(project);
    expect(blocked.registry).toContain('../shared');
    expect(blocked.release).toContain('../shared');
    expect(blocked.local).toBeNull();
  });
});
