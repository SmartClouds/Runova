import { FINISHED_PHASES, filesLabel, type SendPhase } from '@shared/fileSend';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useFileSendStore } from '@/stores/fileSendStore';

/** What the person here did themselves needs no toast: they just did it. */
const OWN_DOING = ['You declined.', 'You cancelled it.', 'You took every file back.'];

/**
 * Says in the main window when a send lands or does not (E112). Only a change seen while this is
 * mounted is told, so opening the window does not replay what finished before.
 */
export function FileSendToasts(): null {
  const seen = useRef<Map<string, SendPhase> | null>(null);
  const batches = useFileSendStore((s) => s.state.batches);

  useEffect(() => {
    const before = seen.current;
    const now = new Map(batches.map((b) => [b.id, b.phase] as const));
    seen.current = now;
    if (!before) return;
    for (const batch of batches) {
      const was = before.get(batch.id);
      if (!was || FINISHED_PHASES.includes(was) || !FINISHED_PHASES.includes(batch.phase)) continue;
      if (batch.phase === 'done') {
        if (batch.direction === 'in') {
          toast.success(
            `Received ${filesLabel(batch.doneFiles)} from ${batch.peer.name || batch.peer.deviceName}`,
            {
              description: `Saved in ${batch.folder ?? 'Downloads'}`,
              action: {
                label: 'Show in folder',
                onClick: () => void window.runova.fileSend.showInFolder(batch.id),
              },
            },
          );
        } else {
          toast.success(`Sent ${filesLabel(batch.doneFiles)} to ${batch.peer.deviceName}`, {
            description:
              batch.failedFiles > 0
                ? `${filesLabel(batch.failedFiles)} did not go through.`
                : 'Every file arrived and checked out.',
          });
        }
        continue;
      }
      if (OWN_DOING.includes(batch.reason ?? '')) continue;
      toast.error(
        batch.direction === 'out'
          ? `Not sent to ${batch.peer.deviceName}`
          : `Files from ${batch.peer.name || batch.peer.deviceName} did not arrive`,
        { description: batch.reason ?? 'It did not go through.' },
      );
    }
  }, [batches]);

  return null;
}
