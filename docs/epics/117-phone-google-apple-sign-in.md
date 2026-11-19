# E117 Google and Apple sign-in on the phone

Milestone: standalone (Accounts, Mobile). Depends on: E115, E116.

## Goal

The phone app offers Continue with Google, Continue with Apple and Continue with Microsoft. Google
on Android and Apple on iPhone use the system's own sign-in sheet, without a browser. The others go
through the browser sign-in and jump straight to the provider.

## Design

- **A nonce first.** `POST /sign-in-nonces` hands out a random nonce for one provider, kept only as
  a hash for 5 minutes and good once. The app passes it to the platform sheet, which puts it in the
  ID token.
- **The `id_token` grant.** `POST /device-tokens` with `grantType: "id_token"` checks the token's
  signature against the provider's published keys, its issuer, its audience (the Google web client
  id, or the app's bundle id for Apple), its expiry and the nonce, then applies the same account
  rules as the website and starts a phone session.
- **Two-factor.** An account with two-step sign-in is sent on to the browser sign-in for that
  provider, where the code is asked for.
- **Apple's token.** The app sends Apple's authorization code too, which the API trades for the
  refresh token it revokes later (E116).
- **The phone.** The core asks for the nonce and puts it in the view; the app shows the sheet once
  per nonce and hands back the token, or a cancel. Every other provider opens the browser sign-in
  with `provider=` so the website goes straight to it.

## Tasks

- [x] T1 Website API: nonces and the `id_token` grant.
- [x] T2 Rust: begin and finish a provider sign-in, the browser hint.
- [x] T3 Android: Google through Credential Manager, the three buttons.
- [x] T4 iOS: Sign in with Apple, the three buttons, written to match.
- [x] T5 Docs.

## Acceptance criteria

- AC1 On Android, Continue with Google signs in, or creates the account, without a browser.
- AC2 On iPhone, Continue with Apple does the same.
- AC3 A nonce works once, for its provider, within 5 minutes; a token for another app is refused.
- AC4 An existing confirmed account with the same email is not taken over.
- AC5 An account with two-step sign-in finishes in the browser with its code.

## Implementation notes

- **Checking the token.** `IdTokenValidator` reads Google's and Apple's discovery documents and
  signing keys with `Microsoft.IdentityModel`'s configuration manager, keeps them, and reads them
  again when a token names a key it has not seen. Google's issuer may come with or without
  `https://`. The nonce is compared in constant time and taken with one `UPDATE`, so two grants
  racing for it can not both win. Old nonces are dropped as new ones are made.
- **Same rules as the website.** The grant builds the same four-claim login the website's handlers
  make and hands it to `ExternalAccounts`, so a phone can never take an account the website would
  refuse. The answers map to their own errors in the core: 409 is `LinkNeeded`, 403
  `EmailUnverified`, 401 `two-factor-required` `ContinueInBrowser`, any other 400 or 401
  `ProviderRefused`.
- **Apple's code.** The app sends Apple's authorization code; the API trades it with a client
  secret for the app's bundle id and keeps the refresh token sealed, as the website does, so
  deleting the account revokes it. A failed trade is logged and the sign-in goes on.
- **The view.** `provider_sign_in` holds the provider, the nonce once it is there, and Google's web
  client id. The app opens the sheet once per nonce. `continue_in_browser` names the provider whose
  browser sign-in to open, once each time it is set; starting again clears it.
- **Buttons.** Android: Continue with Google (the sheet), Apple and Microsoft (the browser). iPhone:
  Continue with Apple (the sheet, drawn white with the Apple logo as Apple asks), Google and
  Microsoft (the browser). On Android the sign-in screen scrolls now that it holds six ways in.

## Not verified

- iOS was written to match and is unverified until the Mobile iOS CI job builds and tests it.
- Never tried with a real Google Android client or a real Sign in with Apple capability; the API
  tests sign their own tokens with keys made for the test.
