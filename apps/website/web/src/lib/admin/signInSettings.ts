/** `GET /sign-in-settings`: the captcha and Google switches and keys (E52). Secrets never come back. */
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
  /** Accounts with a linked login and no password. */
  googleOnlyAccounts: number;
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
}

export const fromSettings = (settings: SignInSettings): SignInSettingsForm => ({
  captchaEnabled: settings.captchaEnabled,
  turnstileSiteKey: settings.turnstileSiteKey ?? '',
  turnstileSecret: '',
  googleEnabled: settings.googleEnabled,
  googleClientId: settings.googleClientId ?? '',
  googleClientSecret: '',
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

/** The merge patch for a save. A secret goes only when one was typed. */
export function patchBody(form: SignInSettingsForm, captchaToken: string | null) {
  const secret = (value: string) => value.trim();
  return {
    captchaEnabled: form.captchaEnabled,
    turnstileSiteKey: form.turnstileSiteKey.trim() || null,
    ...(secret(form.turnstileSecret) && { turnstileSecret: secret(form.turnstileSecret) }),
    ...(captchaToken && { captchaToken }),
    googleEnabled: form.googleEnabled,
    googleClientId: form.googleClientId.trim() || null,
    ...(secret(form.googleClientSecret) && { googleClientSecret: secret(form.googleClientSecret) }),
  };
}
