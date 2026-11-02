import { checkCoreDomainName } from '@shared/deploy/coreDomainValidation';
import { checkSources } from '@shared/deploy/directTlsValidation';
import type { CoreDomainMode } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useState } from 'react';
import { SegmentedChoice } from '@/components/cloudflare/fields';
import { Globe, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MODES: readonly { value: CoreDomainMode; label: string }[] = [
  { value: 'direct', label: 'Straight to the server' },
  { value: 'cloudflare', label: 'Through Cloudflare' },
];

/** What the DNS record has to be for each mode, and what proves this computer. */
const MODE_HINT: Record<CoreDomainMode, string> = {
  direct:
    "The record points straight at this server (on Cloudflare, the grey cloud, DNS only). nginx asks for this computer's device certificate in the TLS handshake.",
  cloudflare:
    'The record is proxied by Cloudflare (the orange cloud), and the Cloudflare origin lock can stay on. Cloudflare ends TLS at its edge, so this computer signs each request with its device key instead. Cloudflare sees the traffic in the clear, as it does for every proxied site, but cannot sign as this computer.',
};

/**
 * The domain, how the app reaches it, and the addresses nginx lets in. Checked as the user types,
 * with the same rules the main process and the core apply again. Saving asks for a step-up when
 * the last one ran out.
 */
export function CoreDomainForm({
  initialDomain,
  initialSources,
  initialMode,
  originLocked,
  busy,
  disabled = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialDomain: string;
  initialSources: string[];
  initialMode: CoreDomainMode;
  /** The Cloudflare origin lock is on: only Through Cloudflare can work. */
  originLocked: boolean;
  busy: boolean;
  /** nginx is missing: the form shows, but cannot be sent. */
  disabled?: boolean;
  submitLabel: string;
  onSubmit: (domain: string, sources: string[], mode: CoreDomainMode) => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const [domain, setDomain] = useState(initialDomain);
  const [sources, setSources] = useState(initialSources.join('\n'));
  const [mode, setMode] = useState<CoreDomainMode>(
    originLocked && initialMode === 'direct' ? 'cloudflare' : initialMode,
  );
  const [touched, setTouched] = useState(false);
  const domainCheck = checkCoreDomainName(domain);
  const sourcesCheck = checkSources(sources);
  const modeProblem = problemWith(mode, originLocked, sourcesCheck.ok ? sourcesCheck.value : []);
  const valid = domainCheck.ok && sourcesCheck.ok && modeProblem === null;

  return (
    <form
      className="space-y-4"
      aria-label="Core domain settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        setTouched(true);
        if (domainCheck.ok && sourcesCheck.ok && modeProblem === null) {
          onSubmit(domainCheck.value, sourcesCheck.value, mode);
        }
      }}
    >
      <div className="space-y-1.5">
        <p id="core-domain-mode" className="text-sm font-medium">
          How the app reaches it
        </p>
        <SegmentedChoice
          labelledBy="core-domain-mode"
          layoutId="core-domain-mode"
          options={MODES}
          value={mode}
          disabled={disabled || busy}
          onChange={setMode}
        />
        <p className="text-xs text-muted-foreground">{MODE_HINT[mode]}</p>
        {modeProblem && (
          <p className="text-xs text-warning" role="status">
            {modeProblem}
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor="core-domain-name">Domain</Label>
          <Input
            id="core-domain-name"
            value={domain}
            placeholder="core.example.com"
            spellCheck={false}
            autoCapitalize="off"
            disabled={disabled}
            onChange={(event) => setDomain(event.target.value)}
            aria-invalid={touched && !domainCheck.ok}
            aria-describedby="core-domain-name-hint"
          />
          <p id="core-domain-name-hint" className="text-xs text-muted-foreground">
            {touched && !domainCheck.ok
              ? domainCheck.reason
              : 'One name of your own, such as a subdomain.'}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="core-domain-sources">Allowed from</Label>
          <Textarea
            id="core-domain-sources"
            rows={3}
            value={sources}
            placeholder={'203.0.113.7\n10.0.0.0/8'}
            disabled={disabled}
            onChange={(event) => setSources(event.target.value)}
            aria-invalid={touched && !sourcesCheck.ok}
            aria-describedby="core-domain-sources-hint"
            className="font-mono text-xs"
          />
          <p id="core-domain-sources-hint" className="text-xs text-muted-foreground">
            {touched && !sourcesCheck.ok
              ? sourcesCheck.reason
              : "Addresses or networks, one per line. Leave it empty to allow every address; this computer's device key is still required."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={disabled || busy || modeProblem !== null || (touched && !valid)}
        >
          {busy ? (
            <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : (
            <Globe className="h-3.5 w-3.5" />
          )}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="soft" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          This asks for your password again if you have not confirmed it in the last 10 minutes.
        </span>
      </div>
    </form>
  );
}

/** Why the chosen mode cannot be saved as it stands, or null. The core refuses the same. */
function problemWith(
  mode: CoreDomainMode,
  originLocked: boolean,
  sources: string[],
): string | null {
  if (mode === 'direct' && originLocked) {
    return 'The Cloudflare origin lock is on, so only Cloudflare reaches ports 80 and 443. Choose Through Cloudflare, or turn the lock off under Firewall.';
  }
  if (mode === 'cloudflare' && !originLocked && sources.length > 0) {
    return "Through Cloudflare, nginx only learns the visitor's address while the Cloudflare origin lock is on. Turn the lock on under Firewall, or leave the sources empty.";
  }
  return null;
}
