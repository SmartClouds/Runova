# E116 Sign in with Apple and Microsoft

Milestone: standalone (Accounts). Depends on: E48, E52.

## Goal

A person can create a Runova account and sign in to it with an Apple or Microsoft account on the
website, the same way "Continue with Google" works today. The desktop app and the phone's browser
sign-in get the new buttons for free, since both sign in through the website.

## Design

- **One list of providers.** Google, Apple and Microsoft sit in one registry (`ExternalProviders`)
  with their scheme, callback path and whether the saved settings switch them on. The endpoints,
  error codes, activity entries and the web pages read from it instead of naming Google.
- **The same account rules.** A login is never linked to an existing account by email alone, only a
  verified email is trusted, and an address nobody confirmed goes to whoever proves it. These rules
  move into `ExternalAccounts` so the phone grant in E117 can use them too.
- **Microsoft.** The `common` endpoint, so personal and work or school accounts both work. Personal
  accounts always have a verified email. A work account counts as verified only when the token
  carries `xms_edov=true`, which blocks the known trick of setting someone else's address in a
  tenant you own.
- **Apple.** OpenID Connect with `response_mode=form_post`. The client secret is a short ES256 JWT
  made from the saved .p8 key for each code exchange. Apple sends the name only the first time, in
  the `user` form field. Apple's refresh token is kept sealed so it can be revoked when the account
  is deleted or Apple is unlinked, as Apple asks.
- **Keys.** Admins save the keys in the sign-in settings, as with Google, with
  `Authentication__Apple__*` and `Authentication__Microsoft__*` as the fallback.
- **The cookie hop.** The session cookie is `SameSite=Strict`, which a browser leaves off every
  request in a chain another site started. The provider callback now finishes on a small page of
  ours that moves on by script, so the rest of the chain is ours and carries the cookie.

## Tasks

- [x] T1 Website API: one provider list, shared account rules, the return path kept on failure.
- [x] T2 Website API: Apple and Microsoft keys in the sign-in settings.
- [x] T3 Website API: the Microsoft and Apple handlers, Apple token revocation.
- [x] T4 Website: the cookie hop page, with a Playwright run against a fake Microsoft.
- [x] T5 Website: the buttons, Connected accounts in Security, the admin sections, the provider
  hint on `/account/authorize`.
- [x] T6 Contract, setup steps and help.

## Acceptance criteria

- AC1 With keys saved, sign-in and register show Continue with Apple and Continue with Microsoft,
  and the first sign-in creates the account.
- AC2 An existing confirmed account with the same email is never taken over; the person signs in
  and links the provider from Security.
- AC3 A work Microsoft account without a verified email cannot create or take over an account.
- AC4 Two-factor still applies after Apple and Microsoft.
- AC5 Signing in with a provider in a real browser lands signed in, and linking from Security works.
- AC6 Deleting an account or unlinking Apple revokes Apple's token.

## Implementation notes

- **Handlers.** Microsoft and Apple use ASP.NET Core's own OpenID Connect handler, one scheme
  each, with no third-party package. Each turns the ID token into four plain claims (subject,
  email, name, verified), so `ExternalAccounts` reads every provider the same way. Microsoft's
  issuer is checked against the token's own tenant, since the common endpoint names a template.
- **The cookie hop was a real bug.** The Playwright run against the fake Microsoft showed it
  before the fix: the API set the session and sent the browser to `/account`, and the guard sent
  it straight back to sign-in, because the browser left the Strict cookie off a chain another
  site started. Google had the same problem; it was never seen because Google was never tried
  with real keys. The callback now lands on `/account/external-sign-in`, whose script goes on to
  `/api/v1/external-sign-ins/current`.
- **Errors keep the way back.** A failed or cancelled provider sign-in that was going anywhere
  but `/account` lands on `/account/sign-in?error=...&next=...`, so the phone and desktop
  authorize page still finishes after the person tries another way.
- **Provider hint.** `/account/authorize?...&provider=apple`, opened while signed out, goes
  straight to that provider when the API has it on, and comes back to the authorize page without
  the hint. The apps use it in E117.
- **Admin page.** Apple takes the Services ID, Team ID, Key ID, the .p8 key and the app's bundle
  id; Microsoft the client ID and the secret value. A key pasted without its newlines, as a
  password field does, still reads. The count of accounts with only a provider now covers all
  three, and its warning shows when any provider is turned off.

## Not verified

- Never tried with a real Apple Services ID or a real Microsoft app registration. The API tests
  use a fake OpenID provider that signs its own tokens, and the e2e a fake Microsoft on another
  site. Apple's real form post, its first-time `user` field and the real `/auth/revoke` are only
  as the fakes play them.
- The new buttons and the Connected accounts card were checked through the DOM and the e2e, not
  looked at on a phone screen.
