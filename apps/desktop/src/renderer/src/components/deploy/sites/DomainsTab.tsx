import { EmailGateShortcut } from '@/components/cloudflare/access/EmailGateShortcut';
import { Plus, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { suggestId } from '@/lib/deploy/sites/draft';
import { FieldError, Section, TextField } from './fields';
import type { SiteTabProps } from './tabTypes';

/** The names a site answers to, and the id it is saved under. */

const MAX_DOMAINS = 50;

export function DomainsTab({
  draft,
  set,
  error,
  readOnly,
  savedDomains = [],
}: SiteTabProps): React.JSX.Element {
  function setDomain(index: number, value: string): void {
    const domains = draft.domains.map((domain, at) => (at === index ? value : domain));
    // A new site's id follows its first domain until someone types one of their own.
    const followsDomain =
      draft.isNew && (draft.id === '' || draft.id === suggestId(draft.domains[0] ?? ''));
    set({ domains, ...(index === 0 && followsDomain ? { id: suggestId(value) } : {}) });
  }

  return (
    <div className="space-y-2">
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
