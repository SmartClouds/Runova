// The last hop of Continue with Google, Apple or Microsoft (E116). The provider sends the browser
// back to the API from another site, and a browser leaves the SameSite=Strict session cookie off
// every request in a chain another site started. So the API's callback lands on our own page,
// whose script moves on to the API's finish address: a navigation this site starts, which carries
// the cookie, as does every page after it.

/** The API's finish address for the hop page's query, keeping only the return path. */
export function finishUrl(search: string): string {
  const returnUrl = new URLSearchParams(search).get('returnUrl') || '/account';
  return `/api/v1/external-sign-ins/current?returnUrl=${encodeURIComponent(returnUrl)}`;
}
