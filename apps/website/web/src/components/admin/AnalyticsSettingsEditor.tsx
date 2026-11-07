import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  type AnalyticsSettings,
  type AnalyticsSettingsForm,
  analyticsPatchBody,
  fromAnalyticsSettings,
  isLive,
  type TextField,
} from '@/lib/admin/analyticsSettings';
import { apiRequest, type Problem } from '@/lib/admin/api';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import { ConflictDialog } from './ConflictDialog';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { Switch } from './SecretField';

const PATH = '/analytics-settings';
const asEtag = (version: string) => `"${version}"`;

/** One kind of ID: its label, a hint on where to find it, and what one looks like. */
const FIELDS: Record<TextField, { label: string; hint: ReactNode; placeholder: string }> = {
  googleAnalyticsIds: {
    label: 'Google Analytics measurement IDs',
    hint: 'Google Analytics, Admin, Data streams, your web stream. Up to 5, separated by commas.',
    placeholder: 'G-XXXXXXXXXX',
  },
  googleAdsIds: {
    label: 'Google Ads tag IDs',
    hint: 'Google Ads, Tools, Data manager, Google tag. Up to 5, separated by commas.',
    placeholder: 'AW-123456789',
  },
  googleTagManagerId: {
    label: 'Google Tag Manager container ID',
    hint: "Google's built-in tags work in the container. Custom HTML tags and Custom JavaScript variables are blocked by the site's security policy.",
    placeholder: 'GTM-XXXXXXX',
  },
  googleSiteVerification: {
    label: 'Search Console verification file',
    hint: 'In Search Console, pick the HTML file method and paste the file name it gives you. The site serves the file itself, so there is nothing to upload.',
    placeholder: 'google1234567890abcdef.html',
  },
  clarityProjectId: {
    label: 'Microsoft Clarity project ID',
    hint: 'Clarity, your project, Settings, Overview. Clarity records how visitors move through pages, with heatmaps.',
    placeholder: 'abcd1234ef',
  },
  bingUetTagId: {
    label: 'Microsoft Advertising (Bing) UET tag ID',
    hint: 'Microsoft Advertising, Tools, UET tag. Digits only.',
    placeholder: '187654321',
  },
  bingSiteVerification: {
    label: 'Bing Webmaster verification code',
    hint: 'In Bing Webmaster Tools, pick the XML file method and paste the code inside the <user> tag of BingSiteAuth.xml. The site serves the file itself.',
    placeholder: '0123456789ABCDEF0123456789ABCDEF',
  },
};

/** The tracking tags, the site verifications and the consent banner of the public site, for Admins. */
export default function AnalyticsSettingsEditor() {
  const [settings, setSettings] = useState<AnalyticsSettings | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [form, setForm] = useState<AnalyticsSettingsForm | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const saving = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);

  const show = useCallback((next: AnalyticsSettings, nextEtag: string | null) => {
    setSettings(next);
    setEtag(nextEtag ?? asEtag(next.version));
    setForm(fromAnalyticsSettings(next));
  }, []);

  const load = useCallback(async () => {
    const response = await apiRequest<AnalyticsSettings>(PATH);
    if (!response.ok) {
      setProblem(response.problem);
      return;
    }
    show(response.value, response.etag);
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  if (!settings || !form) {
    return problem ? (
      <ErrorSummary problem={problem} summaryRef={summary} />
    ) : (
      <p className="text-muted-foreground text-sm">Loading the analytics settings…</p>
    );
  }

  const set = (patch: Partial<AnalyticsSettingsForm>) => {
    setMessage(null);
    setForm((current) => (current ? { ...current, ...patch } : current));
  };

  const save = async (ifMatch = etag ?? asEtag(settings.version)) => {
    if (saving.current) return;
    saving.current = true;
    setMessage(null);
    const response = await apiRequest<AnalyticsSettings>(PATH, {
      method: 'PATCH',
      body: analyticsPatchBody(form),
      ifMatch,
    });
    saving.current = false;
    if (response.ok) {
      show(response.value, response.etag);
      setProblem(null);
      setErrors({});
      setMessage('Saved. Visitors get the change within a few minutes.');
      return;
    }
    const failure = response.problem;
    if (failure.status === 412) {
      setConflict(failure.currentVersion ?? null);
      return;
    }
    setErrors(failure.errors);
    setProblem(failure);
  };

  const text = (name: TextField) => {
    const { label, hint, placeholder } = FIELDS[name];
    return (
      <Field key={name} id={name} label={label} hint={hint} errors={errorsFor(errors, name)}>
        {(control) => (
          <Input
            {...control}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={form[name]}
            onChange={(event) => set({ [name]: event.target.value })}
          />
        )}
      </Field>
    );
  };

  const section = (id: string, title: string, intro: ReactNode, children: ReactNode) => (
    <section className="grid gap-4 rounded-box border p-5" aria-labelledby={`${id}-heading`}>
      <div>
        <h2 id={`${id}-heading`} className="font-semibold text-lg">
          {title}
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">{intro}</p>
      </div>
      {children}
    </section>
  );

  const live = isLive(settings);
  const switchErrors = (name: string) =>
    errorsFor(errors, name).map((message) => (
      <p key={message} className="font-medium text-destructive text-sm">
        {message}
      </p>
    ));

  return (
    <form
      noValidate
      className="grid max-w-2xl gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <ErrorSummary problem={problem} summaryRef={summary} />

      {section(
        'tracking',
        'Tracking',
        live
          ? settings.consentBannerEnabled
            ? 'The tags load on the public pages for visitors who allow them.'
            : 'The tags load on the public pages.'
          : 'The tags are off. No page loads anything from Google or Microsoft.',
        <>
          <p className="text-sm">
            Tags load on the public pages only, never on the admin pages or in the account panel.
            The verifications below are served whether the tags are on or not.
          </p>
          <Switch checked={form.tagsEnabled} onChange={(on) => set({ tagsEnabled: on })}>
            Load the tracking tags on the public pages
          </Switch>
          {switchErrors('tagsEnabled')}
        </>,
      )}

      {section(
        'google',
        'Google',
        'Analytics, Ads and Tag Manager share one Google tag on the page.',
        <>
          {text('googleAnalyticsIds')}
          {text('googleAdsIds')}
          {text('googleTagManagerId')}
          {text('googleSiteVerification')}
        </>,
      )}

      {section(
        'microsoft',
        'Microsoft',
        'Clarity for how visitors use the site, UET for Microsoft Advertising, and Bing Webmaster Tools.',
        <>
          {text('clarityProjectId')}
          {text('bingUetTagId')}
          {text('bingSiteVerification')}
        </>,
      )}

      {section(
        'consent',
        'Cookie consent',
        'Needed where visitors must agree before analytics cookies are set, such as the EU and the UK.',
        <>
          <Switch
            checked={form.consentBannerEnabled}
            onChange={(on) => set({ consentBannerEnabled: on })}
          >
            Ask each visitor first, and load no tag until they allow it
          </Switch>
          <p className="text-muted-foreground text-sm">
            The banner offers Allow and Decline, and Cookie settings in the footer opens it again.
            Google and Clarity are told when a visitor allows them.
          </p>
          {switchErrors('consentBannerEnabled')}
        </>,
      )}

      <div className="flex items-center gap-4">
        <Button ref={saveButton} type="submit">
          Save
        </Button>
        {message && (
          <p className="text-sm" role="status">
            {message}
          </p>
        )}
      </div>

      <ConflictDialog
        open={conflict !== null}
        returnFocus={saveButton}
        onCancel={() => setConflict(null)}
        onLoadTheirs={() => {
          setConflict(null);
          setProblem(null);
          setErrors({});
          void load();
        }}
        onOverwrite={() => {
          const version = conflict;
          setConflict(null);
          if (version) void save(asEtag(version));
        }}
      />
    </form>
  );
}
