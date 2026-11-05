import { useEffect, useState } from 'react';
import { apiRequest } from './api';

/** The captcha widget's public settings, while an Admin has the captcha on. */
export interface CaptchaConfig {
  provider: 'turnstile';
  siteKey: string;
}

/** What a sign-in or sign-up form offers, from `GET /sign-in-providers`. */
export interface SignInOptions {
  /** The other ways in, such as `google`. */
  providers: string[];
  /** The captcha to show, or null when it is off. */
  captcha: CaptchaConfig | null;
}

const NONE: SignInOptions = { providers: [], captcha: null };

/**
 * The sign-in options, null while they load. When they can not be read the form shows only
 * email and password; should the captcha be on after all, the API's answer says so under the form.
 */
export function useSignInOptions(): SignInOptions | null {
  const [options, setOptions] = useState<SignInOptions | null>(null);
  useEffect(() => {
    let live = true;
    void apiRequest<{ items: string[]; captcha?: CaptchaConfig | null }>('/sign-in-providers').then(
      (response) => {
        if (!live) return;
        setOptions(
          response.ok
            ? { providers: response.value.items, captcha: response.value.captcha ?? null }
            : NONE,
        );
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return options;
}
