import type { HealthAppLink } from '@shared/healthTypes';
import type { HealthDraft } from './healthView';

/**
 * "Open Monitoring and start adding a check with these fields." Another page (an app on Deploy)
 * builds the address, and the Monitoring board reads it once, opens the add dialog with it, and
 * takes the params back out so a reload or Back does not open it again.
 */

export interface HealthAddSeed {
  name?: string;
  url?: string;
  projectId?: string;
  environmentId?: string;
  /** "ssh:<id>" or "wordpress:<id>". */
  serverLink?: string;
  appLink?: HealthAppLink;
  appName?: string;
  /** Starts the Allow insecure HTTP switch on, for a plain http address. */
  allowInsecure?: boolean;
}

/** The params the intent uses, all removed together once it is read. */
export const HEALTH_ADD_PARAMS = [
  'add',
  'name',
  'url',
  'project',
  'env',
  'link',
  'appServer',
  'appStack',
  'appName',
  'insecure',
] as const;

const SERVER_LINK = /^(ssh|wordpress):.+$/;
const MAX_PARAM = 4096;

export function healthAddHref(seed: HealthAddSeed): string {
  const params = new URLSearchParams({ add: '1' });
  const put = (key: string, value: string | undefined) => {
    if (value) params.set(key, value);
  };
  put('name', seed.name);
  put('url', seed.url);
  put('project', seed.projectId);
  put('env', seed.environmentId);
  put('link', seed.serverLink);
  if (seed.appLink) {
    params.set('appServer', seed.appLink.serverId);
    params.set('appStack', seed.appLink.stackId);
    put('appName', seed.appName);
  }
  if (seed.allowInsecure) params.set('insecure', '1');
  return `/monitoring?${params.toString()}`;
}

/** The dialog fields the address asks for, or null when it does not ask to add a check. */
export function readHealthAddIntent(params: URLSearchParams): Partial<HealthDraft> | null {
  if (params.get('add') !== '1') return null;
  const read = (key: string): string | undefined => {
    const value = params.get(key)?.trim();
    return value && value.length <= MAX_PARAM ? value : undefined;
  };
  const draft: Partial<HealthDraft> = {};
  const name = read('name');
  if (name) draft.name = name;
  const url = read('url');
  if (url) draft.url = url;
  const projectId = read('project');
  if (projectId) draft.projectId = projectId;
  const environmentId = read('env');
  if (environmentId) draft.environmentId = environmentId;
  const link = read('link');
  if (link && SERVER_LINK.test(link)) draft.serverLink = link;
  const serverId = read('appServer');
  const stackId = read('appStack');
  if (serverId && stackId) {
    draft.appLink = { serverId, stackId };
    draft.appName = read('appName') ?? '';
  }
  if (params.get('insecure') === '1') draft.allowInsecure = true;
  return draft;
}
