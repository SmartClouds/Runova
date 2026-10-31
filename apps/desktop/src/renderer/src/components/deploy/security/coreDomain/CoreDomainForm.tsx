import { checkCoreDomainName } from '@shared/deploy/coreDomainValidation';
import { checkSources } from '@shared/deploy/directTlsValidation';
import { useState } from 'react';
import { Globe, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * The domain and the addresses nginx lets in. Checked as the user types, with the same rules the
 * main process and the core apply again. Saving asks for a step-up when the last one ran out.
 */
export function CoreDomainForm({
  initialDomain,
  initialSources,
  busy,
  disabled = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialDomain: string;
  initialSources: string[];
  busy: boolean;
  /** nginx is missing or the origin lock is on: the form shows, but cannot be sent. */
  disabled?: boolean;
  submitLabel: string;
  onSubmit: (domain: string, sources: string[]) => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const [domain, setDomain] = useState(initialDomain);
  const [sources, setSources] = useState(initialSources.join('\n'));
  const [touched, setTouched] = useState(false);
  const domainCheck = checkCoreDomainName(domain);
  const sourcesCheck = checkSources(sources);
  const valid = domainCheck.ok && sourcesCheck.ok;

  return (
    <form
      className="space-y-4"
      aria-label="Core domain settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        setTouched(true);
        if (domainCheck.ok && sourcesCheck.ok) onSubmit(domainCheck.value, sourcesCheck.value);
      }}
    >
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
              : 'One name, pointing straight at this server.'}
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
              : "Addresses or networks, one per line. Leave it empty to allow every address; this computer's device certificate is still required."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={disabled || busy || (touched && !valid)}>
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
