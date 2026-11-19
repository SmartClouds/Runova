# E115 Passkey sign-in

Milestone: standalone (Accounts, Mobile). Depends on: E48, E93.

## Goal

A Runova account can sign in with a passkey on the website and in the phone app, with no password
and no authenticator code. A passkey also confirms sensitive account changes on the website.

## Design

- **Identity's own passkey support.** ASP.NET Core Identity (schema version 3) stores passkeys in
  `AspNetUserPasskeys` and checks attestations and assertions through `IPasskeyHandler<AppUser>`.
- **One challenge, used once.** Every ceremony starts with `POST /passkey-challenges`, which keeps
  the handler's state in a `PasskeyChallenges` row for 5 minutes. The answer names the challenge,
  so the same flow works for the website's cookie and for the phone's tokens.
- **No code step.** A passkey with user verification (fingerprint, face or PIN) already proves two
  things, so an account with two-step sign-in is not asked for its code.
- **The phone.** The app asks the core for a challenge, hands the options to Credential Manager
  (Android) or AuthenticationServices (iOS), and trades the answer for tokens with the `passkey`
  grant of `POST /device-tokens`.
- **Linking the apps to the site.** The API serves `/.well-known/assetlinks.json` and
  `/.well-known/apple-app-site-association` from `Website:Passkeys`, and accepts the Android app's
  `android:apk-key-hash:` origin for each configured signing certificate.
- **Step-up.** A fresh passkey assertion passes the step-up check, before password, code or a
  recent sign-in.

## Tasks

- [x] T1 Website API: schema, challenges, sign-in, managing passkeys, step-up, the phone grant,
  the well-known files.
- [x] T2 Website: passkey sign-in, the Passkeys section in Security, passkey step-up.
- [x] T3 Rust: begin and finish a passkey sign-in.
- [x] T4 Android: Credential Manager and the sign-in button.
- [x] T5 iOS, written to match.
- [x] T6 Docs.

## Acceptance criteria

- AC1 A person adds a passkey in Security, signs out, and signs back in with it on the website.
- AC2 An account with two-step sign-in signs in with a passkey without a code.
- AC3 A challenge works once, for its own purpose, within 5 minutes.
- AC4 The phone signs in with a passkey and gets the same kind of session as a browser sign-in.
- AC5 Removing a passkey or adding one asks for step-up, and a passkey can be the step-up.

## Implementation notes

- **Schema.** `IdentitySchema` hands schema version 3 to every context, the ones `dotnet ef` and the
  test fixtures make by hand included, since Identity reads the version from the app's services.
  Version 3 also brings version 2's key lengths (128 for login and token keys, 256 for the phone
  number), which the `Passkeys` migration applies.
- **Origins.** `Website:Passkeys:AndroidCertFingerprints` and `Website:Passkeys:AppleAppIds` drive
  both the accepted origins and the two `.well-known` files. Both are empty by default, which keeps
  passkeys on the website only. `docs/mobile/release.md` says what to set.
- **Website.** "Use a passkey" sits with "Continue with Google" above the email form, and only in a
  browser that has passkeys. The Security page lists, adds, renames and removes passkeys, and the
  step-up dialog offers "Use a passkey instead" once the account has one. Each step-up dialog now
  names its own field, since several on one page shared an id.
- **Phone.** The core asks for the challenge and puts it in the view (`passkey_sign_in`); the app
  shows the platform prompt once per challenge and hands back the answer, or a cancel, with
  `no_passkey` when the phone has none for Runova.
- **Tests.** API: `PasskeySignInTests`, `PasskeyManagementTests` (with step-up),
  `PasskeyDeviceTokensTests` and `AppSiteAssociationTests`, all with `SoftwarePasskey`, an in-memory
  P-256 authenticator that writes real attestations and assertions. Web: `passkeys.test.ts` and the
  sign-in and Security cases, plus `e2e/admin/passkey.spec.ts` with Chromium's virtual authenticator
  against the real API. Rust: session and engine cases. Android: `PasskeySignInTest` and the
  sign-in snapshot. iOS: `PasskeyTests`.

## Not verified

- iOS builds only on a Mac, so the Swift code and `PasskeyTests` wait for the `Mobile iOS` CI job.
- A real passkey on a real phone needs the release fingerprint and team id on the server, the
  `.well-known` files served from the real domain, and Associated Domains on the app id.
- The phone's step-up for sensitive changes still asks for the password or code.
