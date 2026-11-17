import type { ComposePortBinding, ComposeRisk } from '@runova/core';
import type {
  StackAction,
  StackInfo,
  StackRevisionInfo,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The Apps of a Deploy server (E07): compose stacks built from a project's compose file and an
 * environment from its Environments tab. The renderer only ever sees env keys; the values are
 * read, rendered into the .env and sent to the core by the main process.
 */

/** A compose file found in a project, relative to the project folder with forward slashes. */
export interface DeployComposeFile {
  path: string;
  /** How many services it has, when it could be read. */
  services: number | null;
  /** Why it could not be read, when it could not. */
  error?: string;
}

export interface DeployComposeDiscovery {
  projectId: string;
  projectName: string;
  files: DeployComposeFile[];
  /** The index stopped early, so a file may be missing from the list. */
  truncated: boolean;
}

/**
 * Where an app's images come from (E105). `registry` (the default) pulls them with the registry
 * sign-ins; `release` loads one a CD pipeline attached to a GitHub Release, downloaded by the
 * server itself. Both send only the compose file, the .env and the files the compose file reads,
 * and never build on the server. `local` packs the compose folder and builds it on the server,
 * only after the user approved what is sent.
 */
export type DeployImageSource = 'registry' | 'release' | 'local';

export const DEPLOY_IMAGE_SOURCES: readonly DeployImageSource[] = ['registry', 'release', 'local'];

/** The release asset a `release` deploy loads, as GitHub's API described it. */
export interface DeployReleaseAssetPick {
  /** owner/name on github.com. */
  repository: string;
  tag: string;
  assetId: number;
  assetName: string;
  size: number;
  /** GitHub's digest of the asset, in hex. */
  sha256: string;
}

/** One image asset of a release: a docker save archive. */
export interface DeployReleaseAsset {
  id: number;
  name: string;
  size: number;
  /** GitHub's SHA-256 of it, or null for an asset uploaded before GitHub recorded digests. */
  sha256: string | null;
}

export interface DeployGithubRelease {
  tag: string;
  name: string;
  publishedAtUnixMs: number | null;
  prerelease: boolean;
  /** Only the assets that can be docker save archives (.tar, .tar.gz, .tgz). */
  assets: DeployReleaseAsset[];
}

export interface DeployReleaseList {
  repository: string;
  releases: DeployGithubRelease[];
}

/** Which repository's releases to list: the one typed in, else the project's GitHub remote. */
export interface DeployReleaseListInput {
  projectId?: string;
  repository?: string;
}

/** A step-up made on the way, for Admin calls that need one. */
export interface DeployStepUpProof {
  password?: string;
  totpCode?: string;
}

/** Stores a read-only token on a server for one repository's releases. */
export interface DeployReleaseTokenInput extends DeployStepUpProof {
  serverId: string;
  repository: string;
  token: string;
}

export interface DeployReleaseTokenRemoveInput extends DeployStepUpProof {
  serverId: string;
  tokenId: string;
}

/** A packed compose folder waiting for the user's approval before it is sent (Local Folder). */
export interface DeployLocalUploadPlan {
  approvalId: string;
  /** The compressed archive that would go to the server. */
  archiveBytes: number;
  /** The files in it, before compression. */
  contentBytes: number;
  entries: number;
  /** The biggest top-level files and folders, largest first. */
  largest: Array<{ path: string; bytes: number }>;
}

/** What the wizard picked, enough to read the files again. */
export interface DeployStackSourceInput {
  projectId: string;
  /** Relative to the project folder, as discovery listed it. */
  composePath: string;
  /** Null deploys without a .env. */
  environmentId: string | null;
  /** The environment's files to use, by id, applied in the environment's order. Left out: all. */
  envFileIds?: string[] | null;
  /** Where the images come from. Left out: a registry. */
  imageSource?: DeployImageSource;
}

export interface DeployStackPreviewInput extends DeployStackSourceInput {
  /** Services kept on 127.0.0.1. Left out: every service that publishes a port. */
  proxiedServices?: string[];
  /** The server enforces SELinux, so bind mounts need :z or :Z (from the server's facts). */
  selinuxEnforcing?: boolean;
}

export interface DeployStackServicePreview {
  name: string;
  image: string | null;
  /** The service has `build:`, so a build context goes with the upload. */
  builds: boolean;
  /** Ports as the compose file publishes them. */
  ports: ComposePortBinding[];
  /** Whether it publishes anything at all (only those can be kept private). */
  publishes: boolean;
  /** `network_mode: host`: it cannot be kept on 127.0.0.1. */
  hostNetwork: boolean;
}

export interface DeployStackPreview {
  projectName: string;
  composePath: string;
  /** The compose file's own `name:`, a suggestion for the app's name. */
  composeName: string | null;
  services: DeployStackServicePreview[];
  /** The keys the .env will hold, never the values. */
  envKeys: string[];
  /** The environment's files the keys come from, in the order they apply. */
  envFiles: string[];
  /** Variables the compose file uses that the environment does not set. */
  missingVariables: string[];
  /** Services kept on 127.0.0.1 (the default: all that publish and can be). */
  proxiedServices: string[];
  /** Every published port once the loopback override applies. */
  bindings: ComposePortBinding[];
  /** The override file the core writes for the proxied services. */
  overrideText: string;
  /** Every finding, worst first. */
  risks: ComposeRisk[];
  /** The findings that need an acknowledgment before a deploy (all but low ones). */
  requiresAcknowledgment: string[];
  /** Why a build context goes with the upload, or null when none does. */
  buildContext: string | null;
  /**
   * The files the compose file reads from its folder (bind mounts, env files, configs and
   * secrets), relative to it. A registry or release deploy sends these and nothing else.
   */
  projectFiles: string[];
  /** Why each image source cannot deploy this compose file, or null when it can. */
  sourceBlocking: Record<DeployImageSource, string | null>;
  /** Why it cannot be deployed as it is (a file that does not parse, a key that cannot be written). */
  blocking: string | null;
}

/** What an upload carries besides the files, for the release and local sources. */
export interface DeployStackSourceExtras {
  /** The release asset a `release` deploy loads. */
  release?: DeployReleaseAssetPick;
  /** The plan the user approved for a `local` deploy (prepareLocal). */
  approvalId?: string;
}

export interface DeployStackCreateInput extends DeployStackSourceInput, DeployStackSourceExtras {
  serverId: string;
  /** The app's name on the server (a compose project name). */
  name: string;
  proxiedServices: string[];
  acknowledgedRisks: string[];
}

/** A new revision of an existing app, from the same kind of source. */
export interface DeployStackRevisionInput extends DeployStackSourceInput, DeployStackSourceExtras {
  serverId: string;
  stackId: string;
  proxiedServices: string[];
  acknowledgedRisks: string[];
}

/** Packs a compose folder for a Local Folder deploy, to show what would be sent. */
export interface DeployLocalUploadInput extends DeployStackSourceInput {
  serverId: string;
}

export interface DeployStackUploadResult {
  stack: StackInfo;
  /** Ready to deploy unless the core found risks still waiting for an acknowledgment. */
  revision: StackRevisionInfo;
}

export interface DeployStackRef {
  serverId: string;
  stackId: string;
}

export interface DeployStackRevisionRef extends DeployStackRef {
  revision: number;
}

export interface DeployStackAcknowledgeInput extends DeployStackRevisionRef {
  riskIds: string[];
}

export interface DeployStackActionInput extends DeployStackRef {
  action: StackAction;
}

export interface DeployStackDeleteInput extends DeployStackRef {
  /** The app's volumes go too: its data. Admin only. */
  removeVolumes: boolean;
}

/** Where an upload is, for the wizard's progress line. */
export interface DeployStackUploadProgress {
  serverId: string;
  phase:
    | 'reading'
    | 'packing'
    | 'uploading-files'
    | 'uploading-context'
    /** The server downloads the GitHub Release image, checks it and loads it (E105). */
    | 'loading-release'
    | 'done';
  /** For the build context: bytes sent so far and in all. */
  sentBytes?: number;
  totalBytes?: number;
}
