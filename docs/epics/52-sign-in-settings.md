# E52 Sign-in settings: captcha and Google

Milestone: standalone (Website). Depends on: E48 (accounts, sessions and "Continue with Google"),
E41 (the website API, its audit log and Data Protection key ring).

## Goal

An Admin turns a captcha on for sign-in and sign-up, and sets up "Continue with Google", from the
site itself, without a redeploy. A new **Sign-in settings** page under the admin holds a switch and
the keys for each: Cloudflare Turnstile for the captcha, a Google OAuth web client for Google.

Before this, Google sign-in already worked (E48.3) but only showed when the server had
`Authentication__Google__*` set, which neither compose file passed, and there was no captcha at all.

The rule that shapes everything: wrong captcha keys would lock everyone out, Admins included. So
the captcha can only be turned on, or given new keys, after the settings page's own check passes
with those keys and Cloudflare accepts that token with the new secret. If it still goes wrong,
`admin captcha-off` on the server turns it off.

## Tasks

- [x] T1 Turnstile check (`Accounts/TurnstileVerifier.cs`): siteverify with the secret, the token
  and the caller's address; a token passes once and only on its own form (the widget's `action`);
  an error, a timeout or an answer it can not read fails closed. The URL is `Captcha__VerifyUrl`,
  only changed by tests and the e2e stack.
- [x] T2 Storage (`SignInSettings` table, one row, migration `SignInSettings`): the switches and
  keys, secrets sealed with Data Protection. `SignInSettingsStore` keeps them in memory, reads
  them once the host has started, after a save and at most every 30 seconds, and never touches the
  database while Google's handler is built (every request builds it).
- [x] T3 Admin API (`GET`/`PATCH /sign-in-settings`, Admin only): ETag and If-Match, write-only
  secrets, the proof token to turn the captcha on, an audit entry that names fields and never
  values, the Google callback URL and a count of accounts that only have Google.
- [x] T4 Google from the settings: keys saved here win, a key left empty falls back to the
  environment, turned off it is gone even with keys in the environment, and new keys work without
  a restart (an options change token tied to the store).
- [x] T5 Enforcement (`CaptchaFilter`): `POST /sessions` (both steps), `/accounts`,
  `/verification-emails` and `/password-resets` need a `captchaToken` while the captcha is on;
  without one the answer is 400 with `errors.captchaToken`, before anything about the password or
  address is checked. `GET /sign-in-providers` carries the site key.
- [x] T6 Recovery: `admin captcha-off` keeps the keys and writes an audit entry.
- [x] T7 Contract: `docs/website/api-contract.md` and the OpenAPI snapshot.
- [x] T8 Web: the CSP allows `https://challenges.cloudflare.com` for scripts and frames; a
  `useCaptcha` hook that loads Turnstile's script once (explicit render), holds one token, starts a
  fresh check after every answer and shows the API's message under the widget.
- [x] T9 Web forms: account sign-in (not the code step after Google), sign-up, forgot password,
  both "send a new link" buttons (each with a check of its own) and the staff sign-in form.
- [x] T10 Admin page `/admin/settings` (Admins only, in the menu and on the overview): the two
  switches, keys with saved secrets shown as "saved" and a Replace button, the check, the
  redirect URI to copy, the warning before Google goes off, and the conflict dialog on 412.
- [x] T11 e2e `e2e/captcha/signInCaptcha.spec.ts` in a project of its own that runs after the
  admin specs (the captcha is on for the whole stack while it runs): the stack has a fake
  siteverify and the page gets a stand-in for Turnstile's script, so Cloudflare is never reached.
- [x] T12 Account Security offers "Link Google" only while the site has Google on; an account
  already linked can still unlink.

## Acceptance criteria

- AC1 With the captcha off, every form works as before and sends no token.
- AC2 An Admin can not turn the captcha on, or change its keys while it is on, without passing a
  check made with the new site key that Cloudflare accepts with the new secret. Turning it off
  needs nothing.
- AC3 With the captcha on, sign-in (both steps), sign-up, forgot password and new confirmation
  links need a token for their own form, which works once. Without one, nothing is said about the
  password or the address.
- AC4 If Cloudflare can not be reached, the protected forms are refused rather than opened.
- AC5 Secrets are never returned by the API, never written to the audit log, and sealed in the
  database.
- AC6 Google keys saved by an Admin work at once; Google turned off is gone, keys in the
  environment or not. Before Google goes off, the page says how many accounts only have Google.
- AC7 `admin captcha-off` gets everyone back in when the captcha keys stop working.

## Setting it up

- Captcha: in the Cloudflare dashboard, Turnstile, add a widget for the site's domain (Managed),
  or make it from the Runova app's own Cloudflare page (E43). Paste the site key and secret on
  `/admin/settings`, press **Check these keys**, pass the check, and save.
- Google: in Google Cloud Console, an OAuth client of type Web application, with the redirect URI
  the settings page shows (`https://runovahq.com/api/oauth/google/callback`). Paste the client ID
  and secret and save.
- Locally, Cloudflare's test keys work: site key `1x00000000000000000000AA`, secret
  `1x0000000000000000000000000000000AA`.

## Implementation notes

- Tests that change the settings use a database of their own: the row is shared by every API on a
  database, and the captcha on would break the tests next to them.
- The fake siteverify in the e2e stack names no action, as Cloudflare's test keys do, so the API
  lets a token with no action through and refuses only one for another form.
