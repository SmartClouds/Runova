import type { SyncAdapter } from '../types';
import { type ApiCollectionsPort, apiCollectionsAdapter } from './apiCollections';
import type { SecretPort } from './arrayStore';
import { type BlueprintStorePort, blueprintsAdapter } from './blueprints';
import { type DatabaseConnectionsPort, databaseConnectionsAdapter } from './databaseConnections';
import { type EnvironmentStorePort, environmentsAdapter } from './environments';
import { type ErrorTrackingPort, errorTrackingAdapter } from './errorTracking';
import { type HealthTargetsPort, healthTargetsAdapter } from './healthTargets';
import { type ProjectStorePort, projectsAdapter } from './projects';
import { type PromptTemplateStorePort, promptTemplatesAdapter } from './promptTemplates';
import { type RdpServerStorePort, rdpServersAdapter } from './rdpServers';
import { type SettingsPort, settingsAdapter } from './settings';
import { type SshServerStorePort, sshServersAdapter } from './sshServers';
import { type VaultEntriesPort, vaultEntriesAdapter } from './vaultEntries';

/**
 * One port per store, so main can hand in the real store functions and tests in-memory ones.
 * Nothing here imports Electron or a real store.
 */
export interface SyncAdapterPorts {
  /** Opens and seals secrets the way the stores do (`decryptSecret` and `encryptSecret`). */
  secrets: SecretPort;
  /**
   * False while the Servers passkey is set and locked, when no sealed secret can be opened or
   * sealed. The stores that hold one wait for it then. Missing means always ready.
   */
  secretsReady?: () => boolean;
  projects: ProjectStorePort;
  /** After projects arrive from another computer, such as refreshing the project list. */
  projectsChanged?: () => void;
  environments: EnvironmentStorePort;
  sshServers: SshServerStorePort;
  rdpServers: RdpServerStorePort;
  databaseConnections: DatabaseConnectionsPort;
  healthTargets: HealthTargetsPort;
  errorTracking: ErrorTrackingPort;
  apiCollections: ApiCollectionsPort;
  promptTemplates: PromptTemplateStorePort;
  blueprints: BlueprintStorePort;
  settings: SettingsPort;
  vault: VaultEntriesPort;
}

/**
 * Every adapter the sync engine runs, in the order it writes them: projects first and their
 * environments next, so the monitors, blueprints and API collections that point at them arrive
 * after them. Monitoring history (health-history) has no adapter yet.
 */
export function createSyncAdapters(ports: SyncAdapterPorts): SyncAdapter[] {
  const { secrets, secretsReady: ready } = ports;
  return [
    projectsAdapter(ports.projects, ports.projectsChanged),
    environmentsAdapter(ports.environments, secrets, ready),
    sshServersAdapter(ports.sshServers, secrets, ready),
    rdpServersAdapter(ports.rdpServers, secrets, ready),
    databaseConnectionsAdapter(ports.databaseConnections, secrets, ready),
    healthTargetsAdapter(ports.healthTargets, secrets, ready),
    errorTrackingAdapter(ports.errorTracking, secrets, ready),
    apiCollectionsAdapter(ports.apiCollections),
    promptTemplatesAdapter(ports.promptTemplates),
    blueprintsAdapter(ports.blueprints),
    settingsAdapter(ports.settings),
    vaultEntriesAdapter(ports.vault),
  ];
}
