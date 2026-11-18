import type {
  AttackQuery,
  AttackSettings,
  AttackSummary,
  AutoBlockSettings,
  BlockAddressRequest,
  BlockAddressResult,
  BlockedAddressInfo,
  TrafficDimensionPage,
  TrafficDimensionRequest,
  TrafficLive,
  TrafficReport,
  TrafficReportRequest,
  TrafficSettings,
  TrafficStatus,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Website traffic statistics (E109) and attack detection (E110) on a server. The core reads the
 * access logs nginx writes for each site, keeps hourly and daily figures and watches the same lines
 * for attacks. Every role reads reports and attacks; Admins change statistics and detection, block
 * and unblock; deleting statistics needs a step-up, and auto-block is an Owner's call with one.
 */

export type {
  AttackSummary,
  BlockAddressResult,
  BlockedAddressInfo,
  TrafficDimensionPage,
  TrafficLive,
  TrafficReport,
  TrafficStatus,
};

/** The password or authenticator code a step-up needs, when the core asked for one. */
export interface DeployTrafficProof {
  password?: string;
  totpCode?: string;
}

export interface DeployTrafficReportInput extends TrafficReportRequest {
  serverId: string;
}

export interface DeployTrafficDimensionInput extends TrafficDimensionRequest {
  serverId: string;
}

export interface DeployTrafficSettingsInput {
  serverId: string;
  settings: TrafficSettings;
}

/** Deletes the statistics of one site, or of every site when `siteId` is null. Admin, step-up. */
export interface DeployTrafficDeleteInput extends DeployTrafficProof {
  serverId: string;
  siteId: string | null;
}

export interface DeployAttackListInput extends AttackQuery {
  serverId: string;
}

export interface DeployAttackSettingsInput {
  serverId: string;
  settings: AttackSettings;
}

export interface DeployAutoBlockInput extends DeployTrafficProof {
  serverId: string;
  settings: AutoBlockSettings;
}

export interface DeployBlockInput extends BlockAddressRequest {
  serverId: string;
}

export interface DeployUnblockInput {
  serverId: string;
  blockId: number;
}

/** Saved when `problems` is empty (and `status` says how it now stands); otherwise nothing was. */
export interface DeployTrafficSaveResult {
  problems: string[];
  status: TrafficStatus | null;
}

/** Live visitors for one site, or every site when `siteId` is null. */
export interface DeployTrafficLiveWatchInput {
  serverId: string;
  siteId: string | null;
}

/** What the core said about live visitors, or that the stream is over (and why). */
export interface DeployTrafficLiveEvent {
  subscriptionId: string;
  serverId: string;
  siteId: string | null;
  live?: TrafficLive;
  ended?: { error?: string };
}

/**
 * Cloudflare's view of one site domain (E109 T3b): whether its zone adds the visitor's country
 * (IP Geolocation) and city and region (the "Add visitor location headers" Managed Transform).
 * Null means unknown: the zone is not in a connected account, or Cloudflare would not say.
 */
export interface TrafficGeoSite {
  siteId: string;
  domain: string;
  zoneId: string | null;
  zoneName: string | null;
  ipGeolocation: boolean | null;
  locationHeaders: boolean | null;
  /** Why the zone could not be read, in words. */
  problem?: string;
}

export interface TrafficGeolocationStatus {
  /** False when no Cloudflare account is connected on this computer. */
  connected: boolean;
  sites: TrafficGeoSite[];
}

export interface DeployTrafficGeolocationInput {
  serverId: string;
  zoneId: string;
}
