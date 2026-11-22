import { ArrowRight } from '@/components/icons';
import { redirectExample } from '@/lib/deploy/sites/redirects';
import { ChoiceCards, FieldError, Section, TextField, ToggleRow } from './fields';
import type { SiteTabProps } from './tabTypes';

/**
 * What the site does with a visit: pass it to a port on this server or to another address, or
 * send the visitor somewhere else altogether.
 */

const KINDS = [
  {
    value: 'servicePort',
    label: 'A port on this server',
    description: 'An app or stack service listening on 127.0.0.1.',
  },
  {
    value: 'url',
    label: 'An address',
    description: 'Any http:// or https:// URL nginx can reach.',
  },
  {
    value: 'redirect',
    label: 'Redirect to another address',
    description: 'Send visitors somewhere else, such as an old domain to a new one.',
  },
] as const;

const REDIRECT_KINDS = [
  {
    value: 'permanent',
    label: 'Permanent (301)',
    description: 'Browsers and search engines remember the new address. Best for moved domains.',
  },
  {
    value: 'temporary',
    label: 'Temporary (302)',
    description: 'Nothing is remembered. For a short while, or while you test.',
  },
] as const;

function RedirectFields({ draft, set, error, readOnly }: SiteTabProps): React.JSX.Element {
  const example = redirectExample(draft.domains[0] ?? '', draft.redirectTo, draft.redirectKeepPath);
  return (
    <>
      <TextField
        label="Send visitors to"
        value={draft.redirectTo}
        onChange={(redirectTo) => set({ redirectTo })}
        error={error('upstream')}
        hint="The full address, such as https://example.com or https://example.com/blog."
        placeholder="https://example.com"
        inputMode="url"
        disabled={readOnly}
        mono
      />
      <ChoiceCards
        label="Kind of redirect"
        options={REDIRECT_KINDS}
        value={draft.redirectPermanent ? 'permanent' : 'temporary'}
        onChange={(kind) => set({ redirectPermanent: kind === 'permanent' })}
        disabled={readOnly}
        className="sm:grid-cols-2"
      />
      <ToggleRow
        label="Keep the path and query"
        description="A visit to /pricing?plan=pro lands on the same page at the new address. Off sends everyone to the address exactly as written."
        checked={draft.redirectKeepPath}
        onChange={(redirectKeepPath) => set({ redirectKeepPath })}
        disabled={readOnly}
      />
      <div
        role="group"
        aria-label="Example"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-foreground/[0.03] px-3 py-2 font-mono text-xs ring-1 ring-inset ring-foreground/[0.07]"
      >
        <span className="font-sans text-muted-foreground">For example</span>
        <span className="min-w-0 break-all text-foreground">{example.from}</span>
        <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-primary" />
        <span className="sr-only">goes to</span>
        <span className="min-w-0 break-all text-foreground">{example.to}</span>
      </div>
    </>
  );
}

export function ProxyTab(props: SiteTabProps): React.JSX.Element {
  const { draft, set, error, readOnly } = props;
  const redirect = draft.upstreamKind === 'redirect';
  return (
    <div className="space-y-2">
      <Section
        title="Where visitors go"
        description="Pass each request on to an app, or send visitors to another address."
      >
        <ChoiceCards
          label="Upstream kind"
          options={KINDS}
          value={draft.upstreamKind}
          onChange={(upstreamKind) => set({ upstreamKind })}
          disabled={readOnly}
          className="sm:grid-cols-3"
        />
        {redirect ? (
          <RedirectFields {...props} />
        ) : draft.upstreamKind === 'servicePort' ? (
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <TextField
              label="Service name"
              value={draft.service}
              onChange={(service) => set({ service })}
              hint="Shown on the route map. Leave empty for a plain local port."
              placeholder="web"
              disabled={readOnly}
              mono
            />
            <TextField
              label="Port"
              value={draft.port}
              onChange={(port) => set({ port })}
              placeholder="3000"
              inputMode="numeric"
              disabled={readOnly}
              mono
            />
          </div>
        ) : (
          <TextField
            label="Address"
            value={draft.url}
            onChange={(url) => set({ url })}
            placeholder="http://10.0.0.5:8080"
            inputMode="url"
            disabled={readOnly}
            mono
          />
        )}
        {!redirect && <FieldError message={error('upstream')} />}
        {draft.upstreamKind === 'url' && (
          <>
            <ToggleRow
              label="Check the upstream's certificate"
              description="For https:// addresses. Turn off only for a self-signed certificate you trust."
              checked={draft.verifyCertificate}
              onChange={(verifyCertificate) => set({ verifyCertificate })}
              disabled={readOnly}
            />
            <ToggleRow
              label="Send the upstream's own host name"
              description="Instead of the domain the visitor asked for. Some hosted services need this."
              checked={draft.sendUpstreamHost}
              onChange={(sendUpstreamHost) => set({ sendUpstreamHost })}
              disabled={readOnly}
            />
          </>
        )}
      </Section>
      {!redirect && (
        <Section title="Connections">
          <ToggleRow
            label="WebSockets"
            description="Lets live connections (chat, dashboards, hot reload) through to the app."
            checked={draft.websocket}
            onChange={(websocket) => set({ websocket })}
            disabled={readOnly}
          />
        </Section>
      )}
    </div>
  );
}
