import { FieldError, Section, TextField, ToggleRow } from './fields';
import type { SiteTabProps } from './tabTypes';

/**
 * Compression, the proxy cache, how large a request may be and how long nginx waits. A redirect
 * site reaches no app, so it has no cache and no timeouts.
 */

export function PerformanceTab({ draft, set, error, readOnly }: SiteTabProps): React.JSX.Element {
  const proxies = draft.upstreamKind !== 'redirect';
  return (
    <div className="space-y-2">
      <Section title="Compression">
        <ToggleRow
          label="Gzip"
          description="Compresses text responses (HTML, CSS, JavaScript, JSON) on the way out."
          checked={draft.gzip}
          onChange={(gzip) => set({ gzip })}
          disabled={readOnly}
        />
      </Section>
      {proxies && (
        <Section
          title="Proxy cache"
          description="nginx keeps successful responses and serves them again without asking the app."
        >
          <ToggleRow
            label="Cache responses"
            checked={draft.cache}
            onChange={(cache) => set({ cache })}
            disabled={readOnly}
          />
          {draft.cache && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Keep for"
                value={draft.cacheTtl}
                onChange={(cacheTtl) => set({ cacheTtl })}
                suffix="seconds"
                inputMode="numeric"
                disabled={readOnly}
              />
              <TextField
                label="Up to"
                value={draft.cacheSize}
                onChange={(cacheSize) => set({ cacheSize })}
                suffix="MB on disk"
                inputMode="numeric"
                disabled={readOnly}
              />
              <TextField
                label="Skip the cache for these cookies"
                value={draft.cacheBypass}
                onChange={(cacheBypass) => set({ cacheBypass })}
                hint="Comma separated, such as a session cookie, so signed-in pages stay fresh."
                placeholder="sessionid, wordpress_logged_in"
                disabled={readOnly}
                className="sm:col-span-2"
                mono
              />
            </div>
          )}
          <FieldError message={error('proxyCache')} />
        </Section>
      )}
      <Section title="Limits">
        <TextField
          label="Largest request body"
          value={draft.bodySize}
          onChange={(bodySize) => set({ bodySize })}
          suffix="MB"
          hint="Uploads bigger than this are turned away. Empty keeps nginx's 1 MB; 0 means no limit."
          inputMode="numeric"
          error={error('clientMaxBodySizeMegabytes')}
          disabled={readOnly}
        />
        {proxies && (
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="Connect timeout"
              value={draft.connectTimeout}
              onChange={(connectTimeout) => set({ connectTimeout })}
              suffix="s"
              placeholder="60"
              inputMode="numeric"
              error={error('timeouts.connectSeconds')}
              disabled={readOnly}
            />
            <TextField
              label="Read timeout"
              value={draft.readTimeout}
              onChange={(readTimeout) => set({ readTimeout })}
              suffix="s"
              placeholder="60"
              inputMode="numeric"
              error={error('timeouts.readSeconds')}
              disabled={readOnly}
            />
            <TextField
              label="Send timeout"
              value={draft.sendTimeout}
              onChange={(sendTimeout) => set({ sendTimeout })}
              suffix="s"
              placeholder="60"
              inputMode="numeric"
              error={error('timeouts.sendSeconds')}
              disabled={readOnly}
            />
          </div>
        )}
      </Section>
    </div>
  );
}
