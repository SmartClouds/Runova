import type {
  AttackSummary,
  BlockAddressResult,
  BlockedAddressInfo,
  TrafficDimensionPage,
  TrafficReport,
  TrafficStatus,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import {
  checkAttackSettings,
  checkAutoBlock,
  checkNetwork,
  checkTrafficSettings,
} from '../../../shared/deploy/trafficValidation';
import type {
  DeployAttackListInput,
  DeployAttackSettingsInput,
  DeployAutoBlockInput,
  DeployBlockInput,
  DeployTrafficDeleteInput,
  DeployTrafficDimensionInput,
  DeployTrafficProof,
  DeployTrafficReportInput,
  DeployTrafficSaveResult,
  DeployTrafficSettingsInput,
  DeployUnblockInput,
} from '../../../shared/deployTrafficTypes';
import { ADMIN_ROLES, type CoreCallDeps, callCore } from '../coreCalls';

/**
 * Website traffic statistics (E109) and attack detection (E110) on a server. Every role reads the
 * reports and the attacks; Admins change statistics and detection, block and unblock. Deleting the
 * statistics cannot be undone, so it takes a step-up; auto-block lets the core cut visitors off by
 * itself, so it is an Owner's call with one. A step-up is made on the way when the call is handed
 * the password or a code. Settings are checked with the form's own rules before the core hears of
 * them, and the core checks them again.
 */

const OWNER_ROLES: ReadonlySet<string> = new Set(['owner']);

/** What a core without this feature answers to an unknown hub method. */
const MISSING_METHOD = /Method does not exist/i;
export const OLDER_CORE =
  'This server runs an older core without traffic statistics. Update the core from the Overview, then try again.';

async function stepUp(hub: ICoreHub, proof: DeployTrafficProof): Promise<void> {
  if (proof.password || proof.totpCode) {
    await hub.stepUp({
      ...(proof.password ? { password: proof.password } : {}),
      ...(proof.totpCode ? { totpCode: proof.totpCode } : {}),
    });
  }
}

function saved(result: { problems: string[]; status?: TrafficStatus }): DeployTrafficSaveResult {
  return { problems: result.problems, status: result.status ?? null };
}

export class DeployTraffic {
  constructor(private readonly deps: CoreCallDeps) {}

  status(serverId: string): Promise<TrafficStatus> {
    return this.call(serverId, (hub) => hub.getTrafficStatus());
  }

  report({ serverId, ...request }: DeployTrafficReportInput): Promise<TrafficReport> {
    return this.call(serverId, (hub) => hub.getTrafficReport(request));
  }

  dimension({ serverId, ...request }: DeployTrafficDimensionInput): Promise<TrafficDimensionPage> {
    return this.call(serverId, (hub) => hub.getTrafficDimension(request));
  }

  async saveSettings({
    serverId,
    settings,
  }: DeployTrafficSettingsInput): Promise<DeployTrafficSaveResult> {
    const problems = checkTrafficSettings(settings);
    if (problems.length > 0) return { problems, status: null };
    return saved(await this.call(serverId, (hub) => hub.saveTrafficSettings(settings)));
  }

  deleteData(input: DeployTrafficDeleteInput): Promise<TrafficStatus> {
    return this.call(
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        // The core reads null as every site; the generated signature only knows the string.
        return hub.deleteTrafficData(input.siteId as string);
      },
      ADMIN_ROLES,
    );
  }

  attacks({ serverId, ...query }: DeployAttackListInput): Promise<AttackSummary> {
    return this.call(serverId, (hub) => hub.listAttacks(query));
  }

  async saveAttackSettings({
    serverId,
    settings,
  }: DeployAttackSettingsInput): Promise<DeployTrafficSaveResult> {
    const problems = checkAttackSettings(settings);
    if (problems.length > 0) return { problems, status: null };
    return saved(await this.call(serverId, (hub) => hub.saveAttackSettings(settings)));
  }

  async saveAutoBlock(input: DeployAutoBlockInput): Promise<DeployTrafficSaveResult> {
    const problems = checkAutoBlock(input.settings);
    if (problems.length > 0) return { problems, status: null };
    const result = await this.call(
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        return hub.saveAutoBlock(input.settings);
      },
      OWNER_ROLES,
    );
    return saved(result);
  }

  blocked(serverId: string): Promise<BlockedAddressInfo[]> {
    return this.call(serverId, (hub) => hub.listBlockedAddresses());
  }

  async block({ serverId, ...request }: DeployBlockInput): Promise<BlockAddressResult> {
    const network = checkNetwork(request.network);
    if (!network.ok) return { problems: [network.reason] };
    return this.call(serverId, (hub) => hub.blockAddress({ ...request, network: network.value }));
  }

  unblock({ serverId, blockId }: DeployUnblockInput): Promise<void> {
    return this.call(serverId, (hub) => hub.unblockAddress(blockId));
  }

  private async call<T>(
    serverId: string,
    work: (hub: ICoreHub) => Promise<T>,
    stepUpFor?: ReadonlySet<string>,
  ): Promise<T> {
    try {
      return await callCore(this.deps, serverId, work, stepUpFor ? { stepUpFor } : {});
    } catch (error) {
      if (error instanceof Error && MISSING_METHOD.test(error.message)) {
        throw new Error(OLDER_CORE);
      }
      throw error;
    }
  }
}
