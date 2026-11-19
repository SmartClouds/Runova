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

- [ ] T1 Website API: nonces and the `id_token` grant.
- [ ] T2 Rust: begin and finish a provider sign-in, the browser hint.
- [ ] T3 Android: Google through Credential Manager, the three buttons.
- [ ] T4 iOS: Sign in with Apple, the three buttons, written to match.
- [ ] T5 Docs.

## Acceptance criteria

- AC1 On Android, Continue with Google signs in, or creates the account, without a browser.
- AC2 On iPhone, Continue with Apple does the same.
- AC3 A nonce works once, for its provider, within 5 minutes; a token for another app is refused.
- AC4 An existing confirmed account with the same email is not taken over.
- AC5 An account with two-step sign-in finishes in the browser with its code.
