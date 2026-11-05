import { describe, expect, it } from 'vitest';
import type { StoredProjectEnvironment } from '../../../shared/apiTypes';
import { memorySecrets, sealed } from '../testing/memorySecrets';
import { environmentsAdapter } from './environments';

function environment(overrides: Partial<StoredProjectEnvironment> = {}): StoredProjectEnvironment {
  return {
    id: 'e1',
    projectId: 'p1',
    name: 'Production',
    kind: 'production',
    order: 0,
    files: [
      {
        id: 'f1',
        fileName: '.env.production',
        keyCount: 1,
        updatedAt: 2,
        contentEnvelope: sealed('API_KEY=1'),
      },
    ],
    credentials: [
      {
        id: 'c1',
        label: 'Database',
        username: 'app',
        url: 'postgres://db',
        updatedAt: 3,
        secretEnvelope: sealed('db-password'),
        notesEnvelope: sealed('rotate monthly'),
      },
    ],
    createdAt: 1,
    updatedAt: 3,
    ...overrides,
  } as StoredProjectEnvironment;
}

function memoryStore(initial: StoredProjectEnvironment[] = []) {
  let environments = structuredClone(initial);
  return {
    getProjectEnvironments: async () => structuredClone(environments),
    setProjectEnvironments: async (next: StoredProjectEnvironment[]) => {
      environments = structuredClone(next);
    },
    get: () => environments,
  };
}

describe('environmentsAdapter', () => {
  it('opens every file, password and note inside an environment', async () => {
    const [item] = await environmentsAdapter(memoryStore([environment()]), memorySecrets()).list();

    expect(item?.value.files).toEqual([
      expect.objectContaining({ contentEnvelope: { $secret: 'API_KEY=1' } }),
    ]);
    expect(item?.value.credentials).toEqual([
      expect.objectContaining({
        secretEnvelope: { $secret: 'db-password' },
        notesEnvelope: { $secret: 'rotate monthly' },
      }),
    ]);
  });

  it('seals what arrives again with this computer’s sealing', async () => {
    const store = memoryStore();
    const opened = (
      await environmentsAdapter(memoryStore([environment()]), memorySecrets()).list()
    )[0];

    await environmentsAdapter(store, memorySecrets()).apply(opened as never);

    expect(store.get()).toEqual([environment()]);
  });

  it('starts an environment with no files or logins when they stayed on the other computer', async () => {
    const store = memoryStore();
    const { files: _files, credentials: _credentials, ...shared } = environment();

    await environmentsAdapter(store, memorySecrets()).apply({
      id: 'e1',
      teamId: null,
      value: shared,
    });

    expect(store.get()[0]).toMatchObject({ name: 'Production', files: [], credentials: [] });
  });
});
