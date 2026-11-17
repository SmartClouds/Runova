import type { DeployStackPreview } from '@shared/deployStacksTypes';
import { FileText, Github, Upload } from '@/components/icons';
import { describeSize } from './ReleasePicker';
import type { WizardSource } from './types';

/**
 * What a deploy sends to the server (E105), on the review step, so nothing leaves this computer
 * unannounced: the compose file and the .env always; with a registry or a release, the files
 * the compose file reads and nothing else; with a local folder, the folder, whose size the user
 * approves before it goes.
 */
export function WhatGoesCard({
  source,
  preview,
}: {
  source: WizardSource;
  preview: DeployStackPreview;
}): React.JSX.Element {
  const keys = preview.envKeys.length;
  return (
    <section
      aria-label="What goes to the server"
      className="space-y-2 rounded-xl p-3 ring-1 ring-inset ring-foreground/[0.08]"
    >
      <p className="text-sm font-medium text-foreground">What goes to the server</p>
      <ul className="space-y-1.5 text-xs text-muted-foreground">
        <li className="flex items-start gap-2">
          <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-mono text-foreground">{preview.composePath}</span> and a .env with{' '}
            {keys === 1 ? '1 setting' : `${keys} settings`}
          </span>
        </li>
        {source.imageSource !== 'local' && preview.projectFiles.length > 0 && (
          <li className="flex items-start gap-2">
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The files the compose file reads:{' '}
              <span className="font-mono text-foreground">{preview.projectFiles.join(', ')}</span>
            </span>
          </li>
        )}
        {source.imageSource === 'release' && source.release && (
          <li className="flex items-start gap-2">
            <Github className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Nothing more from here: the server downloads {source.release.assetName} (
              {describeSize(source.release.size)}) from {source.release.repository}{' '}
              {source.release.tag} itself.
            </span>
          </li>
        )}
        {source.imageSource === 'local' && (
          <li className="flex items-start gap-2">
            <Upload className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The compose folder, without what .dockerignore leaves out, to build on the server. You
              see its size and approve it before it is sent.
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}
