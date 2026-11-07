import type {
  HealthAuthMode,
  HealthDayBucket,
  HealthIncident,
  HealthLatencyPoint,
  HealthReport,
  HealthSample,
  HealthState,
} from '@runova/core';

/**
 * Project health checks (E22): what crosses IPC between the Health page and the main process.
 *
 * A stored key or password never appears in any of these. The renderer sees `hasSecret`, and the
 * plaintext only once, in a `HealthSecretReveal`, right after it was generated.
 */

/** A saved server or site the target runs on, for a link to it. Deploy servers share SSH ids. */
export interface HealthServerLink {
  kind: 'ssh' | 'wordpress';
  id: string;
}

/** A deployed app (a stack on a Deploy server) the target watches, for a link back to it. */
export interface HealthAppLink {
  serverId: string;
  stackId: string;
}

/** What the user edits in the target dialog. */
export interface HealthTargetInput {
  projectId: string;
  /** One of the project's environments (Environments tab), or none. */
  environmentId: string | null;
  /** What the target is called on the page, such as "API" or "Storefront". */
  name: string;
  /** The server it runs on, as the user names it ("web-1"). */
  serverLabel: string | null;
  serverLink: HealthServerLink | null;
  /** The deployed app it was added from, if any. Missing means none. */
  appLink?: HealthAppLink | null;
  url: string;
  intervalSec: number;
  timeoutSec: number;
  authMode: HealthAuthMode;
  /** The username for HTTP Basic; ignored for a Bearer key. */
  basicUser: string | null;
  /** Lets an http:// URL that is not loopback be probed. The UI warns before it is turned on. */
  allowInsecure: boolean;
  /** Runs the read-only AI analysis when an incident opens. */
  autoDiagnose: boolean;
  /** Shows the app version the endpoint reports on the Health page. Missing means on. */
  showVersion?: boolean;
}

/** Where a monitor is checked from (E56): this computer, or Runova Cloud's nodes. */
export type HealthRunMode = 'local' | 'cloud';

/** What the page knows of a monitor that runs on Runova Cloud. */
export interface HealthCloudInfo {
  /** The server's id for it; null until it was turned online on some computer. */
  monitorId: number | null;
  /** Signed out, the app has nothing to show and does not check it here either. */
  signedIn: boolean;
  /** The region of the node that checked it last. */
  region: string | null;
  /** "over-limit" when Runova paused it because the account type went down. */
  suspendedReason: string | null;
  notifyInApp: boolean;
  notifyTelegram: boolean;
  /** This account does not hear about it. */
  muted: boolean;
  /** False for a team Viewer: the settings are read only. */
  canWrite: boolean;
  /** A change waits for its second sample or a second opinion from another region. */
  confirming: boolean;
}

/** One target as the page lists it. */
export interface HealthTargetSummary extends HealthTargetInput {
  id: string;
  runMode: HealthRunMode;
  /** Set when it runs on Runova Cloud. */
  cloud: HealthCloudInfo | null;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
  hasSecret: boolean;
  secretRotatedAt: number | null;
  state: HealthState;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  latencyMs: number | null;
  /** The app version from the last report, or null when it gave none or the option is off. */
  version: string | null;
  /** Share of good checks over the last 24 hours (0 to 1), or null with no checks yet. */
  uptime24h: number | null;
  /** The last 30 calendar days, oldest first, for the availability chart. */
  daily: HealthDayBucket[];
  /** The most recent samples, oldest first, at most 50, for the card's strip. */
  samples: HealthSample[];
  servicesTotal: number;
  servicesFailing: number;
  /** A short line for the card: the problem, or the first failing service's error. */
  headline: string | null;
  openIncident: HealthIncident | null;
}

/** Everything the detail panel shows for one target. */
export interface HealthTargetDetail {
  target: HealthTargetSummary;
  /** The last report, already redacted. */
  report: HealthReport | null;
  /** Newest first, at most 50. */
  incidents: HealthIncident[];
  /** Every stored sample, oldest first, at most 200. */
  samples: HealthSample[];
  /** The last 24 hours, one point per hour, oldest first, for the response time chart. */
  latency: HealthLatencyPoint[];
}

/** The key or password, shown once after it is generated. */
export interface HealthSecretReveal {
  targetId: string;
  authMode: HealthAuthMode;
  /** The plaintext: a Bearer key, or the Basic password. */
  secret: string;
  /** Its SHA-256 as lowercase hex, which is what the server stores. */
  sha256: string;
  basicUser: string | null;
  /** The variable the server reads the hash from. */
  hashEnvVar: string;
}

export interface HealthCreateResult {
  target: HealthTargetSummary;
  secret: HealthSecretReveal;
}

export interface HealthSetupPrompt {
  /** The ask plus the spec, for an agent tab or the clipboard. */
  prompt: string;
  /** The protocol document on its own. */
  spec: string;
}

/**
 * What "Where it runs" shows for a monitor: the account type of the project's scope, its use, and
 * why the monitor can not go online now, if it can not.
 */
export interface HealthCloudPlan {
  signedIn: boolean;
  /** The scope the project lives in: "Personal" or the team's name. */
  scopeName: string | null;
  canWrite: boolean;
  accountTypeName: string | null;
  /** Null for no limit. */
  maxMonitors: number | null;
  active: number;
  /** The shortest interval the type allows. */
  minIntervalSec: number;
  /** Why it can not go online now, in words for the dialog; null when it can. */
  blocked: string | null;
  /** What to do about it: sign in, or choose a type with more. */
  action: 'sign-in' | 'upgrade' | null;
  /** The account linked a Telegram chat to the RunovaHQ bot. */
  telegramLinked: boolean;
}

/** Turning a monitor online. The key goes only with `consent`. */
export interface HealthCloudEnableInput {
  consent: boolean;
  intervalSec: number;
  notifyInApp: boolean;
  notifyTelegram: boolean;
}

/** The online settings a member can change. */
export interface HealthCloudSettingsPatch {
  notifyInApp?: boolean;
  notifyTelegram?: boolean;
  muted?: boolean;
}

/** Main to renderer: these targets changed (a probe finished, a target was edited). */
export interface HealthChangedEvent {
  targetIds: string[];
}
