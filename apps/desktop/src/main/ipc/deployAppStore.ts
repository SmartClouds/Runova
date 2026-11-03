import type { IpcMainInvokeEvent } from 'electron';
import type {
  DeployAppInstallInput,
  DeployAppParamValue,
  DeployAppRevealInput,
  DeployAppUpdateInput,
} from '../../shared/deployAppStoreTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeployAppStore } from '../deploy/appStore/service';
import { type DeployIpcRegistry, object, serverId, stepUpInput } from './deploy';
import { limitsInput } from './limits';

/**
 * The App Store's invoke channels (E12). They answer only the main window and check the shape
 * of every argument here; the main process then renders the files itself from the template, and
 * the core checks everything again. Secrets travel inwards with an install and outwards only
 * from a step-up reveal.
 */

export interface DeployAppStoreHandlerDeps {
  ipc: DeployIpcRegistry;
  store: DeployAppStore;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_ID = /^[a-z0-9-]{1,40}$/;
const VERSION_ID = /^[A-Za-z0-9._-]{1,40}$/;
/** `latest` or a tag, as registries allow them. */
const RELEASE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_PARAMS = 40;
const MAX_SECRETS = 20;
const MAX_PARAM_TEXT = 1_000;
const MAX_SECRET = 256;
const MAX_NAME = 63;
const MAX_DOMAIN = 253;

function stackId(value: unknown): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error('That is not an app.');
  return value;
}

function templateId(value: unknown): string {
  if (typeof value !== 'string' || !TEMPLATE_ID.test(value)) {
    throw new Error('That is not an app from the App Store.');
  }
  return value;
}

function versionId(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_ID.test(value)) throw new Error('Pick a version.');
  return value;
}

/** The release the version picker sent, if any: left out means the newest. */
function release(value: unknown): { release?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || !RELEASE.test(value)) {
    throw new Error('Pick a release from the list.');
  }
  return { release: value };
}

function params(value: unknown): Record<string, DeployAppParamValue> {
  const input = object(value, 'the app settings');
  const entries = Object.entries(input);
  if (entries.length > MAX_PARAMS) throw new Error('Too many settings.');
  const out: Record<string, DeployAppParamValue> = {};
  for (const [key, item] of entries) {
    if (!PARAM_KEY.test(key)) throw new Error('One of the settings has a name that is not one.');
    const fits =
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item)) ||
      (typeof item === 'string' && item.length <= MAX_PARAM_TEXT);
    if (!fits) throw new Error(`The setting ${key} must be text, a number or a switch.`);
    out[key] = item as DeployAppParamValue;
  }
  return out;
}

function secrets(value: unknown): Record<string, string> {
  const input = object(value, 'the passwords');
  const entries = Object.entries(input);
  if (entries.length > MAX_SECRETS) throw new Error('Too many passwords.');
  const out: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!ENV_KEY.test(key)) throw new Error('One of the passwords has a name that is not one.');
    // The reason never repeats the value.
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_SECRET) {
      throw new Error(`The value for ${key} must be text of at most ${MAX_SECRET} characters.`);
    }
    out[key] = item;
  }
  return out;
}

function domain(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_DOMAIN) {
    throw new Error('Enter a domain name.');
  }
  return value;
}

function installInput(value: unknown): DeployAppInstallInput {
  const input = object(value, 'an install');
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > MAX_NAME) {
    throw new Error(`Give the app a name of at most ${MAX_NAME} characters.`);
  }
  return {
    serverId: serverId(input.serverId),
    templateId: templateId(input.templateId),
    version: versionId(input.version),
    name: input.name,
    params: params(input.params),
    secrets: secrets(input.secrets),
    domain: domain(input.domain),
    ...release(input.release),
    ...(input.limits === undefined ? {} : { limits: limitsInput(input.limits) }),
  };
}

function updateInput(value: unknown): DeployAppUpdateInput {
  const input = object(value, 'an update');
  return {
    serverId: serverId(input.serverId),
    stackId: stackId(input.stackId),
    version: versionId(input.version),
    ...release(input.release),
  };
}

function revealInput(value: unknown): DeployAppRevealInput {
  const input = object(value, 'a reveal');
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) {
    throw new Error('A revision is a whole number from 1.');
  }
  return {
    ...stepUpInput(input),
    stackId: stackId(input.stackId),
    revision: input.revision as number,
  };
}

export function registerDeployAppStoreHandlers(deps: DeployAppStoreHandlerDeps): void {
  const { ipc, store } = deps;
  const handle = (channel: string, run: (value: unknown) => unknown) => {
    ipc.handle(channel, async (event, value) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(value);
    });
  };

  handle(IPC.deployAppStore.install, (value) => store.install(installInput(value)));
  handle(IPC.deployAppStore.update, (value) => store.update(updateInput(value)));
  handle(IPC.deployAppStore.revealSecrets, (value) => store.revealSecrets(revealInput(value)));
  handle(IPC.deployAppStore.releases, (value) =>
    store.releases({
      refresh:
        typeof value === 'object' &&
        value !== null &&
        (value as { refresh?: unknown }).refresh === true,
    }),
  );
}
