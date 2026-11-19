/**
 * `GET /sign-in-settings`: the captcha, Google, Apple and Microsoft switches and keys (E52, E116).
 * Secrets never come back.
 */
export interface SignInSettings {
  captchaEnabled: boolean;
  turnstileSiteKey: string | null;
  hasTurnstileSecret: boolean;
  googleEnabled: boolean;
  /** Whether "Continue with Google" shows, with keys from here or the environment. */
  googleActive: boolean;
  googleClientId: string | null;
  hasGoogleClientSecret: boolean;
  /** A Google key left empty here comes from `Authentication__Google__*`. */
  googleFromEnvironment: boolean;
  googleCallbackUrl: string;
  appleEnabled: boolean;
  appleActive: boolean;
  /** The Services ID the website signs in as. */
  appleServicesId: string | null;
  appleTeamId: string | null;
  appleKeyId: string | null;
  hasApplePrivateKey: boolean;
  /** The phone app's bundle id, for Sign in with Apple in the app (E117). */
  appleBundleId: string;
  appleFromEnvironment: boolean;
  appleCallbackUrl: string;
  microsoftEnabled: boolean;
  microsoftActive: boolean;
  microsoftClientId: string | null;
  hasMicrosoftClientSecret: boolean;
  microsoftFromEnvironment: boolean;
  microsoftCallbackUrl: string;
  /** Accounts with a linked login and no password. */
  externalOnlyAccounts: number;
  updatedAt: string | null;
  version: string;
}

/** The form behind the settings page. Secrets start empty: typed means replace. */
export interface SignInSettingsForm {
  captchaEnabled: boolean;
  turnstileSiteKey: string;
  turnstileSecret: string;
  googleEnabled: boolean;
  googleClientId: string;
  googleClientSecret: string;
  appleEnabled: boolean;
  appleServicesId: string;
  appleTeamId: string;
  appleKeyId: string;
  applePrivateKey: string;
  appleBundleId: string;
  microsoftEnabled: boolean;
  microsoftClientId: string;
  microsoftClientSecret: string;
}

export const fromSettings = (settings: SignInSettings): SignInSettingsForm => ({
  captchaEnabled: settings.captchaEnabled,
  turnstileSiteKey: settings.turnstileSiteKey ?? '',
  turnstileSecret: '',
  googleEnabled: settings.googleEnabled,
  googleClientId: settings.googleClientId ?? '',
  googleClientSecret: '',
  appleEnabled: settings.appleEnabled,
  appleServicesId: settings.appleServicesId ?? '',
  appleTeamId: settings.appleTeamId ?? '',
  appleKeyId: settings.appleKeyId ?? '',
  applePrivateKey: '',
  appleBundleId: settings.appleBundleId,
  microsoftEnabled: settings.microsoftEnabled,
  microsoftClientId: settings.microsoftClientId ?? '',
  microsoftClientSecret: '',
});

/**
 * Whether saving needs the settings check: turning the captcha on, or giving it new keys while
 * it is on. The API refuses such a save without a token the new keys produced.
 */
export function needsCaptchaCheck(settings: SignInSettings, form: SignInSettingsForm): boolean {
  if (!form.captchaEnabled) return false;
  const siteKey = form.turnstileSiteKey.trim() || null;
  return (
    !settings.captchaEnabled ||
    siteKey !== settings.turnstileSiteKey ||
    form.turnstileSecret.trim() !== ''
  );
}

/** Whether this save turns off a provider that was on. */
export const turnsProviderOff = (settings: SignInSettings, form: SignInSettingsForm) =>
  (settings.googleEnabled && !form.googleEnabled) ||
  (settings.appleEnabled && !form.appleEnabled) ||
  (settings.microsoftEnabled && !form.microsoftEnabled);

/** The merge patch for a save. A secret goes only when one was typed. */
export function patchBody(form: SignInSettingsForm, captchaToken: string | null) {
  const secret = (value: string) => value.trim();
  const text = (value: string) => value.trim() || null;
  return {
    captchaEnabled: form.captchaEnabled,
    turnstileSiteKey: text(form.turnstileSiteKey),
    ...(secret(form.turnstileSecret) && { turnstileSecret: secret(form.turnstileSecret) }),
    ...(captchaToken && { captchaToken }),
    googleEnabled: form.googleEnabled,
    googleClientId: text(form.googleClientId),
    ...(secret(form.googleClientSecret) && { googleClientSecret: secret(form.googleClientSecret) }),
    appleEnabled: form.appleEnabled,
    appleServicesId: text(form.appleServicesId),
    appleTeamId: text(form.appleTeamId),
    appleKeyId: text(form.appleKeyId),
    ...(secret(form.applePrivateKey) && { applePrivateKey: secret(form.applePrivateKey) }),
    appleBundleId: text(form.appleBundleId),
    microsoftEnabled: form.microsoftEnabled,
    microsoftClientId: text(form.microsoftClientId),
    ...(secret(form.microsoftClientSecret) && {
      microsoftClientSecret: secret(form.microsoftClientSecret),
    }),
  };
}
