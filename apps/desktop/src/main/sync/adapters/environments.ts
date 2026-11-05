import { syncCollection } from '@runova/core';
import type { StoredProjectEnvironment } from '../../../shared/apiTypes';
import { arrayStoreAdapter, type SecretPort } from './arrayStore';
import { fromAnotherComputer } from './copyName';

export interface EnvironmentStorePort {
  getProjectEnvironments: () => Promise<StoredProjectEnvironment[]>;
  setProjectEnvironments: (environments: StoredProjectEnvironment[]) => Promise<void>;
}

/**
 * Project environments (E48). Every env file's contents and every login's password and notes are
 * sealed, so the `files` and `credentials` lists travel only sealed (policy.ts). Without a key
 * they stay here, and an environment from another computer starts with none. Each file's saved
 * history lives in its own database on this computer and does not sync.
 */
export function environmentsAdapter(
  store: EnvironmentStorePort,
  secrets: SecretPort,
  ready?: () => boolean,
) {
  return arrayStoreAdapter<StoredProjectEnvironment>({
    collection: syncCollection('environments'),
    area: 'environments',
    read: () => store.getProjectEnvironments(),
    write: (environments) => store.setProjectEnvironments(environments),
    id: (environment) => environment.id,
    secrets,
    ...(ready ? { ready } : {}),
    fromValue: (value) => {
      const environment = value as unknown as StoredProjectEnvironment;
      return {
        ...environment,
        files: Array.isArray(environment.files) ? environment.files : [],
        credentials: Array.isArray(environment.credentials) ? environment.credentials : [],
      };
    },
    duplicate: (value) => ({ ...value, name: fromAnotherComputer(value.name) }),
  });
}
