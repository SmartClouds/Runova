import type { SecurityScannerId, SecurityScannerSettings } from '@runova/core';
import {
  CODEQL_LANGUAGES,
  codeqlLanguageNeedsBuild,
  DEFAULT_SCAN_OPTIONS,
  getSecurityScanner,
  SEMGREP_RULESETS,
  STRIX_DEFAULT_MODEL,
} from '@runova/core';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
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

type TrivyScanner = 'vuln' | 'secret' | 'misconfig';

/** What Trivy can look for, in the order it is always stored. */
const TRIVY_SCANNERS: { value: TrivyScanner; label: string; hint: string }[] = [
  {
    value: 'vuln',
    label: 'Vulnerable dependencies',
    hint: 'Known CVEs in lockfiles and manifests.',
  },
  { value: 'secret', label: 'Secrets', hint: 'Keys and tokens committed to the code.' },
  {
    value: 'misconfig',
    label: 'Misconfigurations',
    hint: 'Dockerfiles, Kubernetes and Terraform settings. Slower.',
  },
];

const DEFAULT_SONAR_URL = 'http://localhost:9000';

/** The scanners this dialog has something for. Bearer runs as it is. */
const SCANNERS_WITH_SETTINGS: ReadonlySet<SecurityScannerId> = new Set([
  'semgrep',
  'trivy',
  'codeql',
  'sonarqube',
  'strix',
]);

export function scannerHasSettings(scannerId: SecurityScannerId): boolean {
  return SCANNERS_WITH_SETTINGS.has(scannerId);
}

/**
 * Fills in what the form showed as a default but the user never typed over, so the saved settings
 * match the screen. Without this a Strix model shown in the field was never stored, and preflight
 * kept asking for one.
 */
function withShownDefaults(
  scannerId: SecurityScannerId | null,
  draft: SecurityScannerSettings,
): SecurityScannerSettings {
  if (scannerId === 'strix' && !draft.strixModel?.trim()) {
    return { ...draft, strixModel: STRIX_DEFAULT_MODEL };
  }
  if (scannerId === 'sonarqube' && !draft.sonarUrl?.trim()) {
    return { ...draft, sonarUrl: DEFAULT_SONAR_URL };
  }
  return draft;
}

/**
 * Per-scanner setup. Semgrep picks a ruleset, Trivy what it looks for, CodeQL needs a language
 * (and a build command for compiled ones), SonarQube and Strix need credentials. Bearer has
 * nothing to set.
 *
 * Secrets typed here go to settings.json in plaintext, which is the same convention the Token
 * Usage page's API keys already use. They are handed to scanners through the environment rather
 * than the command line, and are stripped out of logs and reports before either is shown or
 * copied.
 */
export function ScannerSetupDialog({
  scannerId,
  config,
  projectName,
  onClose,
  onSave,
  onSuggestLanguage,
}: {
  scannerId: SecurityScannerId | null;
  config: SecurityScannerSettings;
  projectName: string;
  onClose: () => void;
  onSave: (patch: SecurityScannerSettings) => void;
  onSuggestLanguage: () => Promise<string | null>;
}): React.JSX.Element {
  // Seeded once. The caller keys this component by scanner id, so opening a different scanner
  // mounts a fresh dialog with that scanner's saved settings. Syncing from `config` on every
  // render instead would wipe what the user is typing, since the query hands back a new object
  // each time it resolves.
  const [draft, setDraft] = useState<SecurityScannerSettings>(config);
  const [suggesting, setSuggesting] = useState(false);
  const id = useId();
  const field = (name: string) => `${id}-${name}`;

  const scanner = scannerId ? getSecurityScanner(scannerId) : null;
  const trivyScanners = (draft.trivyScanners ??
    DEFAULT_SCAN_OPTIONS.trivyScanners) as TrivyScanner[];
  const canSave = scannerId !== 'trivy' || trivyScanners.length > 0;

  function toggleTrivy(value: TrivyScanner): void {
    const next = trivyScanners.includes(value)
      ? trivyScanners.filter((entry) => entry !== value)
      : [...trivyScanners, value];
    patch({
      trivyScanners: TRIVY_SCANNERS.map((entry) => entry.value).filter((entry) =>
        next.includes(entry),
      ),
    });
  }

  function patch(update: Partial<SecurityScannerSettings>): void {
    setDraft((current) => ({ ...current, ...update }));
  }

  async function suggest(): Promise<void> {
    setSuggesting(true);
    try {
      const language = await onSuggestLanguage();
      if (language) patch({ codeqlLanguage: language });
      else toast('Runova could not tell which language matters most here. Pick one from the list.');
    } catch (error) {
      toast.error(
        `Could not detect the language: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <Dialog open={scannerId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up {scanner?.name ?? 'scanner'}</DialogTitle>
          <DialogDescription>These settings apply to {projectName} only.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {scannerId === 'semgrep' && (
            <div className="space-y-1.5">
              <Label>Ruleset</Label>
              <Combobox
                value={draft.semgrepConfig ?? 'auto'}
                onChange={(value) => patch({ semgrepConfig: value })}
                options={SEMGREP_RULESETS}
                placeholder="Choose a ruleset"
              />
              <p className="text-xs text-muted-foreground">
                Auto downloads rules from semgrep.dev on every scan. Pick one of the p/ packs to
                stay offline. Runova always runs Semgrep with metrics off.
              </p>
            </div>
          )}

          {scannerId === 'trivy' && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What to look for</legend>
              {TRIVY_SCANNERS.map((entry) => (
                <label
                  key={entry.value}
                  htmlFor={field(`trivy-${entry.value}`)}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-card/60 px-3 py-2"
                >
                  <Checkbox
                    id={field(`trivy-${entry.value}`)}
                    checked={trivyScanners.includes(entry.value)}
                    onCheckedChange={() => toggleTrivy(entry.value)}
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    <span className="text-sm text-foreground">{entry.label}</span>
                    <span className="text-xs text-muted-foreground">{entry.hint}</span>
                  </span>
                </label>
              ))}
              {trivyScanners.length === 0 && (
                <p className="text-xs text-destructive">Pick at least one.</p>
              )}
            </fieldset>
          )}

          {scannerId === 'codeql' && (
            <>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <div className="flex gap-2">
                  <Combobox
                    className="flex-1"
                    value={draft.codeqlLanguage ?? ''}
                    onChange={(value) => patch({ codeqlLanguage: value })}
                    options={CODEQL_LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                    placeholder="Choose a language"
                  />
                  <Button
                    variant="soft"
                    className="h-9"
                    disabled={suggesting}
                    onClick={() => void suggest()}
                  >
                    {suggesting ? 'Looking...' : 'Detect'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  CodeQL analyzes one language per run, so pick the one that matters most here.
                </p>
              </div>

              {codeqlLanguageNeedsBuild(draft.codeqlLanguage ?? null) && (
                <div className="space-y-1.5">
                  <Label htmlFor={field('codeql-build')}>Build command</Label>
                  <Input
                    id={field('codeql-build')}
                    value={draft.codeqlBuildCommand ?? ''}
                    onChange={(event) => patch({ codeqlBuildCommand: event.target.value })}
                    placeholder="e.g. dotnet build, mvn -B clean install"
                  />
                  <p className="text-xs text-muted-foreground">
                    This language is compiled, so CodeQL has to watch a real build to see the code.
                    Without a command it finds nothing and stops.
                  </p>
                </div>
              )}
            </>
          )}

          {scannerId === 'sonarqube' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={field('sonar-url')}>Server URL</Label>
                <Input
                  id={field('sonar-url')}
                  value={draft.sonarUrl ?? DEFAULT_SONAR_URL}
                  onChange={(event) => patch({ sonarUrl: event.target.value })}
                  placeholder={DEFAULT_SONAR_URL}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={field('sonar-key')}>Project key</Label>
                <Input
                  id={field('sonar-key')}
                  value={draft.sonarProjectKey ?? ''}
                  onChange={(event) => patch({ sonarProjectKey: event.target.value })}
                  placeholder="my-project"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={field('sonar-token')}>Token</Label>
                <Input
                  id={field('sonar-token')}
                  type="password"
                  value={draft.sonarToken ?? ''}
                  onChange={(event) => patch({ sonarToken: event.target.value })}
                  placeholder="squ_..."
                />
                <p className="text-xs text-muted-foreground">
                  Create one in SonarQube under My Account &gt; Security. It is stored in this
                  machine's settings file and never appears in a scan report.
                </p>
              </div>
            </>
          )}

          {scannerId === 'strix' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={field('strix-model')}>Model</Label>
                <Input
                  id={field('strix-model')}
                  value={draft.strixModel ?? STRIX_DEFAULT_MODEL}
                  onChange={(event) => patch({ strixModel: event.target.value })}
                  placeholder={STRIX_DEFAULT_MODEL}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={field('strix-key')}>LLM API key</Label>
                <Input
                  id={field('strix-key')}
                  type="password"
                  value={draft.strixApiKey ?? ''}
                  onChange={(event) => patch({ strixApiKey: event.target.value })}
                  placeholder="sk-..."
                />
                <p className="text-xs text-muted-foreground">
                  Strix drives a model to find and prove vulnerabilities, so a run bills against
                  this key. It is stored in this machine's settings file and never appears in a scan
                  report.
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onSave(withShownDefaults(scannerId, draft));
              onClose();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
