import {
  type AnyCatalogTemplate,
  type CatalogReleaseData,
  type ServiceLimits,
  templateAtRelease,
} from '@runova/core';
import { useMemo, useState } from 'react';
import { CircleCheck, CircleInfo, Rocket, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  checkDraft,
  type DraftCheck,
  type InstallDraft,
  initialDraft,
  regenerate,
  secretsInUse,
  webOf,
  withVersion,
} from '@/lib/deploy/appStore/draft';
import {
  memoryText,
  publisherText,
  shortDigest,
  versionImages,
} from '@/lib/deploy/appStore/format';
import { releaseOptions } from '@/lib/deploy/appStore/releases';
import { useLimitsHost } from '../limits/useLimitsHost';
import { FieldError, TextField } from '../sites/fields';
import { ExposeFields, ParamFields, SecretRows } from './InstallFields';
import { InstallLimitsDialog } from './InstallLimitsDialog';

/**
 * The install sheet (signature interaction 7): everything about an install on one screen. Who
 * publishes the images and the digests they are pinned to, the version, the app's settings, the
 * passwords made for it, and whether it goes on a domain. Install then asks how much of the
 * server each container may use, and nothing is sent until Install there.
 *
 * The release is picked from a list (the newest by default), never typed: the main process reads
 * the registries, and installs only a release it listed, pinned by the digest it read.
 */

export interface InstallRequest {
  template: AnyCatalogTemplate;
  draft: InstallDraft;
  check: DraftCheck;
  /** Resource caps by service, from the step after the sheet; none caps nothing. */
  limits?: ServiceLimits[];
}

function ImageBadges({ template, version }: { template: AnyCatalogTemplate; version: string }) {
  const pinned = template.versions.find((item) => item.id === version);
  if (!pinned) return null;
  return (
    <ul aria-label="Images" className="flex flex-wrap gap-2">
      {versionImages(pinned).map((image) => (
        <li
          key={`${image.repository}@${image.digest}`}
          className="flex items-center gap-2 rounded-full bg-success/10 px-2.5 py-1 text-xs ring-1 ring-inset ring-success/25"
        >
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
          <span className="font-medium text-foreground">{publisherText(image)}</span>
          <SimpleTooltip
            label={`${image.repository}:${image.tag}@${image.digest}, checked ${image.resolvedAt} for ${image.platforms.join(', ')}`}
            className="max-w-96 break-all"
          >
            <span
              tabIndex={0}
              className="rounded-sm font-mono text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {image.repository.replace(/^docker\.io\/(library\/)?/, '')}:{image.tag} @
              {shortDigest(image.digest)}
            </span>
          </SimpleTooltip>
        </li>
      ))}
    </ul>
  );
}

export function InstallSheet({
  serverId,
  template,
  releases,
  taken,
  canAdmin,
  busy,
  error,
  onCancel,
  onInstall,
}: {
  serverId: string;
  template: AnyCatalogTemplate;
  /** What the registries list, with why not when they could not be read. */
  releases: { data: CatalogReleaseData | null; error: string | null; loading: boolean };
  /** Names of the apps already on the server. */
  taken: readonly string[];
  canAdmin: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onInstall: (request: InstallRequest) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<InstallDraft>(() => initialDraft(template, taken));
  const [tried, setTried] = useState(false);
  const [step, setStep] = useState<'sheet' | 'limits'>('sheet');
  const limitsHost = useLimitsHost(serverId);
  // The template with the line on the picked release, so the badges and the preview show it.
  const resolved = useMemo(
    () => templateAtRelease(template, draft.version, draft.release, releases.data) ?? template,
    [template, draft.version, draft.release, releases.data],
  );
  const options = useMemo(
    () => releaseOptions(template, draft.version, releases.data),
    [template, draft.version, releases.data],
  );
  const check = useMemo(() => checkDraft(resolved, draft, taken), [resolved, draft, taken]);
  const web = useMemo(() => webOf(resolved, draft.version) !== null, [resolved, draft.version]);
  const specs = secretsInUse(template, check.params);
  const services = [...new Set((check.render?.images ?? []).map((image) => image.service))];
  // A problem shows once it is typed into, or after a first try at Install.
  const shown = (key: string) =>
    tried || key !== 'domain' || draft.domain !== '' ? check.problems[key] : undefined;
  const problems = Object.fromEntries(
    Object.keys(check.problems).flatMap((key) => (shown(key) ? [[key, check.problems[key]]] : [])),
  );
  const change = (next: Partial<InstallDraft>) => setDraft((current) => ({ ...current, ...next }));
  const ready = Object.keys(check.problems).length === 0 && check.render !== null;

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    setTried(true);
    if (ready && !busy) setStep('limits');
  }

  function install(limits: ServiceLimits[]): void {
    // Back on the sheet, which shows the install going and any refusal.
    setStep('sheet');
    if (ready && !busy) onInstall({ template: resolved, draft, check, limits });
  }

  return (
    <>
      <InstallLimitsDialog
        open={step === 'limits'}
        services={services}
        host={limitsHost.host}
        outdated={limitsHost.outdated}
        minMemoryMb={template.minMemoryMb}
        busy={busy}
        onBack={() => setStep('sheet')}
        onInstall={install}
      />
      <Dialog open={step === 'sheet'} onOpenChange={(open) => !open && !busy && onCancel()}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <form
            className="space-y-5"
            onSubmit={submit}
            noValidate
            aria-label={`Install ${template.name}`}
          >
            <DialogHeader>
              <DialogTitle>Install {template.name}</DialogTitle>
              <DialogDescription>{template.description}</DialogDescription>
            </DialogHeader>
            <ImageBadges template={resolved} version={draft.version} />

            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    label="App name"
                    value={draft.name}
                    onChange={(name) => change({ name })}
                    error={problems.name}
                    mono
                  />
                  <div className="space-y-1.5">
                    <Label htmlFor="store-release">Release</Label>
                    <Combobox
                      id="store-release"
                      searchable={false}
                      options={options}
                      value={draft.release}
                      onChange={(release) => change({ release })}
                    />
                  </div>
                </div>
                {template.versions.length > 1 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="store-version">Version</Label>
                    <Combobox
                      id="store-version"
                      searchable={false}
                      options={template.versions.map((version) => ({
                        value: version.id,
                        label:
                          version.id === template.defaultVersion
                            ? `${version.label} (recommended)`
                            : version.label,
                      }))}
                      value={draft.version}
                      onChange={(version) => setDraft((current) => withVersion(current, version))}
                    />
                  </div>
                )}
                {(releases.loading || releases.error) && (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    {releases.loading ? (
                      <Spinner className="mt-0.5 h-3 w-3 shrink-0 motion-safe:animate-spin" />
                    ) : (
                      <CircleInfo className="mt-0.5 h-3 w-3 shrink-0" />
                    )}
                    {releases.loading
                      ? 'Checking for the newest release...'
                      : 'Showing the versions this app shipped with: the registries could not be reached.'}
                  </p>
                )}
                <ParamFields
                  template={template}
                  values={draft.values}
                  problems={problems}
                  onChange={(key, value) => change({ values: { ...draft.values, [key]: value } })}
                />
              </div>
              <div className="space-y-4">
                <SecretRows
                  specs={specs}
                  secrets={draft.secrets}
                  problems={problems}
                  onChange={(key, value) => change({ secrets: { ...draft.secrets, [key]: value } })}
                  onRegenerate={(spec) =>
                    change({ secrets: { ...draft.secrets, [spec.key]: regenerate(spec) } })
                  }
                />
                <ExposeFields
                  template={template}
                  web={web}
                  draft={draft}
                  problems={problems}
                  canAdmin={canAdmin}
                  onChange={change}
                />
              </div>
            </div>

            <ul className="space-y-1 text-xs text-muted-foreground">
              <li className="flex items-start gap-1.5">
                <CircleInfo className="mt-0.5 h-3 w-3 shrink-0" />
                Needs {memoryText(template.minMemoryMb)}. Every port stays on 127.0.0.1.
              </li>
              {template.firstVisitorSetup && (
                <li className="flex items-start gap-1.5 text-warning">
                  <CircleInfo className="mt-0.5 h-3 w-3 shrink-0" />
                  The first person to open it creates the admin account, so open it right after the
                  install.
                </li>
              )}
            </ul>
            <FieldError message={problems.general} />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="soft" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || (tried && !ready)}>
                {busy ? <Spinner className="motion-safe:animate-spin" /> : <Rocket />}
                Install {template.name}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
