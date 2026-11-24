// The accounts a Runova account can sign in with besides a password or a passkey (E48.3, E116):
// their names, their marks and the address that starts each one. The API decides which are on.

export type ProviderName = 'google' | 'apple' | 'microsoft';

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z"
      />
    </svg>
  );
}

/** Apple's mark, from Simple Icons 15.0.0 (CC0-1.0), in the text colour as Apple asks. */
function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/** Microsoft's four squares. */
function MicrosoftMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

export const PROVIDERS: Record<ProviderName, { label: string; Mark: () => React.JSX.Element }> = {
  google: { label: 'Google', Mark: GoogleMark },
  apple: { label: 'Apple', Mark: AppleMark },
  microsoft: { label: 'Microsoft', Mark: MicrosoftMark },
};

export const isProvider = (name: string): name is ProviderName => Object.hasOwn(PROVIDERS, name);

/** The providers the API offers that this page knows how to show, in the API's order. */
export const knownProviders = (names: readonly string[] | undefined): ProviderName[] =>
  (names ?? []).filter(isProvider);

/** The provider's name for people, or the raw name for one this page does not know. */
export const providerLabel = (name: unknown): string =>
  typeof name === 'string' && isProvider(name)
    ? PROVIDERS[name].label
    : String(name ?? 'an account');

/** Where the browser goes to sign in with a provider, or to link it to the signed-in account. */
export const providerStart = (name: ProviderName, returnUrl: string, link = false) =>
  `/api/v1/external-sign-ins/${name}?${link ? 'link=true&' : ''}returnUrl=${encodeURIComponent(returnUrl)}`;

/** Sends the browser off to the provider, as a link to {@link providerStart} would. */
export const goToProvider = (name: ProviderName, returnUrl: string, link = false) => {
  window.location.assign(providerStart(name, returnUrl, link));
};

/** What the sign-in page says for the API's `?error=` after a provider. */
export function providerError(code: string | null): string | null {
  if (!code) return null;
  const failed = /^(.+)-failed$/.exec(code)?.[1];
  if (failed && isProvider(failed)) {
    return `${PROVIDERS[failed].label} did not finish signing you in. Try again.`;
  }
  switch (code) {
    case 'email-unverified':
      return 'That account has no confirmed email address, so Runova can not use it.';
    case 'link-needed':
      return 'An account with that email already exists. Sign in with its password, then link it under Security.';
    case 'disabled':
      return 'This account is turned off. Contact support to turn it back on.';
    case 'locked':
      return 'Too many tries in a row. Wait a few minutes and try again.';
    default:
      return null;
  }
}
