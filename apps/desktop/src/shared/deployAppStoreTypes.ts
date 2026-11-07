import type { CatalogReleaseData, ServiceLimits } from '@runova/core';
import type {
  JobInfo,
  StackInfo,
  StackRevisionInfo,
  StackServiceNetworks,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployStepUpInput } from './deployTypes';

/**
 * The App Store of a Deploy server (E12) and "make private" (E13). The catalog itself is code in
 * @runova/core, so the renderer reads it directly; what crosses to the main process is what was
 * picked. The main process renders the compose file and the .env again from these choices and
 * never takes a file from the renderer. Generated secrets travel inwards once, with the install;
 * after that they are on the server only, and come back through a step-up reveal.
 */

export type DeployAppParamValue = string | number | boolean;

export interface DeployAppInstallInput {
  serverId: string;
  templateId: string;
  /** A version id of the template. */
  version: string;
  /**
   * The release of that line to install: `latest` (the default) or a tag the version picker
   * listed. The main process resolves it against its own registry reading, never a digest sent here.
   */
  release?: string;
  /** Resource caps by service; left out, nothing is capped. */
  limits?: ServiceLimits[];
  /** The app's name on the server (a compose project name). */
  name: string;
  params: Record<string, DeployAppParamValue>;
  /** Every secret the template uses, by env key. */
  secrets: Record<string, string>;
  /** Put on a domain: the URLs in the app's settings point at it. */
  domain: string | null;
}

/** The app, its first revision and its deploy job (absent when the server refused the files). */
export interface DeployAppInstallResult {
  stack: StackInfo;
  revision: StackRevisionInfo;
  job: JobInfo | null;
}

export interface DeployAppUpdateInput {
  serverId: string;
  stackId: string;
  /** The version to move to; the same one for newer digests of the same line. */
  version: string;
  /** The release of that line: `latest` (the default) or a listed tag. */
  release?: string;
}

/**
 * What the registries say about the catalog's images (releases.ts in main): null data means only
 * the bundled pins are known, with the reason in error. An old reading can come with an error too.
 */
export interface DeployAppReleases {
  data: CatalogReleaseData | null;
  checkedAtUnixMs: number | null;
  error: string | null;
}

/** A revision made on the server and its deploy job. */
export interface DeployRevisionResult {
  revision: StackRevisionInfo;
  job: JobInfo | null;
}

export interface DeployAppRevealInput extends DeployStepUpInput {
  stackId: string;
  revision: number;
}

export interface DeployMakePrivateInput {
  serverId: string;
  stackId: string;
  /** Services to keep on 127.0.0.1 from now on, on top of the ones already there. */
  services: string[];
}

/** New resource caps on an app's services: a copy of the live revision with them, deployed. */
export interface DeployStackLimitsInput {
  serverId: string;
  stackId: string;
  /** Every cap the app should have from now on; a service left out is uncapped. */
  limits: ServiceLimits[];
}

/** Networks an app's services join besides their own: a copy of the live revision with them, deployed. */
export interface DeployStackNetworksInput {
  serverId: string;
  stackId: string;
  /** Every joined network the app should have from now on; a service left out joins none. */
  networks: StackServiceNetworks[];
}
