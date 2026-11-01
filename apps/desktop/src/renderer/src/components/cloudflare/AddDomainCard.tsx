import { checkNewDomain } from '@shared/cloudflare/newDomain';
import { cloudflareErrorMessage } from '@shared/cloudflareErrors';
import type { CloudflareAccountStatus, CloudflareZone } from '@shared/cloudflareTypes';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, CircleCheck, Globe, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { Field, Notice, Problem } from './fields';
import { NameServerList } from './NameServers';
import { GuidedFix } from './server/GuidedFix';

/**
 * Adding a domain to Cloudflare from the page, drawn in place of the zone the way connecting an
 * account is. First the domain (a pasted web address is fine) and, when the tokens reach more
 * than one Cloudflare account, which one; then, once Cloudflare has made the zone, what to do at
 * the registrar, with the two name servers to copy. Nothing reaches visitors until that is done,
 * which the steps say plainly so adding a live domain is not frightening.
 */

interface Choice {
  key: string;
  /** Runova's id for the connected account whose token makes the zone. */
  accountId: string;
  cloudflareAccountId: string;
  label: string;
}

function NumberedStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary ring-1 ring-inset ring-primary/20"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** What to do at the registrar once the zone is made. */
function RegistrarSteps({
  zone,
  onOpen,
}: {
  zone: CloudflareZone;
  onOpen: () => void;
}): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <div className="flex items-start gap-3">
        <CircleCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-success" />
        <div className="min-w-0">
          <h3
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold leading-tight tracking-tight focus:outline-none"
          >
            Point {zone.name} at Cloudflare
          </h3>
          <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
            Cloudflare added the domain and copied the DNS records it could find. Visitors still
            reach it the old way until your registrar uses Cloudflare's name servers.
          </p>
        </div>
      </div>
      <ol className="mt-5 max-w-xl space-y-5">
        <NumberedStep number={1} title="Sign in where you bought the domain">
          <p className="text-sm text-muted-foreground">
            That is your registrar. Find the domain's name server settings, sometimes listed as
            nameservers or custom DNS.
          </p>
        </NumberedStep>
        <NumberedStep number={2} title="Replace the name servers with these">
          <p className="text-sm text-muted-foreground">
            Remove the ones there now, so only Cloudflare's are left.
          </p>
          <NameServerList servers={zone.nameServers} />
        </NumberedStep>
        <NumberedStep number={3} title="Wait for Cloudflare to notice">
          <p className="text-sm text-muted-foreground">
            It usually takes a few minutes and can take up to a day. Cloudflare emails you when the
            domain is active, and this page shows it too.
          </p>
        </NumberedStep>
      </ol>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="button" onClick={onOpen}>
          Open {zone.name} <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </section>
  );
}

export function AddDomainCard({
  accounts,
  zones,
  defaultAccountId,
  onCancel,
  onOpen,
}: {
  /** The connected accounts; each token is asked which Cloudflare accounts it can add to. */
  accounts: CloudflareAccountStatus[];
  /** Every zone already listed, so a domain that is here gets opened rather than added twice. */
  zones: CloudflareZone[];
  /** The account to choose first, such as the one whose domain was open. */
  defaultAccountId?: string;
  onCancel: () => void;
  /** Opens a zone: the new one, or one that was already here. */
  onOpen: (zone: CloudflareZone) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const headingId = useId();
  const domainId = useId();
  const accountId = useId();
  const hintId = useId();
  const problemId = useId();
  const domainRef = useRef<HTMLInputElement>(null);
  const [domain, setDomain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [created, setCreated] = useState<CloudflareZone | null>(null);

  useEffect(() => domainRef.current?.focus(), []);

  const several = accounts.length > 1;
  const choiceQueries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.cloudflareAccountChoices(account.id),
      queryFn: () => window.runova.cloudflare.cloudflareAccounts(account.id),
    })),
  });
  const loadingChoices = choiceQueries.some((query) => query.isPending);
  const choices: Choice[] = accounts.flatMap((account, index) =>
    (choiceQueries[index]?.data ?? []).map((cloudflare) => {
      const name = cloudflare.name || 'Cloudflare account';
      return {
        key: `${account.id}:${cloudflare.id}`,
        accountId: account.id,
        cloudflareAccountId: cloudflare.id,
        label: several ? `${name} (${account.label})` : name,
      };
    }),
  );
  const choicesError = choiceQueries.find((query) => query.error)?.error;
  const preferred = choices.find((choice) => choice.accountId === defaultAccountId) ?? choices[0];
  const choice = choices.find((candidate) => candidate.key === picked) ?? preferred;

  const typed = domain.trim();
  const check = typed ? checkNewDomain(typed) : null;
  const existing =
    check?.ok === true ? zones.find((zone) => zone.name.toLowerCase() === check.name) : undefined;

  if (created) {
    return <RegistrarSteps zone={created} onOpen={() => onOpen(created)} />;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !choice || existing) return;
    const result = checkNewDomain(domain);
    if (!result.ok) {
      setProblem(result.problem);
      domainRef.current?.focus();
      return;
    }
    setProblem(null);
    setFailure(null);
    setBusy(true);
    try {
      const zone = await window.runova.cloudflare.createZone(choice.accountId, {
        name: result.name,
        cloudflareAccountId: choice.cloudflareAccountId,
      });
      const key = queryKeys.cloudflareAccountZones(choice.accountId);
      queryClient.setQueryData<CloudflareZone[]>(key, (listed) => [
        ...(listed ?? []).filter((candidate) => candidate.id !== zone.id),
        zone,
      ]);
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success(`${zone.name} is on Cloudflare now.`);
      setCreated(zone);
    } catch (error) {
      // Refreshes the token card when the refusal was about the token.
      cloudflareFailureText(error, queryClient);
      setFailure(error);
      setBusy(false);
    }
  }

  const describedBy = [problem ? problemId : null, check?.ok ? hintId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0"
      onKeyDown={(event) => {
        // Escape goes back, unless it is closing the account list's popover.
        if (event.key !== 'Escape' || busy) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-radix-popper-content-wrapper]')) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12">
          <Globe aria-hidden className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 id={headingId} className="text-base font-semibold leading-tight tracking-tight">
            Add a domain
          </h3>
          <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
            Cloudflare copies the DNS records it can find for the domain. Nothing changes for
            visitors until you switch the domain's name servers, which the next step walks you
            through.
          </p>
        </div>
      </div>

      <form className="mt-5 max-w-xl space-y-4" noValidate onSubmit={(event) => void submit(event)}>
        <Field label="Domain" htmlFor={domainId}>
          <Input
            id={domainId}
            ref={domainRef}
            value={domain}
            placeholder="example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            disabled={busy}
            aria-invalid={problem ? true : undefined}
            aria-describedby={describedBy || undefined}
            onChange={(event) => {
              setDomain(event.target.value);
              setProblem(null);
              setFailure(null);
            }}
          />
        </Field>
        {problem && (
          <p id={problemId} role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        {check?.ok && existing && (
          <Notice
            id={hintId}
            size="sm"
            className="items-center"
            action={
              <Button type="button" size="sm" variant="soft" onClick={() => onOpen(existing)}>
                Open {existing.name}
              </Button>
            }
          >
            {existing.name} is already here, so there is nothing to add.
          </Notice>
        )}
        {check?.ok && !existing && check.suggestion && (
          <Notice
            id={hintId}
            size="sm"
            className="items-center"
            action={
              <Button
                type="button"
                size="sm"
                variant="soft"
                onClick={() => {
                  setDomain(check.suggestion ?? '');
                  domainRef.current?.focus();
                }}
              >
                Use {check.suggestion}
              </Button>
            }
          >
            Cloudflare adds the main domain, and www comes with it.
          </Notice>
        )}

        {loadingChoices ? (
          <div className="space-y-1.5" aria-busy="true">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ) : choices.length === 0 ? (
          <Problem
            message={
              choicesError
                ? cloudflareErrorMessage(choicesError)
                : 'No Cloudflare account was found for these tokens.'
            }
            onRetry={() => {
              for (const query of choiceQueries) if (query.error) void query.refetch();
            }}
          />
        ) : choices.length === 1 && choice ? (
          <p className="text-sm text-muted-foreground">
            Goes into the Cloudflare account{' '}
            <span className="font-medium text-foreground">{choice.label}</span>.
          </p>
        ) : (
          <Field label="Cloudflare account" htmlFor={accountId}>
            <Combobox
              id={accountId}
              ariaLabel="Cloudflare account"
              searchable={choices.length > 6}
              disabled={busy}
              options={choices.map((candidate) => ({
                value: candidate.key,
                label: candidate.label,
              }))}
              value={choice?.key ?? ''}
              onChange={(key) => setPicked(key)}
            />
          </Field>
        )}

        {Boolean(failure) && <GuidedFix error={failure} />}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="submit" disabled={busy || !choice || Boolean(existing)}>
            {busy ? (
              <>
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" /> Adding to Cloudflare…
              </>
            ) : (
              'Add domain'
            )}
          </Button>
          <Button type="button" variant="soft" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
