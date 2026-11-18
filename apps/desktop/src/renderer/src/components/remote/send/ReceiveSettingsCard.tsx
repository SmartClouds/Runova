import type { ReceiveFrom, SendSettingsPatch } from '@shared/fileSend';
import { useId } from 'react';
import { toast } from 'sonner';
import { FolderOpen, Inbox } from '@/components/icons';
import { SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useFileSend } from '@/stores/fileSendStore';
import { REMOTE_CARD, RemoteCardHeader, RemoteRow } from '../remoteCard';

const WHO: { value: ReceiveFrom; label: string }[] = [
  { value: 'everyone', label: 'My devices and teammates' },
  { value: 'own', label: 'Only my devices' },
  { value: 'nobody', label: 'No one' },
];

function save(patch: SendSettingsPatch): void {
  void window.runova.fileSend
    .updateSettings(patch)
    .catch((error: unknown) => toast.error(ipcErrorMessage(error, 'That could not be saved.')));
}

/** Who may send files here, whether my own devices need asking, and where files go (E112). */
export function ReceiveSettingsRows(): React.JSX.Element {
  const { settings } = useFileSend();
  const switchId = useId();
  const custom = settings.saveFolder !== settings.defaultSaveFolder;

  return (
    <div className="settings-rows">
      <RemoteRow
        label="Who can send you files"
        description="Everyone else is turned away before they can offer anything."
        control={
          <div role="radiogroup" aria-label="Who can send you files" className={SEGMENT_TRACK}>
            {WHO.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.receiveFrom === option.value}
                className={segmentClass(settings.receiveFrom === option.value)}
                onClick={() => save({ receiveFrom: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />
      <RemoteRow
        label={
          <label htmlFor={switchId} className="cursor-pointer">
            Accept from my own devices without asking
          </label>
        }
        description="Files you send yourself from another computer go straight in."
        control={
          <Switch
            id={switchId}
            checked={settings.autoAcceptOwn}
            onCheckedChange={(on) => save({ autoAcceptOwn: on })}
          />
        }
      />
      <RemoteRow
        label="Save files to"
        description={
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate" dir="ltr">
              {settings.saveFolder}
            </span>
          </span>
        }
        control={
          <>
            {custom ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                shape="pill"
                onClick={() => save({ saveFolder: null })}
              >
                Use Downloads
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="soft"
              shape="pill"
              onClick={() =>
                void window.runova.fileSend
                  .chooseSaveFolder()
                  .catch((error: unknown) =>
                    toast.error(ipcErrorMessage(error, 'That folder could not be used.')),
                  )
              }
            >
              Change
            </Button>
          </>
        }
      />
    </div>
  );
}

/** The Send files tab's card for files coming to this computer. */
export function ReceiveSettingsCard({ className }: { className?: string }): React.JSX.Element {
  return (
    <section aria-label="Receiving on this computer" className={cn(REMOTE_CARD, className)}>
      <RemoteCardHeader
        icon={Inbox}
        title="Receiving on this computer"
        description="You see every name and size, and say yes, before anything comes in. Teammates can send here while this computer is shown to a team you share, under Who can connect on the Anywhere tab."
      />
      <ReceiveSettingsRows />
    </section>
  );
}
