import { EmailGateShortcut } from '@/components/cloudflare/access/EmailGateShortcut';
import { ArrowRight, Plus, Sparkles, Trash2, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { suggestId } from '@/lib/deploy/sites/draft';
import { applyRedirectSuggestion, suggestRedirect } from '@/lib/deploy/sites/redirects';
import { FieldError, Section, TextField } from './fields';
import type { SiteTabProps } from './tabTypes';

/** The names a site answers to, the names that send visitors on to it, and its id. */

const MAX_DOMAINS = 50;

/**
 * Other names that send visitors on to the site's first domain (www to the bare domain, the
 * usual case), with the counterpart of the first domain offered in one click.
 */
function RedirectedHere({ draft, set, error, readOnly }: SiteTabProps): React.JSX.Element {
  const primary = (draft.domains[0] ?? '').trim().toLowerCase();
  const suggestion = suggestRedirect(draft.domains, draft.redirectDomains);
  const rows = draft.redirectDomains;
  const setRow = (index: number, value: string) =>
    set({
      redirectDomains: rows.map((row, at) => (at === index ? value : row)),
    });
  return (
    <Section
      title="Redirected here"
      description={`Other names that send visitors on to ${primary || 'the first domain'}, keeping the path. They share this site's certificate, so point them at this server in DNS too.`}
    >
      {rows.length > 0 && (
        <ul aria-label="Redirected names" className="space-y-2">
          {rows.map((name, index) => (
            <li key={index} className="space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Redirected name ${index + 1}`}
                  value={name}
                  onChange={(event) => setRow(index, event.target.value)}
                  placeholder={primary ? `www.${primary}` : 'www.example.com'}
                  disabled={readOnly}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={error(`redirectDomains[${index}]`) ? true : undefined}
                  className="font-mono"
                />
                <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="sr-only">goes to</span>
                <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted-foreground">
                  {primary || 'the first domain'}
                </span>
                {!readOnly && (
                  <SimpleTooltip label="Remove">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove ${name || `redirected name ${index + 1}`}`}
                      onClick={() =>
                        set({
                          redirectDomains: rows.filter((_, at) => at !== index),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </SimpleTooltip>
                )}
              </div>
              <FieldError message={error(`redirectDomains[${index}]`)} />
            </li>
          ))}
        </ul>
      )}
      <FieldError message={error('redirectDomains')} />
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          {suggestion && (
            <Button
              type="button"
              size="sm"
              onClick={() => set(applyRedirectSuggestion(draft, suggestion))}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {suggestion.move
                ? `Redirect ${suggestion.name} here instead of serving it`
                : `Redirect ${suggestion.name} here`}
            </Button>
          )}
          {rows.length < MAX_DOMAINS && (
            <Button
              type="button"
              variant="soft"
              size="sm"
              onClick={() => set({ redirectDomains: [...rows, ''] })}
            >
              <Plus className="h-3.5 w-3.5" /> Add a name
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

export function DomainsTab(
  props: SiteTabProps & {
    /** Saved names the site's certificate does not cover yet. */
    uncovered?: readonly string[];
  },
): React.JSX.Element {
  const { draft, set, error, readOnly, savedDomains = [], uncovered = [] } = props;
  function setDomain(index: number, value: string): void {
    const domains = draft.domains.map((domain, at) => (at === index ? value : domain));
    // A new site's id follows its first domain until someone types one of their own.
    const followsDomain =
      draft.isNew && (draft.id === '' || draft.id === suggestId(draft.domains[0] ?? ''));
    set({ domains, ...(index === 0 && followsDomain ? { id: suggestId(value) } : {}) });
  }

  return (
    <div className="space-y-2">
      {uncovered.length > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-warning/30"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            The certificate does not cover {uncovered.join(', ')} yet. Apply the change, then issue
            the certificate again on the SSL tab.
          </span>
        </p>
      )}
      <Section
        title="Domains"
        description="Every name this site answers to. Point each one at this server in DNS before you issue a certificate. Write *.example.com for every subdomain."
      >
        <ul aria-label="Domains" className="space-y-2">
          {draft.domains.map((domain, index) => (
            <li key={index} className="space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Domain ${index + 1}`}
                  value={domain}
                  onChange={(event) => setDomain(index, event.target.value)}
                  placeholder={index === 0 ? 'app.example.com' : 'www.example.com'}
                  disabled={readOnly}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={error(`domains[${index}]`) ? true : undefined}
                  className="font-mono"
                />
                {draft.domains.length > 1 && !readOnly && (
                  <SimpleTooltip label="Remove">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove ${domain || `domain ${index + 1}`}`}
                      onClick={() =>
                        set({ domains: draft.domains.filter((_, at) => at !== index) })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </SimpleTooltip>
                )}
              </div>
              <FieldError message={error(`domains[${index}]`)} />
              {/* Saved names only, so typing a domain does not look it up at Cloudflare. */}
              {savedDomains.includes(domain) && !domain.includes('*') && (
                <EmailGateShortcut hostname={domain} />
              )}
            </li>
          ))}
        </ul>
        <FieldError message={error('domains')} />
        {!readOnly && draft.domains.length < MAX_DOMAINS && (
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => set({ domains: [...draft.domains, ''] })}
          >
            <Plus className="h-3.5 w-3.5" /> Add a domain
          </Button>
        )}
      </Section>
      {draft.upstreamKind !== 'redirect' && <RedirectedHere {...props} />}
      <Section title="Site id" description="Names the site's files and logs on the server.">
        <TextField
          label="Id"
          value={draft.id}
          onChange={(id) => set({ id: id.toLowerCase() })}
          error={error('id')}
          hint={
            draft.isNew ? 'Lowercase letters, digits and hyphens.' : 'Fixed once the site is saved.'
          }
          disabled={readOnly || !draft.isNew}
          mono
        />
      </Section>
    </div>
  );
}
