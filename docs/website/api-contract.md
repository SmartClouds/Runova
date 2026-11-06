# Website API contract

The REST contract between the website API (`apps/website/api`), the Astro site
(`apps/website/web`), the desktop app's news client and other systems that publish news. Specs:
[E40W Website](../epics/40-website.md), [E41 Website API](../epics/41-website-api.md),
[E42 Dashboard news](../epics/42-dashboard-news.md).

When the code and this file disagree, the code is wrong until this file is changed on purpose in
the same commit.

## Conventions

- **Base path.** Every resource lives under `/api/v1`. Path segments are plural nouns
  (`/news`, `/posts`, `/users`, `/api-clients`, `/accounts`). The only non-plural segments are the fixed
  sub-resources `me`, `current`, `latest`, `two-factor`, `password` and `downloads`, and the mass
  nouns `news`, `media` and `usage`. Verbs never appear in a path.
- **Outside `/api/v1`.** `GET /health/live` (200 while the process runs), `GET /health/ready` (200
  when PostgreSQL answers, 503 problem details when it does not), `GET /_runova/health` (the
  runova-health/1 report for Runova's Health page: `Authorization: Bearer <key>` whose SHA-256 is
  `RUNOVA_HEALTH_TOKEN_SHA256`, else an empty 401; 200 or 503 `application/health+json`; 30 requests
  a minute per address, then an empty 429), `GET /openapi/v1.json` (the built-in OpenAPI
  document), `GET /api/oauth/google/callback` (where Google sends the browser back during "Continue
  with Google"; handled by the Google sign-in middleware, not an endpoint), `GET /scalar` (the reference page, development and staging only), `/hangfire` (the dashboard, Admin only) and `/media/...` (uploaded images, served as static files).
- **JSON.** UTF-8, camelCase property names, `null` for a missing optional value (never left out of
  a response), enums as the lowercase strings listed below. Ids are JSON numbers (PostgreSQL
  `bigint`; the API never hands out an id above 2^53 - 1 so JavaScript reads them exactly).
- **Time.** RFC 3339 in UTC with a `Z`, to the millisecond: `2026-10-30T12:00:00.000Z`.
- **Content types.** Requests and responses are `application/json`. PATCH takes
  `application/merge-patch+json` (RFC 7396). Errors are `application/problem+json`. Media uploads
  are `multipart/form-data`.
- **Unknown properties** in a request body are refused with 400 (`validation-failed`), so a typo is
  never silently ignored.

### Paging

List endpoints take `page` (1-based, default 1) and `pageSize` (default 20, at most 100). A
`pageSize` above 100, below 1 or a `page` below 1 answers 400 `validation-failed`. A page past the
end answers 200 with an empty `items`.

```json
{
  "items": [],
  "page": 2,
  "pageSize": 20,
  "totalItems": 134,
  "totalPages": 7
}
```

The response also carries a `Link` header (RFC 8288) with `first`, `prev`, `next` and `last`
where they exist, each a path with the same query and another `page`.

### Caching, ETag and If-Match

- Every single-resource response carries a strong `ETag` made from the row's concurrency token
  (`"<version>"`, PostgreSQL `xmin`). The same value appears as `version` in admin DTOs.
- Public lists carry a weak `ETag` (`W/"<hash>"`) computed from the query and the newest
  `updatedAt` and count of the matching rows.
- `If-None-Match` with a matching value answers `304 Not Modified` with no body.
- Public responses: `Cache-Control: public, max-age=60, stale-while-revalidate=300` for lists,
  `public, max-age=300, stale-while-revalidate=600` for single items and releases. Anything for
  staff or an API client: `Cache-Control: private, no-store`.
- `PUT`, `PATCH` and `DELETE` on a resource with a `version` require `If-Match` with its current
  ETag. Missing: `428 precondition-required`. Stale: `412 precondition-failed` (the body's
  `currentVersion` extension says what it is now). A successful write returns the new `ETag`.

### Problem details (RFC 9457)

Every error, including 404 for an unknown route and 405, is `application/problem+json`:

```json
{
  "type": "https://runovahq.com/problems/validation-failed",
  "title": "The request is not valid.",
  "status": 400,
  "detail": "One or more fields are not valid.",
  "instance": "/api/v1/news",
  "traceId": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "errors": {
    "technologies[0].technology": ["Unknown technology slug 'node'."]
  }
}
```

`errors` appears only on `validation-failed`; its keys are the JSON paths of the request fields.
`traceId` is the W3C trace id that also tags the Sentry event and the OpenTelemetry trace. A 500
never carries a stack trace or exception text.

| Type (after `https://runovahq.com/problems/`) | Status | When |
|---|---|---|
| `validation-failed` | 400 | Bad field, bad query parameter, unknown property, bad upload |
| `unauthorized` | 401 | No session, wrong password, or any failed signature check (always the same detail) |
| `two-factor-required` | 401 | Right password, but the account needs a TOTP or recovery code |
| `forbidden` | 403 | Signed in, but the role or scope does not allow it |
| `email-unverified` | 403 | Right password, but the account's email is not confirmed yet |
| `not-found` | 404 | No such route or resource, or the resource is not published |
| `conflict` | 409 | Duplicate slug or email, removing or demoting the last Admin |
| `precondition-failed` | 412 | Stale `If-Match` |
| `payload-too-large` | 413 | Upload over 5 MB, JSON body over 1 MB |
| `idempotency-key-reused` | 422 | The same `Idempotency-Key` with a different body |
| `account-locked` | 423 | Five failed sign-ins in a row; `retryAfter` (seconds) extension |
| `precondition-required` | 428 | `If-Match` missing on a write that needs it |
| `rate-limited` | 429 | Over a rate limit; `Retry-After` header in seconds |
| `internal` | 500 | Unhandled error |
| `unavailable` | 503 | The database is down (`/health/ready` and any request that needs it) |

## Authentication

Three ways in, named in the **Auth** column of every table below:

- **Anonymous.** No credentials. Public reads only.
- **Staff session (cookie).** `POST /api/v1/sessions` sets `__Host-runova-session` (HttpOnly,
  Secure, SameSite=Strict, Path=/, 8-hour sliding expiry). Roles are `Admin` and `Editor`; an Admin
  can do everything an Editor can. Every unsafe method (POST, PUT, PATCH, DELETE) with a cookie also
  needs the antiforgery header `X-XSRF-TOKEN`, whose value comes from the readable `XSRF-TOKEN`
  cookie that `GET /api/v1/csrf-tokens/current` (and every sign-in) sets. Missing or wrong: 400
  `validation-failed` with `errors.antiforgery`.
- **Account session (cookie).** The same sign-in and cookie for a Runova account (E48), which is a
  user with no staff role. An account reaches only its own resources, marked `Account` below; staff
  are accounts too. Every route not marked otherwise is for staff only, so an account gets 403 there.
- **Device token (desktop app).** `Authorization: Bearer rd1...` from the Runova desktop app (E48.5),
  got from [device tokens](#desktop-sign-in). It reaches `Account` routes only (never a staff route,
  even for staff) and needs no antiforgery header.
- **Signed request (API client).** For other systems that publish. See
  [Signed requests](#signed-requests). Scopes are `news:write` and `posts:write`. A signed request
  never uses cookies or antiforgery.

Auth column values: `Anonymous`, `Account` (any signed-in user, staff included), `Staff` (Editor or Admin session), `Admin` (Admin session),
`Editor or news:write` (an Editor or Admin session, or a client with that scope), `Editor or
posts:write` (likewise). Anything not marked `Anonymous` answers 401 when no credentials come with
it (the fallback policy denies by default).

## Enums

### News categories

| Value | Meaning | Allowed severities |
|---|---|---|
| `security` | A vulnerability, advisory or exploited bug | `low`, `medium`, `high`, `critical` |
| `release` | A new version of a tool or runtime | `info` |
| `deprecation` | Something is going away or changing its default | `info` |
| `end-of-life` | A version stops getting fixes | `info` |
| `ai` | AI models, agent CLIs and their limits or prices | `info` |
| `tooling` | Editors, build tools, package managers, CI | `info` |
| `industry` | Everything else worth knowing | `info` |

### Severity levels

Ordered from lowest to highest: `info`, `low`, `medium`, `high`, `critical`. `minSeverity`
filters use this order. When an item has a CVSS score the editor suggests the matching level
(0.1 to 3.9 low, 4.0 to 6.9 medium, 7.0 to 8.9 high, 9.0 to 10.0 critical) but does not force it.

### Item status

`draft`, `scheduled` (has a future `publishedAt`; the publish job makes it `published` at that
time), `published`, `archived` (what DELETE does; archived items are never public).

### Release platforms, architectures and kinds

- `platform`: `windows`, `macos`, `linux`
- `arch`: `x64`, `arm64`, `universal`
- `kind`: `nsis`, `dmg`, `zip`, `appimage`, `deb`

## Technology slugs

`GET /api/v1/technologies` serves this list; it is seeded by a migration and only changes with a new
migration. A news item may name only these slugs. `detectable: true` means the desktop app can read
the installed version and match it (see [E42](../epics/42-dashboard-news.md)). The slugs of the AI
CLIs are the ids in `packages/core/src/cli/registry.ts`, so the desktop matches them directly.

| Slug | Name | Kind | Detectable |
|---|---|---|---|
| `runova` | Runova | app | yes |
| `electron` | Electron | runtime | yes |
| `nodejs` | Node.js | runtime | yes |
| `git` | Git | tool | yes |
| `dotnet` | .NET | runtime | yes |
| `docker` | Docker | tool | yes |
| `claude-code` | Claude Code | ai-cli | yes |
| `codex-cli` | Codex CLI | ai-cli | yes |
| `gemini-cli` | Gemini CLI | ai-cli | yes |
| `grok-cli` | Grok CLI | ai-cli | yes |
| `cursor-cli` | Cursor CLI | ai-cli | yes |
| `opencode` | OpenCode | ai-cli | yes |
| `openclaude` | OpenClaude | ai-cli | yes |
| `copilot-cli` | GitHub Copilot CLI | ai-cli | yes |
| `aider` | Aider | ai-cli | yes |
| `goose` | Goose | ai-cli | yes |
| `cline-cli` | Cline CLI | ai-cli | yes |
| `continue-cli` | Continue CLI | ai-cli | yes |
| `pi` | Pi | ai-cli | yes |
| `muse-code` | Muse Code | ai-cli | yes |
| `freebuff-cli` | FreeBuff | ai-cli | yes |
| `qwen-cli` | Qwen Code | ai-cli | yes |
| `python` | Python | runtime | no |
| `bun` | Bun | runtime | no |
| `deno` | Deno | runtime | no |
| `java` | Java | runtime | no |
| `go` | Go | runtime | no |
| `rust` | Rust | runtime | no |
| `php` | PHP | runtime | no |
| `npm` | npm | tool | no |
| `pnpm` | pnpm | tool | no |
| `typescript` | TypeScript | tool | no |
| `vscode` | Visual Studio Code | tool | no |
| `github-actions` | GitHub Actions | service | no |
| `android-sdk` | Android SDK | tool | no |
| `flutter` | Flutter | tool | no |
| `openssh` | OpenSSH | server | no |
| `openssl` | OpenSSL | library | no |
| `nginx` | nginx | server | no |
| `postgresql` | PostgreSQL | server | no |
| `mysql` | MySQL | server | no |
| `redis` | Redis | server | no |
| `wordpress` | WordPress | app | no |
| `kubernetes` | Kubernetes | server | no |
| `linux-kernel` | Linux kernel | os | no |
| `ubuntu` | Ubuntu | os | no |
| `debian` | Debian | os | no |
| `rocky-linux` | Rocky Linux | os | no |
| `windows` | Windows | os | no |
| `macos` | macOS | os | no |

Kinds: `app`, `runtime`, `tool`, `ai-cli`, `service`, `server`, `library`, `os`.

### Version ranges

An affected technology carries a `versionRange` and an optional `fixedIn`. The grammar is shared by
the API's validation and the desktop matcher, and both have table tests over the same cases:

- A range is one or more comparator sets joined by ` || `. A comparator set is one or more
  comparators separated by a single space, all of which must hold. `*` matches every version.
- A comparator is `<`, `<=`, `>`, `>=` or `=` followed by a version: `>=2.40.0 <2.47.1 || =2.39.5`.
- A version is compared by its leading numeric parts: up to four dot-separated integers, read until
  the first character that is not a digit or a dot (`2.47.1.windows.1` is `2.47.1`, `v24.3.0` is
  `24.3.0` after one leading `v` is dropped, `10.0.401` is `10.0.401`). Missing parts count as 0.
- A version with no numeric part never matches. An unparseable range is a 400 on write.
- `fixedIn` is the first version that is not affected, shown to the reader as the version to
  update to. It must not satisfy the range.

## Resources

### Sessions and CSRF tokens

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/csrf-tokens/current` | Anonymous | none | 200 `{ "token": string }` and sets the `XSRF-TOKEN` cookie |
| POST | `/api/v1/sessions` | Anonymous (with antiforgery) | `SignInRequest` | 204 and the session cookie; 400; 401 `unauthorized`; 401 `two-factor-required`; 403 `email-unverified`; 423 `account-locked`; 429 |
| DELETE | `/api/v1/sessions/current` | Account | none | 204 and the cookie cleared; 401 |

`SignInRequest`: `{ "email": string, "password": string, "twoFactorCode": string | null,
"recoveryCode": string | null }`. A wrong email and a wrong password give the same 401. Sign-in is
rate-limited to 10 attempts a minute per IP (429), a limit shared with the account routes that
send email. An account whose email is not confirmed gets 403 `email-unverified`, and only once its
password is right.

### The signed-in user

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/users/me` | Account | none | 200 `UserDto`; 401 |
| PUT | `/api/v1/users/me/password` | Account | `{ "currentPassword": string, "newPassword": string }` | 204; 400; 401 |
| GET | `/api/v1/users/me/two-factor` | Account | none | 200 `{ "enabled": bool, "recoveryCodesLeft": int }`; 401 |
| POST | `/api/v1/users/me/two-factor` | Account | none | 200 `{ "sharedKey": string, "authenticatorUri": string }` (starts setup, not yet on); 401 |
| PUT | `/api/v1/users/me/two-factor` | Account | `{ "code": string }` | 200 `{ "recoveryCodes": string[10] }` (turns it on); 400 wrong code; 401 |
| DELETE | `/api/v1/users/me/two-factor` | Account | `{ "password": string }` | 204; 400; 401 |
| POST | `/api/v1/users/me/two-factor/recovery-codes` | Account | `{ "code": string }` | 201 `{ "recoveryCodes": string[10] }` (the old ones stop working); 400; 401 |

TOTP follows RFC 6238 (SHA-1, 6 digits, 30 seconds, one step of drift), and each code works once.

### Users (Admin)

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/users` | Admin | query `page`, `pageSize`, `q` (email or name), `role` (`Admin`, `Editor`, or `Account` for the users with no staff role), `disabled` | 200 `Page<UserDto>`; 400; 401; 403 |
| POST | `/api/v1/users` | Admin | `{ "email": string, "displayName": string, "roles": string[] }` | 201 `UserInvitedDto`, `Location: /api/v1/users/{id}`; 400; 401; 403; 409 email taken |
| GET | `/api/v1/users/{id}` | Admin | none | 200 `UserDto`; 401; 403; 404 |
| PATCH | `/api/v1/users/{id}` | Admin | merge patch of `displayName`, `roles`, `disabled`; `If-Match` | 200 `UserDto`; 400; 401; 403; 404; 409 last Admin; 412; 428 |
| DELETE | `/api/v1/users/{id}` | Admin | `If-Match` | 204; 401; 403; 404; 409 last Admin; 412; 428 |
| POST | `/api/v1/users/{id}/password-resets` | Admin | none | 201 `SetupLinkDto`; 401; 403; 404 |
| DELETE | `/api/v1/users/{id}/two-factor` | Admin | none | 204 (two-factor off, recovery codes gone); 401; 403; 404 |
| POST | `/api/v1/users/{id}/invitations` | Admin | none | 201 `SetupLinkDto` (a new link; the old one stops working); 401; 403; 404; 409 already accepted |
| POST | `/api/v1/password-setups` | Anonymous (with antiforgery) | `{ "token": string, "password": string }` | 204 (password set, email confirmed); 400 bad password; 404 unknown, used or expired token; 429 |

`UserInvitedDto`: `{ "user": UserDto, "setupLink": SetupLinkDto }`. `SetupLinkDto`:
`{ "url": string, "expiresAt": time }`. The link is
`https://runovahq.com/admin/set-password#token=<token>`: the token sits in the fragment so it never
reaches a server log. It is 32 random bytes in base64url, stored only as its SHA-256, single use,
and expires after 24 hours. Disabling a user ends their sessions. An Admin can not disable,
demote or delete themselves if they are the last Admin (409), and no route ever removes the last
Admin. An Editor gets 403 on every route in this table.

`UserDto`:

```json
{
  "id": 7,
  "email": "editor@runovahq.com",
  "displayName": "Sam Editor",
  "roles": ["Editor"],
  "disabled": false,
  "emailConfirmed": true,
  "twoFactorEnabled": true,
  "lockedOutUntil": null,
  "lastSignInAt": "2026-10-30T09:12:44.000Z",
  "createdAt": "2026-10-01T08:00:00.000Z",
  "version": "1234"
}
```

No user DTO ever carries a password hash, security stamp, concurrency stamp, authenticator key,
recovery code or token.

### Accounts

Runova accounts (E48): signing up, confirming the email, a forgotten password, and the account
itself. Every anonymous route here answers the same whether or not an address has an account.

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| POST | `/api/v1/accounts` | Anonymous (with antiforgery) | `RegisterRequest` | 202 (a link is on its way); 400; 429 |
| POST | `/api/v1/email-verifications` | Anonymous (with antiforgery) | `{ "token": string }` | 200 `{ "signedIn": bool }` and the session cookie when signed in; 400; 404 unknown, used or expired token; 429 |
| POST | `/api/v1/verification-emails` | Anonymous (with antiforgery) | `{ "email": string }` | 202; 400; 429 |
| POST | `/api/v1/password-resets` | Anonymous (with antiforgery) | `{ "email": string }` | 202; 400; 429 |
| GET | `/api/v1/accounts/me` | Account | none | 200 `AccountDto`; 401 |
| PATCH | `/api/v1/accounts/me` | Account | merge patch of `displayName`; `If-Match` | 200 `AccountDto`; 400; 401; 412; 428 |
| DELETE | `/api/v1/accounts/me` | Account | `StepUpRequest` | 204 (the account and everything only it owns are gone); 400 step-up failed; 401; 409 staff, or a team still needs it |

`RegisterRequest`: `{ "email": string, "password": string (12 or more), "displayName": string (1 to
100) }`. A new address gets an account with no role and a link to
`https://runovahq.com/account/verify-email#token=<token>` (24 hours, one use). An address whose
account was never confirmed gets a new link, and the password it was registered with before stops
working. A confirmed address gets an email saying it already has an account, and nothing changes.
Confirming signs in, unless the account has two-factor on. Accounts never confirmed are deleted
after 7 days.

`POST /password-resets` sends a link to `https://runovahq.com/account/reset-password#token=<token>`
(one hour, one use), redeemed at `POST /password-setups`. An email verification token never sets a
password. Setting a password ends every other session.

`AccountDto`:

```json
{
  "id": 42,
  "email": "sam@example.com",
  "displayName": "Sam",
  "emailConfirmed": true,
  "hasPassword": true,
  "twoFactorEnabled": false,
  "logins": ["google"],
  "staff": false,
  "createdAt": "2026-11-05T08:00:00.000Z",
  "lastSignInAt": "2026-11-05T09:12:44.000Z",
  "version": "1234"
}
```

Emails wait in an outbox saved with the change that sends them and go out through SendGrid's Mail
Send API (`Email__SendGridApiKey`, `Email__From`, `Email__FromName`, and `Email__SandboxMode` for
staging). Click and open tracking are off, so one-time links reach the reader as written. A failed
send is retried with a growing wait, up to ten times. A sent email keeps its subject but loses its
body, which held a one-time link.

### Continue with Google

Google sign-in for accounts, as browser redirects, when `Authentication__Google__ClientId` and
`Authentication__Google__ClientSecret` are set. Only an email Google says is verified is trusted.

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/sign-in-providers` | Anonymous | none | 200 `{ "items": string[] }` (`["google"]` when it is set up) |
| GET | `/api/v1/external-sign-ins/{provider}` | Anonymous | query `returnUrl` (a path on this site), `link` (`true` to add Google to the signed-in account) | 302 to Google; 404 not set up |
| GET | `/api/v1/external-sign-ins/current` | Anonymous (Google's external cookie) | query `returnUrl` | 302 to `returnUrl`, or to `/account/sign-in?error=...` or `?step=two-factor` |
| POST | `/api/v1/two-factor-sign-ins` | Anonymous (with antiforgery, after Google) | `{ "code": string \| null, "recoveryCode": string \| null }` | 204 and the session cookie; 401 `unauthorized` (start again); 401 `two-factor-required`; 423; 429 |
| DELETE | `/api/v1/accounts/me/logins/{provider}` | Account | none | 204; 401; 404 not linked; 409 it is the only way in |

Rules: a Google login already linked signs in to its account (two-factor still applies). A new
address gets a new confirmed account with no password. An address whose account someone confirmed
is never linked by email alone: the redirect carries `error=link-needed`, and the owner signs in
with their password and links Google from Security (`link=true`), which only finishes for the
account that started it. An address nobody confirmed goes to the Google owner, and the password it
was registered with stops working. Errors in the redirect: `google-failed`, `email-unverified`,
`link-needed`, `disabled`, `locked`, and `login-taken` (on a link, when another account has that
Google login). A `returnUrl` that is not a path on this site becomes `/account`.

### Desktop sign-in

The desktop app signs in the way RFC 8252 describes for a native app: it opens
`https://runovahq.com/account/authorize?client_id=runova-desktop&redirect_uri=http://127.0.0.1:<port>/callback&response_type=code&code_challenge=<S256>&code_challenge_method=S256&state=...&device_name=...&platform=windows|macos|linux&app_version=...&device_id=<uuid>`
in the browser. The signed-in person approves the computer there, the page calls
`POST /device-authorizations` and sends the browser to the redirect it gets back, and the app trades
the code at `POST /device-tokens`.

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| POST | `/api/v1/device-authorizations` | Account (cookie, with antiforgery) | `DeviceAuthorizationRequest` | 201 `{ "redirectUrl": string, "expiresAt": time }`; 400; 401 |
| POST | `/api/v1/device-tokens` | Anonymous (no cookie, no antiforgery) | `DeviceTokenRequest` | 200 `DeviceTokenDto`; 400; 401 `unauthorized` (code or token not valid); 429 |

`DeviceAuthorizationRequest`: `{ "clientId": "runova-desktop", "redirectUri": string (only
http://127.0.0.1:<port>/callback or http://[::1]:<port>/callback, port 1024 to 65535),
"codeChallenge": string (base64url SHA-256), "codeChallengeMethod": "S256", "state": string,
"deviceName": string (1 to 100), "platform": "windows" | "macos" | "linux", "appVersion": string |
null, "deviceId": uuid | null }`. The code is 32 random bytes, kept only as its SHA-256, good for two
minutes and one use.

`DeviceTokenRequest`: `{ "grantType": "authorization_code" | "refresh_token", "code": string | null,
"codeVerifier": string | null, "redirectUri": string | null, "refreshToken": string | null }`. A
code needs the verifier that matches its challenge and the same redirect URI. `DeviceTokenDto`:
`{ "accessToken": string, "refreshToken": string, "expiresIn": 900, "sessionId": number,
"account": AccountDto }`.

The access token lasts 15 minutes and names its session, which must still be live. The refresh
token lasts 60 days from its last use and is replaced by every refresh; only its SHA-256 is kept. A
refresh token used again more than 30 seconds after it was replaced ends its session (it was
copied), and earlier than that it is only refused (a lost answer). A computer that signs in again
with the same `deviceId` replaces its old session. Each new computer is in the activity
(`device-sign-in`) and sends the owner a "new sign-in" email. Disabling a user ends all their
sessions at once.

### Sync

Each account has one personal scope, made on first use, and each team it is in has one more
(E48.7). A scope holds the newest record of every synced item, by `collection` and `itemId`. Every
accepted record takes the scope's next revision, and the changes feed returns records after a
revision in order. A push names the revision each record was based on (0 for a new item); a stale
one is not written and comes back in `conflicts` with the stored copy, and the rest of the push is
written. Payloads are opaque text the desktop app made (shared fields in the clear and a sealed
part, or all sealed): the server stores them as they are and never reads or logs them. A scope an
account can not see answers 404.

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/sync-scopes` | Account | none | 200 `{ "items": SyncScopeDto[] }`; 401 |
| PATCH | `/api/v1/sync-scopes/{id}` | Account (scope managers) | `{ "policy": { "servers"?: bool, "environments"?: bool, "everything"?: bool } }` | 200 `SyncScopeDto`; 400; 401; 403; 404 |
| GET | `/api/v1/sync-scopes/{id}/changes` | Account | query `since` (revision, default 0), `limit` (1 to 1000, default 500) | 200 `{ "records": SyncRecordDto[], "next": number, "more": bool }`; 400; 401; 404 |
| POST | `/api/v1/sync-scopes/{id}/records` | Account (not a Viewer) | `{ "records": SyncPushRecord[] }` (1 to 100) | 200 `{ "accepted": [{ "collection", "itemId", "revision" }], "conflicts": SyncRecordDto[] }`; 400; 401; 403; 404; 409 the key changed; 413 a record over 1 MB, or the scope full; 429 |
| DELETE | `/api/v1/sync-scopes/{id}/records` | Account (scope managers) | `StepUpRequest` | 204 (every record gone, new epoch); 400; 401; 403; 404 |
| GET | `/api/v1/sync-scopes/{id}/usage` | Account | none | 200 `{ "records": int, "bytes": number, "quotaBytes": number, "collections": { [name]: int } }`; 401; 404 |
| GET | `/api/v1/sync-scopes/{id}/keys/current` | Account | none | 200 `{ "version": int, "envelope": object, "setAt": time }`; 401; 404 no key yet |
| PUT | `/api/v1/sync-scopes/{id}/keys/current` | Account (scope managers) | `{ "version": int, "envelope": object }` | 200 the same shape; 400; 401; 403; 404; 409 not the next version |
| DELETE | `/api/v1/sync-scopes/{id}/keys/current` | Account (scope managers) | `StepUpRequest` | 204 (key and sealed records gone, new epoch); 400; 401; 403; 404 |

`SyncScopeDto`: `{ "id": number, "kind": "personal" | "team", "teamId": number | null, "name":
string, "canWrite": bool, "canManage": bool, "latestRevision": number, "epoch": int, "keyVersion":
int | null, "policy": { "servers": bool, "environments": bool, "everything": bool } }`. For a
personal scope the account is its manager; for a team, its Owners and Admins are. A Viewer has
`canWrite: false`.

`SyncPushRecord`: `{ "collection": string (2 to 40 of a-z, 0-9 and -, starting with a letter),
"itemId": string (1 to 64 of letters, digits, . : - _), "baseRevision": number, "deleted": bool,
"encryption": "none" | "e2ee", "keyVersion": int | null, "payload": string | null }`. A delete has
no payload and anything else has one, up to 1 MB. An `e2ee` record must use the scope's current
`keyVersion`. `SyncRecordDto` is the stored record: `{ "collection", "itemId", "revision",
"deleted", "encryption", "keyVersion", "payload", "updatedAt" }`. Deletes stay in the feed for 90
days. A scope holds up to `Sync__QuotaBytes` of payload (200 MB unless set), and an account may push
`Sync__PushesPerMinute` times a minute (120 unless set).

The key envelope is the scope's end-to-end key, wrapped by the desktop app with the passphrase and
with the recovery key; the server can not open it. The first key is version 1. Sending the current
version again stores a new wrapping of the same key (a new passphrase); the next version is a new
key (after someone left a team), and the app seals the scope's records again under it. Deleting the
key (a lost passphrase and recovery key) deletes every sealed record, which nobody can open any
more. Deleting the key or the records starts a new `epoch`, which tells each computer to forget
what it knew of the scope and send what it holds again.

### Teams

Accounts in a team share its sync scope. Roles: `owner` (everything, the only role that changes or
removes Owners and Admins or deletes the team), `admin` (invites, and manages Members and Viewers),
`member` (reads and writes the team's items) and `viewer` (reads them only). A team always keeps an
Owner. A team an account is not in answers 404. Invitations go to an email address and only an
account with that address confirmed sees and accepts them, so the email links to
`https://runovahq.com/account/invitations` and carries no secret. They last 7 days, and inviting
an address again replaces its invitation.

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/teams` | Account | none | 200 `{ "items": TeamDto[] }`; 401 |
| POST | `/api/v1/teams` | Account | `{ "name": string (1 to 80) }` | 201 `TeamDto` (the caller is its Owner); 400; 401 |
| GET | `/api/v1/teams/{id}` | Account (member) | none | 200 `TeamDto`; 401; 404 |
| PATCH | `/api/v1/teams/{id}` | Account (Owner or Admin) | merge patch of `name` | 200 `TeamDto`; 400; 401; 403; 404 |
| DELETE | `/api/v1/teams/{id}` | Account (Owner) | `StepUpRequest` | 204 (members, invitations, scope and records gone); 400; 401; 403; 404 |
| GET | `/api/v1/teams/{id}/members` | Account (member) | none | 200 `{ "items": TeamMemberDto[] }`; 401; 404 |
| PATCH | `/api/v1/teams/{id}/members/{userId}` | Account (Owner or Admin) | `{ "role": string, "password"?: string, "code"?: string }` (a step-up) | 200 `TeamMemberDto`; 400; 401; 403; 404; 409 the last Owner |
| DELETE | `/api/v1/teams/{id}/members/{userId}` | Account (the member, or an Owner or Admin) | `StepUpRequest` (not needed to leave) | 204; 400; 401; 403; 404; 409 the last Owner |
| GET | `/api/v1/teams/{id}/invitations` | Account (Owner or Admin) | none | 200 `{ "items": TeamInvitationDto[] }`; 401; 403; 404 |
| POST | `/api/v1/teams/{id}/invitations` | Account (Owner or Admin) | `{ "email": string, "role": string }` | 201 `TeamInvitationDto`; 400; 401; 403; 404; 409 already a member; 429 |
| DELETE | `/api/v1/teams/{id}/invitations/{invitationId}` | Account (Owner or Admin) | none | 204; 401; 403; 404 |
| GET | `/api/v1/teams/{id}/activities` | Account (Owner or Admin) | query `page`, `pageSize` | 200 `Page<ActivityDto>`; 400; 401; 403; 404 |
| GET | `/api/v1/invitations` | Account | none | 200 `{ "items": [{ "id", "teamId", "teamName", "role", "invitedBy", "expiresAt" }] }`; 401 |
| POST | `/api/v1/invitations/{id}/acceptances` | Account | none | 201 `TeamDto`; 401; 404 not for this account, or expired |
| DELETE | `/api/v1/invitations/{id}` | Account | none | 204 (declined); 401; 404 |

`TeamDto`: `{ "id": number, "name": string, "role": string, "memberCount": int, "scopeId": number,
"createdAt": time }`. `TeamMemberDto`: `{ "userId": number, "email": string, "displayName":
string, "role": string, "joinedAt": time }`. `TeamInvitationDto`: `{ "id": number, "email": string,
"role": string, "createdAt": time, "expiresAt": time }`. Removing a member ends their access to the
team's scope at once; the app then suggests rotating the team key. Deleting an account that is the
only Owner of a team with other members is a 409 until the team has another Owner or is deleted;
a team of one goes with its account.

### Account sessions and activity

Every browser and every computer signed in to an account is a session. The session cookie (and a
computer's tokens) name it, and each request checks it is still live, so ending one signs that
browser or computer out at its next request. Changing or resetting the password ends every other
session at once. A sign-in from a browser and address the account has not used in 30 days sends
the owner a "new sign-in" email (not for the very first session).

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/sessions` | Account | none | 200 `{ "items": SessionDto[] }`, this session first; 401 |
| DELETE | `/api/v1/sessions` | Account | `StepUpRequest` | 204 (every other session ended); 400 step-up failed; 401 |
| DELETE | `/api/v1/sessions/{id}` | Account | none | 204; 401; 404 not this account's, or ended already |
| GET | `/api/v1/activities` | Account | query `page`, `pageSize`, `action` | 200 `Page<ActivityDto>`, newest first; 400; 401 |

`SessionDto`: `{ "id": number, "kind": "web" | "desktop", "deviceName": string, "platform": string,
"appVersion": string | null, "ip": string | null, "createdAt": time, "lastSeenAt": time,
"current": bool }`. `ip` is the address last seen; `lastSeenAt` is kept to within 5 minutes.

`ActivityDto`: `{ "id": number, "action": string, "teamId": number | null, "ip": string | null,
"device": string | null, "at": time, "details": object | null }`. Actions: `sign-in`,
`sign-in-failed`, `sign-out`, `device-sign-in`, `session-ended`, `sessions-ended`,
`refresh-token-reused`, `email-verified`, `password-changed`, `password-reset`, `two-factor-on`,
`two-factor-off`, `login-linked`, `login-unlinked`, `account-updated`, `key-set`, `key-changed`,
`key-reset`, `sync-reset`, `sync-policy-changed`, `team-created`, `team-updated`, `team-deleted`, `member-invited`,
`member-joined`, `member-removed`, `member-role-changed`, `team-left`. No entry holds a password,
code, token or key.

`StepUpRequest`: `{ "password": string | null, "code": string | null }`. An account with a password
gives it; one with none but two-factor gives a current code; one with neither (Google only) must
have signed in within the last 10 minutes. A failure is 400 `validation-failed` naming `password`,
`code` or `signIn`.

### Audit entries (Admin)

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/audit-entries` | Admin | query `page`, `pageSize`, `actorId`, `actorKind`, `action`, `targetType`, `since` | 200 `Page<AuditEntryDto>`; 400; 401; 403 |

`AuditEntryDto`: `{ "id": number, "at": time, "actorKind": "user" | "api-client" | "system",
"actorId": number | null, "action": string, "targetType": string, "targetId": string,
"ip": string | null }`. Actions are `<resource>.<verb>`: `user.invite`, `user.update`,
`user.delete`, `user.password-reset`, `user.two-factor-reset`, `news.create`, `news.update`,
`news.archive`, `news.publish`, `post.create`, `post.update`, `post.archive`, `post.publish`,
`media.upload`, `media.delete`, `api-client.create`, `api-client.update`, `api-client.revoke`,
`api-client.rotate`. Entries are never changed or deleted through the API. No entry holds a secret,
token, password or signature.

### News

| Method | Path | Auth | Request | Responses |
### Reports (Admin)

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/reports/current` | Admin | query `days` (1 to 365, default 30) | 200 `ReportDto`; 400; 401; 403 |

The numbers behind the admin Reports page, counted when asked and never cached. The period is the
last `days` whole UTC days, today included. `ReportDto`:

```json
{
  "generatedAt": "2026-11-06T09:00:00.000Z",
  "days": 30,
  "users": {
    "total": 120, "accounts": 115, "admins": 2, "editors": 3, "disabled": 1,
    "unconfirmed": 4, "twoFactor": 9, "joined": 31, "active": 57
  },
  "signUps": [{ "date": "2026-10-08", "count": 2 }],
  "newestUsers": [
    { "id": 120, "displayName": "Ada", "email": "ada@example.com", "staff": false, "createdAt": "2026-11-06T08:12:00.000Z" }
  ],
  "sessions": {
    "web": 40, "desktop": 22,
    "platforms": [{ "name": "windows", "count": 14 }],
    "appVersions": [{ "name": "3.3.0", "count": 18 }]
  },
  "teams": { "total": 6, "members": 19, "pendingInvitations": 2 },
  "sync": { "scopes": 70, "items": 1400, "bytes": 5242880 },
  "content": {
    "newsPublished": 48, "newsScheduled": 1, "newsDrafts": 3,
    "postsPublished": 12, "postsScheduled": 0, "postsDrafts": 2, "media": 30
  },
  "apiClients": { "active": 2, "inactive": 1 },
  "latestRelease": "3.3.0"
}
```

`accounts` are the users with no staff role; an Admin counts once, under `admins`, even with the
Editor role too. `joined` counts the users made in the period and `active` the users who signed in
or were seen on a session in it. `signUps` has one entry per day of the period, oldest first, zero
included. `sessions` counts the sessions not ended and seen in the period, with the computers'
platforms and app versions (an empty name is a computer that sent none), the eight most common.
`sync` leaves out deleted items. An Editor gets 403.

|---|---|---|---|---|
| GET | `/api/v1/news` | Anonymous | query below | 200 `Page<NewsListItemDto>`, weak `ETag`; 304; 400 |
| GET | `/api/v1/news/{slug}` | Anonymous | `If-None-Match` | 200 `NewsItemDto`, `ETag`; 304; 404 when missing or not published |
| GET | `/api/v1/news/{id}` | Editor or news:write | none | 200 `NewsItemAdminDto` in any status; 401; 403; 404 |
| POST | `/api/v1/news` | Editor or news:write | `NewsItemWriteDto`; `Idempotency-Key` optional | 201 `NewsItemAdminDto`, `Location: /api/v1/news/{id}`, `ETag`; 400; 401; 403; 409 slug taken; 422; 429 |
| PUT | `/api/v1/news/{id}` | Editor or news:write | `NewsItemWriteDto`; `If-Match` | 200 `NewsItemAdminDto`, `ETag`; 400; 401; 403; 404; 409; 412; 428 |
| PATCH | `/api/v1/news/{id}` | Editor or news:write | merge patch of `NewsItemWriteDto`; `If-Match` | 200 `NewsItemAdminDto`, `ETag`; 400; 401; 403; 404; 409; 412; 428 |
| DELETE | `/api/v1/news/{id}` | Editor or news:write | `If-Match` | 204 (archived, not deleted); 401; 403; 404; 412; 428 |

`{id}` and `{slug}` share a position: `{id}` is all digits (route constraint `long`) and a slug
must contain a letter, so they never clash. Slugs are 3 to 120 characters of `a-z`, `0-9` and
single hyphens, unique among news items (archived ones included).

`GET /api/v1/news` query:

| Parameter | Type | Meaning |
|---|---|---|
| `category` | category, repeatable | Any of these categories |
| `severity` | severity, repeatable | Any of these severities |
| `minSeverity` | severity | This level or higher |
| `technology` | slug, repeatable | Items naming any of these technologies |
| `tag` | string, repeatable | Items with any of these tags |
| `since` | time | `publishedAt` at or after this time |
| `q` | string, 2 to 100 chars | Full-text search over title, summary and body (PostgreSQL `websearch_to_tsquery`, English) |
| `sort` | `-publishedAt` (default), `publishedAt`, `-severity` | `-severity` sorts by severity, then newest first |
| `status` | status, repeatable | Staff and `news:write` only (401 or 403 otherwise); default is published |
| `page`, `pageSize` | int | See [Paging](#paging) |

Different parameters combine with AND; repeated values of one parameter combine with OR. An
unknown category, severity or technology value is a 400. Anonymous callers see only items with
status `published` and `publishedAt` at or before now.

`NewsListItemDto`:

```json
{
  "id": 42,
  "slug": "openssh-10-3-fixes-a-pre-auth-crash",
  "url": "https://runovahq.com/news/openssh-10-3-fixes-a-pre-auth-crash",
  "title": "OpenSSH 10.3 fixes a pre-auth crash",
  "summary": "A crafted key exchange can crash sshd before sign-in. Update to 10.3.",
  "category": "security",
  "severity": "high",
  "technologies": [
    { "technology": "openssh", "name": "OpenSSH", "versionRange": ">=9.8.0 <10.3.0", "fixedIn": "10.3.0" }
  ],
  "cveIds": ["CVE-2026-41234"],
  "cvssScore": 7.5,
  "tags": ["ssh", "servers"],
  "publishedAt": "2026-10-29T08:00:00.000Z",
  "updatedAt": "2026-10-29T09:30:00.000Z"
}
```

`NewsItemDto` adds `"bodyHtml": string` (rendered by Markdig and cleaned by HtmlSanitizer: no
script, iframe, object, embed, form, style attribute, event handler attribute or `javascript:`
URL; links get `rel="noopener noreferrer nofollow"` when external) and
`"sourceLinks": [{ "title": string, "url": string }]`.

`NewsItemAdminDto` adds `"bodyMarkdown": string`, `"status": status`, `"createdAt": time`,
`"createdBy": { "kind": "user" | "api-client", "id": number, "name": string }` and
`"version": string`.

`NewsItemWriteDto`:

```json
{
  "slug": "openssh-10-3-fixes-a-pre-auth-crash",
  "title": "OpenSSH 10.3 fixes a pre-auth crash",
  "summary": "A crafted key exchange can crash sshd before sign-in. Update to 10.3.",
  "bodyMarkdown": "## What happened\n...",
  "category": "security",
  "severity": "high",
  "technologies": [{ "technology": "openssh", "versionRange": ">=9.8.0 <10.3.0", "fixedIn": "10.3.0" }],
  "cveIds": ["CVE-2026-41234"],
  "cvssScore": 7.5,
  "sourceLinks": [{ "title": "OpenSSH 10.3 release notes", "url": "https://www.openssh.com/txt/release-10.3" }],
  "tags": ["ssh", "servers"],
  "status": "scheduled",
  "publishedAt": "2026-10-31T08:00:00.000Z"
}
```

Validation (400 with the field named in `errors`): title 5 to 160 characters, summary 20 to 400,
body up to 100,000; category and severity from the enums with the category's allowed severities
(`security` needs `low` or higher, every other category needs `info`); technology slugs from the
list, valid ranges, at most 20 entries; CVE ids match `CVE-\d{4}-\d{4,}`; `cvssScore` 0.0 to 10.0
with one decimal; source links absolute `https` URLs, at most 10; at most 10 tags of 2 to 32
characters in `a-z0-9-`; `scheduled` needs a future `publishedAt`; `published` with no
`publishedAt` takes the current time; `published` with a future `publishedAt` is a 400 (use
`scheduled`). A security item with no technology is a 400.

### Technologies

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/technologies` | Anonymous | none | 200 `TechnologyDto[]` (not paged), `ETag`; 304 |

`TechnologyDto`: `{ "slug": string, "name": string, "kind": kind, "detectable": bool }`.

### Blog posts

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/posts` | Anonymous | query `tag`, `q`, `page`, `pageSize`, `status` (staff and `posts:write` only) | 200 `Page<PostListItemDto>`, weak `ETag`; 304; 400 |
| GET | `/api/v1/posts/{slug}` | Anonymous | `If-None-Match` | 200 `PostDto`, `ETag`; 304; 404 |
| GET | `/api/v1/posts/{id}` | Editor or posts:write | none | 200 `PostAdminDto`; 401; 403; 404 |
| POST | `/api/v1/posts` | Editor or posts:write | `PostWriteDto`; `Idempotency-Key` optional | 201 `PostAdminDto`, `Location: /api/v1/posts/{id}`, `ETag`; 400; 401; 403; 409; 422; 429 |
| PUT | `/api/v1/posts/{id}` | Editor or posts:write | `PostWriteDto`; `If-Match` | 200 `PostAdminDto`; 400; 401; 403; 404; 409; 412; 428 |
| PATCH | `/api/v1/posts/{id}` | Editor or posts:write | merge patch; `If-Match` | 200 `PostAdminDto`; 400; 401; 403; 404; 409; 412; 428 |
| DELETE | `/api/v1/posts/{id}` | Editor or posts:write | `If-Match` | 204 (archived); 401; 403; 404; 412; 428 |
| GET | `/api/v1/tags` | Anonymous | none | 200 `[{ "slug": string, "name": string, "postCount": int }]` for published posts; 304 |

`PostListItemDto`: `{ "id", "slug", "url", "title", "excerpt", "coverImage": { "url", "width",
"height", "alt" } | null, "tags": [{ "slug", "name" }], "author": { "displayName" },
"publishedAt", "updatedAt", "readingTimeMinutes": int }`. Reading time is the body's word count
over 230, rounded up, at least 1. `PostDto` adds `bodyHtml` (same sanitizer as news).
`PostAdminDto` adds `bodyMarkdown`, `status`, `createdAt`, `createdBy` and `version`.
`PostWriteDto`: `slug`, `title` (5 to 160), `excerpt` (20 to 300), `bodyMarkdown`, `coverMediaId`
(a media id or null), `tags` (names; unknown ones are created), `status`, `publishedAt`. The
author is the signed-in user, or the API client's name.

### Media

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/media` | Editor or posts:write | query `page`, `pageSize` | 200 `Page<MediaDto>`; 400; 401; 403 |
| POST | `/api/v1/media` | Editor or posts:write | multipart: `file`, `alt` (1 to 200 chars) | 201 `MediaDto`, `Location: /api/v1/media/{id}`; 400 wrong or disguised type; 401; 403; 413 over 5 MB |
| DELETE | `/api/v1/media/{id}` | Editor or posts:write | none | 204; 401; 403; 404; 409 still a post's cover |

PNG, JPEG, WebP and AVIF only, decided by the file's leading bytes, never by its name or the
part's `Content-Type`. EXIF, XMP and ICC comments are stripped on save (the image is re-encoded).
Files land in the configured media folder under a random name and are served at
`/media/<yyyy>/<mm>/<random>.<ext>` with `Cache-Control: public, max-age=31536000, immutable`.
`MediaDto`: `{ "id", "url", "contentType", "width", "height", "size", "alt", "createdAt" }`.

### API clients (Admin)

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/api-clients` | Admin | query `page`, `pageSize`, `revoked` | 200 `Page<ApiClientDto>`; 400; 401; 403 |
| POST | `/api/v1/api-clients` | Admin | `{ "name": string, "scopes": string[], "ipAllowlist": string[], "expiresAt": time or null }` | 201 `ApiClientCreatedDto`, `Location`; 400; 401; 403; 409 name taken |
| GET | `/api/v1/api-clients/{id}` | Admin | none | 200 `ApiClientDto`; 401; 403; 404 |
| PATCH | `/api/v1/api-clients/{id}` | Admin | merge patch of `name`, `scopes`, `ipAllowlist`, `expiresAt`; `If-Match` | 200 `ApiClientDto`; 400; 401; 403; 404; 412; 428 |
| DELETE | `/api/v1/api-clients/{id}` | Admin | `If-Match` | 204 (revoked at once, kept for the audit trail); 401; 403; 404; 412; 428 |
| POST | `/api/v1/api-clients/{id}/secrets` | Admin | `{ "overlapMinutes": int }` (0 to 10080, default 1440) | 201 `ApiClientSecretDto`; 400; 401; 403; 404 revoked or missing |

`ApiClientDto`:

```json
{
  "id": 3,
  "name": "Advisory importer",
  "scopes": ["news:write"],
  "ipAllowlist": ["203.0.113.0/24"],
  "keys": [
    { "keyId": "rk_5f2c9a1e7b3d4c60", "createdAt": "2026-10-01T08:00:00.000Z", "expiresAt": null }
  ],
  "expiresAt": null,
  "revokedAt": null,
  "lastUsedAt": "2026-10-30T11:58:02.000Z",
  "createdAt": "2026-10-01T08:00:00.000Z",
  "version": "887"
}
```

`ApiClientCreatedDto`: `{ "client": ApiClientDto, "keyId": string, "secret": string }`.
`ApiClientSecretDto`: `{ "keyId": string, "secret": string, "previousKeyExpiresAt": time }`.
The secret appears in these two responses only, never again. A key id is `rk_` and 16 lowercase
hex characters; a secret is `rnv_sk_` and 43 base64url characters (32 random bytes). After a
rotation the old key keeps working until `previousKeyExpiresAt`, then only the new one does.
`ipAllowlist` takes IPv4 and IPv6 addresses and CIDR ranges; empty means any address.

### Releases

| Method | Path | Auth | Request | Responses |
|---|---|---|---|---|
| GET | `/api/v1/releases/latest` | Anonymous | `If-None-Match` | 200 `ReleaseDto`, `ETag`; 304; 503 when no release was ever fetched |
| GET | `/api/v1/releases/latest/assets` | Anonymous | query `platform`, `arch`, `kind` | 200 `ReleaseAssetDto[]`; 400 unknown value; 503 |
| GET | `/api/v1/releases/latest/downloads/{platform}` | Anonymous | query `arch`, `kind` (both optional) | 302 `Location:` the asset's GitHub download URL; 404 unknown platform or no such asset; 503 |

`ReleaseDto`:

```json
{
  "version": "2.2.0",
  "tagName": "v2.2.0",
  "name": "Runova 2.2.0",
  "publishedAt": "2026-10-20T10:00:00.000Z",
  "notesUrl": "https://github.com/SmartClouds/Runova/releases/tag/v2.2.0",
  "fetchedAt": "2026-10-30T11:45:00.000Z",
  "assets": [
    {
      "name": "Runova-Setup-2.2.0.exe",
      "platform": "windows",
      "arch": "x64",
      "kind": "nsis",
      "size": 262371947,
      "sha256": "9f1c...",
      "downloadUrl": "https://github.com/SmartClouds/Runova/releases/download/v2.2.0/Runova-Setup-2.2.0.exe"
    }
  ]
}
```

`sha256` comes from the GitHub asset's `digest` field (`sha256:<hex>`) and is `null` when GitHub
has none. Asset names come from `apps/desktop/electron-builder.yml`. Only names matching this table
are ever returned; every other file in a release (updater metadata, blockmaps, server core
archives, checksum files, plugin zips and anything else) is left out:

| Pattern (`{v}` is the version) | Platform | Arch | Kind |
|---|---|---|---|
| `Runova-Setup-{v}.exe` | windows | x64 | nsis |
| `Runova-{v}.dmg` | macos | x64 | dmg |
| `Runova-{v}-arm64.dmg` | macos | arm64 | dmg |
| `Runova-{v}-universal.dmg` | macos | universal | dmg |
| `Runova-{v}-mac.zip` | macos | x64 | zip |
| `Runova-{v}-arm64-mac.zip` | macos | arm64 | zip |
| `Runova-{v}.AppImage` | linux | x64 | appimage |
| `Runova-{v}-arm64.AppImage` | linux | arm64 | appimage |
| `Runova-{v}-amd64.deb` | linux | x64 | deb |
| `Runova-{v}-arm64.deb` | linux | arm64 | deb |

The best asset for `/downloads/{platform}`: windows gives `nsis` x64; macos gives `dmg` for the
asked `arch`, else `arm64`, else `universal`, else `x64`; linux gives `appimage` for the asked
`arch` (default `x64`). `kind` overrides the default kind. The release is read from
`https://api.github.com/repos/SmartClouds/Runova/releases/latest` every 15 minutes with
`If-None-Match`; when GitHub fails, the last stored release keeps being served.

## Idempotency and rate limits

- `Idempotency-Key` (1 to 255 visible ASCII characters) on POST to `/news`, `/posts` and
  `/media`. The API keeps the key, a SHA-256 of the body and the response for 24 hours per caller
  (per API client, or per user). The same key with the same body replays the first response with
  `Idempotent-Replayed: true` and creates nothing; the same key with another body is a 422.
- API clients: 60 requests a minute each (token bucket, burst 20). Over it: 429 with `Retry-After`.
- Sign-in and the anonymous account routes (`/accounts`, `/email-verifications`,
  `/verification-emails`, `/password-resets`, `/password-setups`): 10 requests a minute per IP
  together. Anonymous reads: 300 a minute per IP.

## Signed requests

An API client signs every request with HMAC-SHA256. The scheme is version `v1`.

### Headers

| Header | Value |
|---|---|
| `X-Runova-Key-Id` | The key id, `rk_` and 16 hex characters |
| `X-Runova-Timestamp` | Unix time in whole seconds |
| `X-Runova-Nonce` | 16 or more random bytes in base64url without padding (22 to 64 characters of `A-Za-z0-9_-`), new for every request |
| `X-Runova-Content-SHA256` | Lowercase hex SHA-256 of the exact body bytes (of the empty string when there is no body) |
| `X-Runova-Signature` | `v1=` and the lowercase hex HMAC-SHA256 of the canonical string |

### Signing key

The client never uses the secret directly as the HMAC key. The signing key is the 32-byte SHA-256
of the secret string's UTF-8 bytes (the whole string, `rnv_sk_` prefix included). The server keeps
only that signing key, sealed with ASP.NET Core Data Protection whose key ring lives outside the
database, and never the secret, so the secret can not be read back and a database dump alone can
not sign.

### Canonical string

Seven lines joined by a single `\n` (LF), with no newline at the end:

```text
RUNOVA-HMAC-SHA256
<method in upper case>
<path>
<canonical query>
<timestamp, as sent>
<nonce, as sent>
<content SHA-256, as sent>
```

- **Path:** the request path as sent, without the query, starting with `/api/v1/`. The reverse
  proxy passes it through unchanged.
- **Canonical query:** split the raw query on `&`; split each part at its first `=` (a part with
  no `=` has an empty value); percent-decode name and value, reading `+` as a space; encode both
  again per RFC 3986 (only `A-Z a-z 0-9 - . _ ~` stay as they are, everything else becomes `%XX`
  with upper-case hex from its UTF-8 bytes); sort by encoded name, then encoded value, by ordinal
  byte order; join as `name=value` with `&`. No query gives an empty line.

### Verification

The server refuses the request with 401 `unauthorized` and one fixed detail ("The request could not
be authenticated.") when any of these fail, and never says which: the five headers are present and
well formed; the key id belongs to a client that is not revoked or expired, and the key is current
or within its overlap; the timestamp is within 300 seconds of the server clock; the nonce has not
been seen for this key id in the last 10 minutes (nonces are stored, and a Hangfire job deletes
those older than 10 minutes); the body's SHA-256 equals `X-Runova-Content-SHA256`; the caller's IP
is in the allowlist; the signature matches, compared in constant time. A valid signature without the
needed scope gets 403 `forbidden`. Success updates `lastUsedAt` (at most once a minute).

### Test vectors

Both vectors use one secret. The body of vector 1 is kept short for reading; the API would answer
400 to it because fields are missing, but the signature is valid. Reproduce with openssl:

```sh
SECRET='rnv_sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
KEY=$(printf %s "$SECRET" | openssl dgst -sha256 -r | cut -d' ' -f1)
# vector 1
BODY_SHA=$(printf %s '<the body below>' | openssl dgst -sha256 -r | cut -d' ' -f1)
printf 'RUNOVA-HMAC-SHA256\nPOST\n/api/v1/news\n\n1793361600\nAAECAwQFBgcICQoLDA0ODw\n%s' "$BODY_SHA" \
  | openssl dgst -sha256 -mac HMAC -macopt hexkey:$KEY
```

#### Vector 1: POST with a body

- Secret: `rnv_sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`
- Signing key (hex): `78bc032006bcf9367830b2d91c2abf86ea4d334972e2ad6a9fd8c0e646f583bb`
- Key id: `rk_00000000000000a1`
- Request: `POST /api/v1/news`, timestamp `1793361600` (2026-10-30T12:00:00Z), nonce `AAECAwQFBgcICQoLDA0ODw`
- Body: `{"slug":"openssh-10-3-fixes-a-pre-auth-crash","title":"OpenSSH 10.3 fixes a pre-auth crash","category":"security","severity":"high"}`
- Body SHA-256: `8e4afa4190017c2893f9af2cd4dce8f52e69c22490083ce787849a95bb922147`

Canonical string:

```text
RUNOVA-HMAC-SHA256
POST
/api/v1/news

1793361600
AAECAwQFBgcICQoLDA0ODw
8e4afa4190017c2893f9af2cd4dce8f52e69c22490083ce787849a95bb922147
```

- Signature header: `v1=ff628625fe8c31a13fda3a8c74b3e4864249c0a36c266b8698de7a89e43d4284`

#### Vector 2: a query to canonicalize, no body

- Secret: `rnv_sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`
- Signing key (hex): `78bc032006bcf9367830b2d91c2abf86ea4d334972e2ad6a9fd8c0e646f583bb`
- Key id: `rk_00000000000000a1`
- Request: `GET /api/v1/news?technology=openssh&q=open+ssh&category=security&technology=nodejs&page=2`, timestamp `1793361600`, nonce `EBESExQVFhcYGRobHB0eHw`
- Body: ``
- Body SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

Canonical string:

```text
RUNOVA-HMAC-SHA256
GET
/api/v1/news
category=security&page=2&q=open%20ssh&technology=nodejs&technology=openssh
1793361600
EBESExQVFhcYGRobHB0eHw
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

- Signature header: `v1=5e21809896d8ca8d6aa37226007ad4c786b61f5ac3756ed364e69fdee515e20e`

The reference clients (C# in the integration tests, TypeScript in
`docs/website/examples/sign-request.ts`, added by T008) must produce both signatures, and the
handler must accept both requests with its clock fixed at the timestamp.
