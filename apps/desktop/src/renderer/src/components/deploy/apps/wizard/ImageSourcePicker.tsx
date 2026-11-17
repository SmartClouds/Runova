import type { DeployImageSource } from '@shared/deployStacksTypes';
import { useId } from 'react';
import { Docker, FolderOpen, Github } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * Where an app's images come from (E105), picked as one of three cards. Docker Registry is the
 * default and the recommended one: only the compose file, the .env and the files the compose file
 * reads go to the server. A GitHub Release has the server download the image a pipeline built.
 * A local folder sends the project and builds it on the server, after the user sees the size.
 */

export const IMAGE_SOURCE_LABEL: Record<DeployImageSource, string> = {
  registry: 'Docker Registry',
  release: 'GitHub Release',
  local: 'Local Folder',
};

const OPTIONS: ReadonlyArray<{
  value: DeployImageSource;
  icon: typeof Docker;
  note: string;
  recommended?: boolean;
}> = [
  {
    value: 'registry',
    icon: Docker,
    recommended: true,
    note: 'The server pulls the images from GHCR, Docker Hub or your registry. Only the compose file and its settings are sent.',
  },
  {
    value: 'release',
    icon: Github,
    note: 'Your CD pipeline attached the image to a GitHub Release. The server downloads it from GitHub and checks it.',
  },
  {
    value: 'local',
    icon: FolderOpen,
    note: 'The project folder is sent and built on the server. You see how much goes and approve it first.',
  },
];

export function ImageSourcePicker({
  value,
  onChange,
}: {
  value: DeployImageSource;
  onChange: (next: DeployImageSource) => void;
}): React.JSX.Element {
  const label = useId();
  return (
    <div className="space-y-2">
      <p id={label} className="text-sm font-medium text-foreground">
        Where the images come from
      </p>
      <div role="radiogroup" aria-labelledby={label} className="grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((option) => {
          const checked = option.value === value;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onChange(option.value)}
              className={cn(
                'flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                checked
                  ? 'bg-primary/10 ring-primary/40'
                  : 'ring-foreground/[0.08] hover:bg-foreground/[0.04]',
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Icon
                  className={cn('h-4 w-4', checked ? 'text-primary' : 'text-muted-foreground')}
                />
                {IMAGE_SOURCE_LABEL[option.value]}
                {option.recommended && (
                  <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                    Recommended
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{option.note}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
