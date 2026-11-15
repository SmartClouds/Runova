import { type IpLockSpec, ipLockDescription, parseIpLock } from '../../../shared/cloudflare/ipLock';
import { cloudflarePermission, tokenProblem } from '../../../shared/cloudflare/permissions';
import { cloudflareErrorMessage } from '../../../shared/cloudflareErrors';
import type {
  CloudflareAccountStatus,
  CloudflarePermissionId,
  CloudflareStatus,
} from '../../../shared/cloudflareTypes';
import type { CloudflareEmailGateOps } from '../../deploy/cloudflare/emailGate';
import type { CloudflareServerOps } from '../../deploy/cloudflare/serverOps';
import type { CloudflareService } from '../../deploy/cloudflare/service';
import { cloudflareInputs as check } from '../../ipc/cloudflare';
import { emailGateInputs as gate } from '../../ipc/cloudflareEmailGate';
import { cloudflareServerInputs as server } from '../../ipc/cloudflareServer';
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
  | 'purgeCache'
  | 'listCustomRules'
  | 'createCustomRule'
  | 'setCustomRuleEnabled'
  | 'deleteCustomRule'
  | 'listAccessRules'
  | 'createAccessRule'
  | 'deleteAccessRule'
  | 'updateCustomRule'
  | 'listTurnstileWidgets'
  | 'createTurnstileWidget'
  | 'updateTurnstileWidget'
  | 'deleteTurnstileWidget'
  | 'turnstileSecret'
  | 'rotateTurnstileSecret'
>;

/** What the Cloudflare methods need from the rest of the app. */
export interface ManageCloudflareDeps {
  service: ManageCloudflareService;
  /** Saved servers a domain can point at; this computer's own dev host is left out. */
  servers(): Promise<{ id: string; name: string }[]>;
  emailGate: Pick<
    CloudflareEmailGateOps,
    'plan' | 'prepare' | 'save' | 'remove' | 'letThisComputerThrough' | 'proxy'
  >;
  /** This computer's address on the internet, for an IP limit that lets it in. */
  publicIp(): Promise<string | null>;
  serverOps: Pick<CloudflareServerOps, 'dnsTokens' | 'provisionDnsToken' | 'removeDnsToken'>;
}

/** An IP limit as a phone lists it: read back from its rule by the desktop's own reader. */
export interface ManageIpLimit {
  id: string;
  enabled: boolean;
  hostname: string | null;
  path: string | null;
  match: 'exact' | 'prefix';
  ips: string[];
}

function ipLimits(rules: { id: string; enabled: boolean; expression: string; action: string }[]) {
  return rules.flatMap((rule): ManageIpLimit[] => {
    const spec = parseIpLock(rule);
    if (!spec) return [];
    const { hostname, path, match, ips } = spec;
    return [{ id: rule.id, enabled: rule.enabled, hostname, path, match, ips }];
  });
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
const ruleOf = (params: unknown, what: string) =>
  checked(() => check.itemId(field(params, 'ruleId'), what));

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
    'cloudflare.purgeCache': async (params) => {
      const zone = zoneOf(params);
      const request = checked(() =>
        check.purgeRequest(
          field(params, 'everything') === true
            ? { everything: true }
            : { urls: field(params, 'urls') },
        ),
      );
      await run(() => service.purgeCache(zone, request));
      const message =
        'everything' in request
          ? 'Purged everything. Visitors get fresh copies now.'
          : `Purged ${request.urls.length} ${request.urls.length === 1 ? 'file' : 'files'}.`;
      return { ok: true, message };
    },
    'cloudflare.customRules': async (params) => {
      const zone = zoneOf(params);
      return run(() => service.listCustomRules(zone));
    },
    'cloudflare.createCustomRule': async (params) => {
      const zone = zoneOf(params);
      const input = checked(() => check.customRuleInput(field(params, 'input')));
      return run(() => service.createCustomRule(zone, input));
    },
    'cloudflare.setCustomRuleEnabled': async (params) => {
      const zone = zoneOf(params);
      const id = ruleOf(params, 'rule');
      const enabled = checked(() =>
        check.flag(field(params, 'enabled'), 'Say whether the rule is on or off.'),
      );
      return run(() => service.setCustomRuleEnabled(zone, id, enabled));
    },
    'cloudflare.deleteCustomRule': async (params) => {
      const zone = zoneOf(params);
      const id = ruleOf(params, 'rule');
      return run(() => service.deleteCustomRule(zone, id));
    },
    'cloudflare.accessRules': async (params) => {
      const zone = zoneOf(params);
      return run(() => service.listAccessRules(zone));
    },
    'cloudflare.createAccessRule': async (params) => {
      const zone = zoneOf(params);
      const input = checked(() => check.accessRuleInput(field(params, 'input')));
      return run(() => service.createAccessRule(zone, input));
    },
    'cloudflare.emailGatePlan': async (params) => {
      const zone = zoneOf(params);
      return run(() => deps.emailGate.plan(zone));
    },
    'cloudflare.emailGatePrepare': async (params) => {
      const input = checked(() => gate.prepareInput(params));
      return run(() => deps.emailGate.prepare(input));
    },
    'cloudflare.emailGateSave': async (params) => {
      const input = checked(() => gate.emailGateInput(params));
      return run(() => deps.emailGate.save(input));
    },
    'cloudflare.emailGateRemove': async (params) => {
      const target = checked(() => gate.target(params));
      await run(() => deps.emailGate.remove(target));
      return { ok: true, message: `${target.hostname} is open to everyone again.` };
    },
    'cloudflare.emailGateLetThrough': async (params) => {
      const target = checked(() => gate.target(params));
      await run(() => deps.emailGate.letThisComputerThrough(target));
      return {
        ok: true,
        message: `This computer has its own pass through ${target.hostname} now.`,
      };
    },
    'cloudflare.emailGateProxy': async (params) => {
      const target = checked(() => gate.target(params));
      await run(() => deps.emailGate.proxy(target));
      return { ok: true, message: `${target.hostname} goes through Cloudflare's proxy now.` };
    },
    'cloudflare.ipLimits': async (params) => {
      const zone = zoneOf(params);
      return ipLimits(await run(() => service.listCustomRules(zone)));
    },
    'cloudflare.saveIpLimit': async (params) => {
      const zone = zoneOf(params);
      const ruleId = field(params, 'ruleId');
      const id = ruleId === undefined ? null : ruleOf(params, 'rule');
      const input = checked(() => {
        const checkedInput = check.customRuleInput({
          description: 'IP limit',
          spec: field(params, 'spec'),
        });
        if (checkedInput.spec.kind !== 'ip-lock')
          throw new Error('Only an IP limit is saved here.');
        const spec = checkedInput.spec as IpLockSpec;
        return { description: ipLockDescription(spec), spec };
      });
      const rules = await run(() =>
        id === null
          ? service.createCustomRule(zone, input)
          : service.updateCustomRule(zone, id, input),
      );
      return ipLimits(rules);
    },
    'cloudflare.turnstileWidgets': async (params) => {
      const zone = zoneOf(params);
      return run(() => service.listTurnstileWidgets(zone));
    },
    // A new widget's secret stays on the computer; the phone asks for it on its own.
    'cloudflare.createTurnstileWidget': async (params) => {
      const zone = zoneOf(params);
      const input = checked(() => check.turnstileInput(field(params, 'input')));
      const { widget } = await run(() => service.createTurnstileWidget(zone, input));
      return { widget };
    },
    'cloudflare.updateTurnstileWidget': async (params) => {
      const zone = zoneOf(params);
      const key = checked(() => check.sitekey(field(params, 'sitekey')));
      const input = checked(() => check.turnstileInput(field(params, 'input')));
      return run(() => service.updateTurnstileWidget(zone, key, input));
    },
    'cloudflare.deleteTurnstileWidget': async (params) => {
      const zone = zoneOf(params);
      const key = checked(() => check.sitekey(field(params, 'sitekey')));
      await run(() => service.deleteTurnstileWidget(zone, key));
      return { ok: true, message: 'Deleted the widget.' };
    },
    'cloudflare.turnstileSecret': async (params) => {
      const zone = zoneOf(params);
      const key = checked(() => check.sitekey(field(params, 'sitekey')));
      return { secret: await run(() => service.turnstileSecret(zone, key)) };
    },
    'cloudflare.rotateTurnstileSecret': async (params) => {
      const zone = zoneOf(params);
      const key = checked(() => check.sitekey(field(params, 'sitekey')));
      const now = checked(() =>
        check.flag(field(params, 'now'), 'Say whether the old secret stops working now.'),
      );
      const { widget } = await run(() => service.rotateTurnstileSecret(zone, key, now));
      return { widget };
    },
    'cloudflare.dnsTokens': async (params) => {
      const id = checked(() => server.serverId(field(params, 'serverId')));
      const tokens = await run(() => deps.serverOps.dnsTokens(id));
      return tokens.map((token) => ({
        zone: token.zone,
        zoneId: token.zoneId,
        madeHere: Boolean(token.tokenId),
        updatedAt: token.updatedAtUnixMs,
      }));
    },
    'cloudflare.provisionDnsToken': async (params) => {
      const input = checked(() => server.dnsTokenInput(params));
      await run(() => deps.serverOps.provisionDnsToken(input));
      return { ok: true, message: 'The server has a DNS token for this domain now.' };
    },
    'cloudflare.removeDnsToken': async (params) => {
      const input = checked(() => server.removeInput(params));
      await run(() => deps.serverOps.removeDnsToken(input));
      return { ok: true, message: 'The server forgot its DNS token for this domain.' };
    },
    'cloudflare.publicAddress': async () => {
      try {
        return { ip: await deps.publicIp() };
      } catch {
        return { ip: null };
      }
    },
    'cloudflare.deleteAccessRule': async (params) => {
      const zone = zoneOf(params);
      const id = ruleOf(params, 'access rule');
      await run(() => service.deleteAccessRule(zone, id));
      return { ok: true, message: 'Deleted the access rule.' };
    },
  };
}
