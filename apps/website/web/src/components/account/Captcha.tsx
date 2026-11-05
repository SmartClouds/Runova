import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { FieldErrors } from '@/components/admin/Field';
import type { CaptchaConfig } from '@/lib/account/signInOptions';

/** Cloudflare's script, in explicit mode so it renders only where a form asks. */
export const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: 'auto';
      size: 'flexible';
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string | undefined;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** The Turnstile API, adding Cloudflare's script to the page the first time any form needs it. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener('load', () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not start')),
    );
    script.addEventListener('error', () => {
      loading = null;
      reject(new Error('Turnstile could not load'));
    });
    document.head.append(script);
  });
  return loading;
}

/** For tests: the next form adds the script again. */
export function forgetTurnstileScript() {
  loading = null;
}

interface WidgetProps {
  siteKey: string;
  action: string;
  resetCount: number;
  onToken: (token: string | null) => void;
  onFailed: (failed: boolean) => void;
}

function TurnstileWidget({ siteKey, action, resetCount, onToken, onFailed }: WidgetProps) {
  const host = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(
      (api) => {
        if (cancelled || !host.current) return;
        widgetId.current =
          api.render(host.current, {
            sitekey: siteKey,
            action,
            theme: 'auto',
            size: 'flexible',
            callback: (token) => {
              onFailed(false);
              onToken(token);
            },
            'expired-callback': () => onToken(null),
            'error-callback': () => {
              onToken(null);
              onFailed(true);
            },
          }) ?? null;
      },
      () => {
        if (!cancelled) onFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, action, onToken, onFailed]);

  useEffect(() => {
    if (resetCount > 0 && widgetId.current) window.turnstile?.reset(widgetId.current);
  }, [resetCount]);

  return <div ref={host} className="min-h-[65px]" />;
}

export interface Captcha {
  /** Whether the form must send a token: the captcha is on. */
  required: boolean;
  /** The token for the next request, or null until the person passes the check. */
  token: string | null;
  /** A fresh check, after every answer from the API: a token works once. */
  reset: () => void;
  /** What the API said about the token, shown under the widget. */
  showErrors: (messages: string[]) => void;
  /** The widget, to place above the form's button. Null while the captcha is off. */
  widget: ReactNode;
}

/** The Turnstile check for one form, named by `action` (the API refuses a token from another form). */
export function useCaptcha(config: CaptchaConfig | null, action: string): Captcha {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [resetCount, setResetCount] = useState(0);

  const onToken = useCallback((next: string | null) => {
    setToken(next);
    if (next) setErrors([]);
  }, []);
  const reset = useCallback(() => {
    setToken(null);
    setResetCount((count) => count + 1);
  }, []);

  const errorsId = `${action}-captcha-errors`;
  const widget = config ? (
    <div data-captcha className="grid gap-2">
      <TurnstileWidget
        siteKey={config.siteKey}
        action={action}
        resetCount={resetCount}
        onToken={onToken}
        onFailed={setFailed}
      />
      {failed && (
        <p className="text-muted-foreground text-sm">
          The check could not load. If something blocks challenges.cloudflare.com, allow it and
          reload the page.
        </p>
      )}
      <FieldErrors id={errors.length > 0 ? errorsId : null} errors={errors} />
    </div>
  ) : null;

  return { required: config !== null, token, reset, showErrors: setErrors, widget };
}

/** The request body field, present only when there is a token, so a form without a captcha sends what it always did. */
export function captchaField(captcha: Captcha): { captchaToken?: string } {
  return captcha.token ? { captchaToken: captcha.token } : {};
}
