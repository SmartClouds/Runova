import { isClonableGithubUrl, normalizeCloneUrl } from '@runova/core';
import { useState } from 'react';
import { CloneProgressCard } from '@/components/clone/CloneProgressCard';
import { runClone } from '@/components/clone/runClone';
import { CloudDownload, GitBranch, Spinner } from '@/components/icons';
import { SectionEmptyState } from '@/components/projects/ProjectDetailChrome';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCloneJobForProject } from '@/stores/cloneJobsStore';

/** `owner/repo` for a GitHub address, which is what a button has room for. */
function repoLabel(repoUrl: string): string {
  const normalized = normalizeCloneUrl(repoUrl);
  return normalized ? normalized.replace(/^https:\/\/github\.com\//, '') : repoUrl;
}

/**
 * The Git tab for a project whose folder isn't a repository yet. When the project has a GitHub
 * address (or the user types one) this gets that repo onto the computer: a clone into an empty
 * folder, or, after asking, connecting a folder that already holds the files. Starting a brand
 * new repository stays available through `onInitialize`.
 *
 * The clone runs in the background, so while it runs (or after it failed) the tab shows its
 * progress card instead of the buttons, and a second clone into the same folder can't start.
 * Once it succeeds the folder is a repository and the regular Git tab takes over.
 */
export function GitCloneEmptyState({
  projectId,
  repoUrl,
  onInitialize,
}: {
  projectId: string;
  repoUrl: string;
  onInitialize: () => void;
}): React.JSX.Element {
  const job = useCloneJobForProject(projectId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftUrl, setDraftUrl] = useState('');
  const [starting, setStarting] = useState(false);

  const savedClonable = isClonableGithubUrl(repoUrl);
  const draftClonable = isClonableGithubUrl(draftUrl);

  async function clone(url: string): Promise<void> {
    setStarting(true);
    try {
      const result = await runClone({ projectId, repoUrl: url, attach: false });
      if (result.ok) setDialogOpen(false);
    } finally {
      setStarting(false);
    }
  }

  if (job) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col py-10">
        <CloneProgressCard job={job} variant="full" />
      </div>
    );
  }

  function openUrlDialog(): void {
    setDraftUrl(repoUrl);
    setDialogOpen(true);
  }

  const cloneSaved = (
    <Button disabled={starting} onClick={() => void clone(repoUrl)}>
      {starting ? (
        <Spinner className="h-4 w-4 animate-spin" />
      ) : (
        <CloudDownload className="h-4 w-4" />
      )}
      Clone {repoLabel(repoUrl)}
    </Button>
  );

  return (
    <>
      <SectionEmptyState
        icon={GitBranch}
        title={
          savedClonable
            ? "This project's GitHub repository isn't on this computer yet"
            : "This folder isn't a git repository yet"
        }
        description={
          savedClonable
            ? 'Clone it from GitHub to get the code, history and branches. A private repo needs the GitHub CLI signed in (gh auth login).'
            : 'Clone an existing GitHub repository into this folder, or start a new one on a master branch and publish it to GitHub without leaving the app.'
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {savedClonable ? (
              <>
                {cloneSaved}
                <Button variant="outline" disabled={starting} onClick={onInitialize}>
                  <GitBranch className="h-4 w-4" /> Initialize a new repository
                </Button>
              </>
            ) : (
              <>
                <Button disabled={starting} onClick={onInitialize}>
                  <GitBranch className="h-4 w-4" /> Initialize repository
                </Button>
                <Button variant="outline" disabled={starting} onClick={openUrlDialog}>
                  <CloudDownload className="h-4 w-4" /> Clone from GitHub…
                </Button>
              </>
            )}
          </div>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => !starting && setDialogOpen(open)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Clone from GitHub</DialogTitle>
            <DialogDescription>
              The repository is cloned into this project's folder in the background, so you can keep
              working. If the folder already has files, you'll be asked before they are connected to
              it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draftClonable && !starting) void clone(draftUrl.trim());
            }}
          >
            <Label htmlFor="git-clone-url">Repository address</Label>
            <Input
              id="git-clone-url"
              autoFocus
              placeholder="https://github.com/owner/repo"
              value={draftUrl}
              onChange={(event) => setDraftUrl(event.target.value)}
            />
            {draftUrl.trim() && !draftClonable && (
              <p className="text-xs text-destructive">Use a github.com/owner/repo address.</p>
            )}
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                disabled={starting}
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!draftClonable || starting}>
                {starting ? (
                  <Spinner className="h-4 w-4 animate-spin" />
                ) : (
                  <CloudDownload className="h-4 w-4" />
                )}
                Clone
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
