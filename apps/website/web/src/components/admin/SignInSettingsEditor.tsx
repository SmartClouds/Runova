import { useCallback, useEffect, useRef, useState } from 'react';
import { useCaptcha } from '@/components/account/Captcha';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest, type Problem } from '@/lib/admin/api';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import {
  fromSettings,
  needsCaptchaCheck,
  patchBody,
  type SignInSettings,
  type SignInSettingsForm,
} from '@/lib/admin/signInSettings';
import { ConflictDialog } from './ConflictDialog';
import { CopyField } from './CopyField';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { SecretField, Switch } from './SecretField';

const PATH = '/sign-in-settings';
const asEtag = (version: string) => `"${version}"`;

/**
 * The sign-in captcha (Cloudflare Turnstile) and Google sign-in, for Admins. Turning the captcha
 * on, or giving it new keys, first needs the check below to pass with those keys, so a wrong key
 * can not lock everyone out.
 */
export default function SignInSettingsEditor() {
  const [settings, setSettings] = useState<SignInSettings | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [form, setForm] = useState<SignInSettingsForm | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const saving = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);

  const siteKey = form?.turnstileSiteKey.trim() ?? '';
  const check = useCaptcha(
    checkedKey && checkedKey === siteKey ? { provider: 'turnstile', siteKey: checkedKey } : null,
    'settings-check',
  );

  const show = useCallback((next: SignInSettings, nextEtag: string | null) => {
    setSettings(next);
    setEtag(nextEtag ?? asEtag(next.version));
    setForm(fromSettings(next));
    setCheckedKey(null);
  }, []);

  const load = useCallback(async () => {
    const response = await apiRequest<SignInSettings>(PATH);
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
      <p className="text-muted-foreground text-sm">Loading the sign-in settings…</p>
    );
  }

  const set = (patch: Partial<SignInSettingsForm>) => {
    setMessage(null);
    setForm((current) => (current ? { ...current, ...patch } : current));
  };

  const mustCheck = needsCaptchaCheck(settings, form);
  const checked = check.token !== null && checkedKey === siteKey;

  const save = async (ifMatch = etag ?? asEtag(settings.version)) => {
    if (saving.current) return;
    saving.current = true;
    setMessage(null);
    const response = await apiRequest<SignInSettings>(PATH, {
      method: 'PATCH',
      body: patchBody(form, mustCheck ? check.token : null),
      ifMatch,
    });
    saving.current = false;
    if (response.ok) {
      show(response.value, response.etag);
      setProblem(null);
      setErrors({});
      setMessage('Saved.');
      return;
    }
    // The check's token was used up by this save, whatever the answer.
    if (mustCheck) check.reset();
    const failure = response.problem;
    if (failure.status === 412) {
      setConflict(failure.currentVersion ?? null);
      return;
    }
    check.showErrors(failure.errors.captchaToken ?? []);
    setErrors(failure.errors);
    setProblem(failure);
  };

  const googleOff = !form.googleEnabled && settings.googleEnabled;
  const people = settings.googleOnlyAccounts;

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

      <section className="grid gap-4 rounded-box border p-5" aria-labelledby="captcha-heading">
        <div>
          <h2 id="captcha-heading" className="font-semibold text-lg">
            Captcha
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            Cloudflare Turnstile, on account and staff sign-in, sign-up, password reset and new
            confirmation links. Make a widget for this domain in the Cloudflare dashboard (or on the
            Runova app's Cloudflare page) and paste its keys here.
          </p>
        </div>
        <Switch checked={form.captchaEnabled} onChange={(on) => set({ captchaEnabled: on })}>
          Ask for a captcha on sign-in, sign-up and password reset
        </Switch>
        <Field
          id="turnstile-site-key"
          label="Site key"
          errors={errorsFor(errors, 'turnstileSiteKey')}
        >
          {(control) => (
            <Input
              {...control}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={form.turnstileSiteKey}
              onChange={(event) => set({ turnstileSiteKey: event.target.value })}
            />
          )}
        </Field>
        <SecretField
          id="turnstile-secret"
          label="Secret key"
          noun="secret key"
          saved={settings.hasTurnstileSecret}
          value={form.turnstileSecret}
          errors={errorsFor(errors, 'turnstileSecret')}
          onChange={(value) => set({ turnstileSecret: value })}
        />
        {errorsFor(errors, 'captchaEnabled').map((text) => (
          <p key={text} className="font-medium text-destructive text-sm">
            {text}
          </p>
        ))}
        {mustCheck && (
          <div className="grid gap-3 rounded-box bg-muted/40 p-4">
            <p className="text-sm">
              Pass the check with these keys before saving. Cloudflare then has to accept it with
              the secret key, so a wrong key can not lock everyone out, you included.
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={siteKey === ''}
                onClick={() => (checkedKey === siteKey ? check.reset() : setCheckedKey(siteKey))}
              >
                Check these keys
              </Button>
            </div>
            {check.widget}
            {checked && <p className="text-sm">The check passed. Save to turn the captcha on.</p>}
          </div>
        )}
      </section>

      <section className="grid gap-4 rounded-box border p-5" aria-labelledby="google-heading">
        <div>
          <h2 id="google-heading" className="font-semibold text-lg">
            Google
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {settings.googleActive
              ? 'Continue with Google shows on the sign-in pages.'
              : settings.googleEnabled
                ? 'Add a client ID and secret from a Google OAuth web client to show it.'
                : 'Google sign-in is off.'}
          </p>
        </div>
        <Switch checked={form.googleEnabled} onChange={(on) => set({ googleEnabled: on })}>
          Show Continue with Google on the sign-in pages
        </Switch>
        {googleOff && people > 0 && (
          <p className="rounded-box border border-warning p-3 text-sm" role="status">
            {people === 1 ? '1 account can' : `${people} accounts can`} only sign in with Google.
            With Google off they get back in by resetting their password from the sign-in page.
          </p>
        )}
        <Field id="google-client-id" label="Client ID" errors={errorsFor(errors, 'googleClientId')}>
          {(control) => (
            <Input
              {...control}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={form.googleClientId}
              onChange={(event) => set({ googleClientId: event.target.value })}
            />
          )}
        </Field>
        <SecretField
          id="google-client-secret"
          label="Client secret"
          noun="client secret"
          saved={settings.hasGoogleClientSecret}
          value={form.googleClientSecret}
          errors={errorsFor(errors, 'googleClientSecret')}
          onChange={(value) => set({ googleClientSecret: value })}
        />
        {settings.googleFromEnvironment && (
          <p className="text-muted-foreground text-sm">
            Keys left empty here come from the server's environment (
            <code>Authentication__Google__*</code>).
          </p>
        )}
        <CopyField
          id="google-callback"
          label="Authorized redirect URI"
          value={settings.googleCallbackUrl}
          hint="Add it to the OAuth client in Google Cloud Console."
        />
      </section>

      <div className="flex items-center gap-4">
        <Button ref={saveButton} type="submit" disabled={mustCheck && !checked}>
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
