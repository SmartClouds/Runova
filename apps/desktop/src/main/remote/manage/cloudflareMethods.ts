import { cloudflarePermission, tokenProblem } from '../../../shared/cloudflare/permissions';
import { cloudflareErrorMessage } from '../../../shared/cloudflareErrors';
import type {
  CloudflareAccountStatus,
  CloudflarePermissionId,
  CloudflareStatus,
} from '../../../shared/cloudflareTypes';
import type { CloudflareService } from '../../deploy/cloudflare/service';
import { cloudflareInputs as check } from '../../ipc/cloudflare';
import { ManageError, type ManageMethods } from './session';

/** The parts of the desktop's Cloudflare service a phone reaches. */
export type ManageCloudflareService = Pick<
  CloudflareService,
  | 'status'
  | 'saveToken'
  | 'checkToken'
  | 'removeToken'
  | 'listZones'
  | 'cloudflareAccounts'
  | 'createZone'
  | 'checkActivation'
  | 'listRecords'
  | 'createRecord'
  | 'updateRecord'
  | 'deleteRecord'
  | 'zoneSettings'
  | 'changeSetting'
  | 'botSettings'
  | 'changeBotSetting'
  | 'planPointDomain'
  | 'pointDomain'
>;

/** What the Cloudflare methods need from the rest of the app. */
export interface ManageCloudflareDeps {
  service: ManageCloudflareService;
  /** Saved servers a domain can point at; this computer's own dev host is left out. */
  servers(): Promise<{ id: string; name: string }[]>;
}

/** How one account stands, for a phone: its permissions in words, never its token's id. */
export interface ManageCloudflareAccount {
  id: string;
  label: string;
  locked: boolean;
  state: 'active' | 'disabled' | 'expired' | null;
  expiresOn: string | null;
  zoneCount: number | null;
  checkedAt: number | null;
  missing: string[];
  unverified: string[];
}

const DEV_SERVER = 'dev';

function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

/** A value the desktop's own checks refuse is refused for the phone too, in the same words. */
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new ManageError('bad-params', (error as Error).message);
  }
}

/** Cloudflare's or the service's refusal, in words, without the code the desktop page reads. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ManageError) throw error;
    throw new ManageError('failed', cloudflareErrorMessage(error));
  }
}

function labels(account: CloudflareAccountStatus, state: 'missing' | 'unverified'): string[] {
  return (account.report?.permissions ?? [])
    .filter((permission) => permission.state === state)
    .map((permission) => cloudflarePermission(permission.id as CloudflarePermissionId).label);
}

function phoneStatus(status: CloudflareStatus) {
  return {
    configured: status.configured,
    locked: status.locked,
    accounts: status.accounts.map(
      (account): ManageCloudflareAccount => ({
        id: account.id,
        label: account.label,
        locked: account.locked,
        state: account.report?.status ?? null,
        expiresOn: account.report?.expiresOn ?? null,
        zoneCount: account.report?.zoneCount ?? null,
        checkedAt: account.report?.checkedAt ?? null,
        missing: labels(account, 'missing'),
        unverified: labels(account, 'unverified'),
      }),
    ),
  };
}

const accountOf = (params: unknown) => checked(() => check.accountId(field(params, 'accountId')));
const zoneOf = (params: unknown) => checked(() => check.zoneId(field(params, 'zoneId')));
const recordOf = (params: unknown) =>
  checked(() => check.itemId(field(params, 'recordId'), 'record'));

/**
 * Cloudflare for a phone (E98): every call goes to the desktop's own Cloudflare service, with its
 * saved tokens, after the same checks the desktop's IPC makes. A token pasted on the phone is
 * checked before it leaves for Cloudflare and never comes back in any answer.
 */
export function cloudflareMethods(deps: ManageCloudflareDeps): ManageMethods['calls'] {
  const { service } = deps;
  return {
    'cloudflare.status': async () => phoneStatus(await run(() => service.status())),
    'cloudflare.saveToken': async (params) => {
      const input = checked(() => {
        const value = check.saveInput(params);
        const problem = tokenProblem(value.token);
        if (problem) throw new Error(problem);
        return value;
      });
      return phoneStatus(await run(() => service.saveToken(input)));
    },
    'cloudflare.checkToken': async (params) => {
      const id = accountOf(params);
      return phoneStatus(await run(() => service.checkToken(id)));
    },
    'cloudflare.removeToken': async (params) => {
      const id = accountOf(params);
      return phoneStatus(await run(() => service.removeToken(id)));
    },
    'cloudflare.zones': async (params) => {
      const id = accountOf(params);
      return run(() => service.listZones(id));
    },
    'cloudflare.accounts': async (params) => {
      const id = accountOf(params);
      return run(() => service.cloudflareAccounts(id));
    },
    'cloudflare.createZone': async (params) => {
      const id = accountOf(params);
      const input = checked(() => check.newZoneInput(params));
      return run(() => service.createZone(id, input));
    },
    'cloudflare.checkActivation': async (params) => {
      const zone = zoneOf(params);
      await run(() => service.checkActivation(zone));
      return { ok: true, message: 'Cloudflare is checking the name servers again.' };
    },
    'cloudflare.records': async (params) => {
      const zone = zoneOf(params);
      return run(() => service.listRecords(zone));
    },
    'cloudflare.createRecord': async (params) => {
      const zone = zoneOf(params);
      const record = checked(() => check.recordInput(field(params, 'record')));
      return run(() => service.createRecord(zone, record));
    },
    'cloudflare.updateRecord': async (params) => {
      const zone = zoneOf(params);
      const id = recordOf(params);
      const record = checked(() => check.recordInput(field(params, 'record')));
      return run(() => service.updateRecord(zone, id, record));
    },
    'cloudflare.deleteRecord': async (params) => {
      const zone = zoneOf(params);
      const id = recordOf(params);
      await run(() => service.deleteRecord(zone, id));
      return { ok: true, message: 'Deleted the record.' };
    },
    'cloudflare.zoneSettings': async (params) => {
      const zone = zoneOf(params);
      return run(() => service.zoneSettings(zone));
    },
    'cloudflare.changeSetting': async (params) => {
      const zone = zoneOf(params);
      const change = checked(() => check.settingChange(field(params, 'change')));
      return run(() => service.changeSetting(zone, change));
    },
    'cloudflare.botSettings': async (params) => {
      const zone = zoneOf(params);
      return run(() => service.botSettings(zone));
    },
    'cloudflare.changeBotSetting': async (params) => {
      const zone = zoneOf(params);
      const change = checked(() => check.botChange(field(params, 'change')));
      return run(() => service.changeBotSetting(zone, change));
    },
    'cloudflare.servers': async () =>
      (await deps.servers()).filter((server) => server.id !== DEV_SERVER),
    'cloudflare.planPointDomain': async (params) => {
      const input = checked(() => check.pointDomainInput(params));
      return run(() => service.planPointDomain(input));
    },
    'cloudflare.pointDomain': async (params) => {
      const input = checked(() => check.pointDomainInput(params));
      return run(() => service.pointDomain(input));
    },
  };
}
