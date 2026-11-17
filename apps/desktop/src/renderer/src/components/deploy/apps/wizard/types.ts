import type { DeployImageSource, DeployReleaseAssetPick } from '@shared/deployStacksTypes';

/** What the New App wizard has picked so far. */
export interface WizardSource {
  projectId: string;
  projectName: string;
  projectFolder: string;
  composePath: string;
  environmentId: string | null;
  environmentName: string | null;
  /** The environment's files that make the .env, in its order; null uses them all. */
  envFileIds: string[] | null;
  name: string;
  /** Where the images come from (E105): a registry unless picked otherwise. */
  imageSource: DeployImageSource;
  /** The repository whose releases to pick from; '' uses the project's GitHub remote. */
  releaseRepository: string;
  /** The release image a GitHub Release deploy loads. */
  release: DeployReleaseAssetPick | null;
}

export type WizardStep = 'source' | 'configure' | 'expose' | 'review' | 'deploy';

export const WIZARD_STEPS: ReadonlyArray<{ step: WizardStep; label: string }> = [
  { step: 'source', label: 'Source' },
  { step: 'configure', label: 'Configure' },
  { step: 'expose', label: 'Expose' },
  { step: 'review', label: 'Review' },
  { step: 'deploy', label: 'Deploy' },
];
