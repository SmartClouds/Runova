import type { DeployLocalUploadPlan } from '@shared/deployStacksTypes';
import { Upload } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { describeSize } from './ReleasePicker';

/**
 * The packed project folder of a Local Folder deploy, waiting for the user's say-so (E105):
 * how much goes to the server and what makes it big. Nothing has left this computer yet.
 */
export function LocalApproval({
  plan,
  onApprove,
  onDecline,
}: {
  plan: DeployLocalUploadPlan;
  onApprove: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Approve the upload" className="space-y-4">
      <p className="text-sm text-foreground">
        The project folder is packed and ready. Nothing has been sent yet.
      </p>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-xl p-3 ring-1 ring-inset ring-foreground/[0.08]">
          <dt className="text-xs text-muted-foreground">Upload</dt>
          <dd className="font-mono text-foreground">{describeSize(plan.archiveBytes)}</dd>
        </div>
        <div className="rounded-xl p-3 ring-1 ring-inset ring-foreground/[0.08]">
          <dt className="text-xs text-muted-foreground">Files before compression</dt>
          <dd className="font-mono text-foreground">{describeSize(plan.contentBytes)}</dd>
        </div>
        <div className="rounded-xl p-3 ring-1 ring-inset ring-foreground/[0.08]">
          <dt className="text-xs text-muted-foreground">Files and folders</dt>
          <dd className="font-mono text-foreground">{plan.entries}</dd>
        </div>
      </dl>
      {plan.largest.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">The largest parts</p>
          <ul className="space-y-0.5 text-xs">
            {plan.largest.map((part) => (
              <li key={part.path} className="flex justify-between gap-3 font-mono">
                <span className="truncate text-foreground">{part.path}</span>
                <span className="text-muted-foreground">{describeSize(part.bytes)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Anything the build does not need belongs in .dockerignore, or in an image from a
            registry instead.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onApprove}>
          <Upload className="h-3.5 w-3.5" /> Send {describeSize(plan.archiveBytes)} and deploy
        </Button>
        <Button variant="soft" onClick={onDecline}>
          Do not send
        </Button>
      </div>
    </section>
  );
}
