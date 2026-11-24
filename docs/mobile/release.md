# Releasing the mobile app

A `v1.2.3` tag releases the phone apps along with the desktop, through
`.github/workflows/cd-mobile.yml`. It is a separate workflow, so a problem with a phone build can't
hold up a desktop release.

The version comes from the tag, so there is nothing to bump by hand: `scripts/mobile-version.mjs`
turns it into the version name and a build number that always grows.

## What has to be set up once

Until these exist the workflow skips the build and leaves a warning on the run.

### Android

Make a new keystore and keep a copy somewhere safe. If it is lost, updates to the app can't be signed.

```
keytool -genkeypair -v -keystore release.keystore -alias runova -keyalg RSA -keysize 4096 -validity 10000
```

| Repository secret | Value |
|---|---|
| `RUNOVA_ANDROID_KEYSTORE_BASE64` | `base64 -w0 release.keystore` |
| `RUNOVA_ANDROID_STORE_PASSWORD` | the keystore's password |
| `RUNOVA_ANDROID_KEY_ALIAS` | `runova` |
| `RUNOVA_ANDROID_KEY_PASSWORD` | the key's password |

The signed APK and App Bundle are attached to the GitHub Release.

### iOS

Builds on a fresh GitHub-hosted Mac (`macos-latest`), never the self-hosted one, which keeps its disk
between jobs and runs CI for pull requests. Needs the app `com.runovahq.app` created in App Store
Connect and an App Store Connect API key with the Admin role.

| Repository secret | Value |
|---|---|
| `APPLE_TEAM_ID` | the ten-character team id |
| `APP_STORE_CONNECT_KEY_ID` | the key's id |
| `APP_STORE_CONNECT_ISSUER_ID` | the issuer id |
| `APP_STORE_CONNECT_KEY_BASE64` | `base64 -i AuthKey_XXXX.p8` |

The build goes to TestFlight.

### Passkeys (E115)

The phone apps sign in with the website's passkeys only once the site and the apps vouch for each
other. Set these on the website's server (`docker-compose.production.yaml` passes them to the API),
then check `https://<site>/.well-known/assetlinks.json` and
`https://<site>/.well-known/apple-app-site-association`.

| Server setting | Value |
|---|---|
| `PASSKEY_ANDROID_CERT_FINGERPRINTS` | the SHA-256 of the release key (`keytool -list -v -keystore release.keystore -alias runova`), and on a test site also the debug key's, split by commas |
| `PASSKEY_APPLE_APP_IDS` | `<APPLE_TEAM_ID>.com.runovahq.app` |

For iOS, turn on **Associated Domains** for `com.runovahq.app` in the Apple developer account, so
the provisioning profile carries the `webcredentials:runovahq.com` entitlement that `project.yml`
asks for. A site on another domain needs that entry changed to match.

### Google and Apple sign-in (E117)

The Android app signs in with Google through Credential Manager, and the iPhone app with Sign in
with Apple. Both send the ID token to the website, which checks it against keys it already has
(E116), so the apps need no keys of their own.

- Google: in the same Google Cloud project as the website's web client, add an OAuth client of type
  **Android** for the package `com.runovahq.app` with the SHA-1 of the release key (and, on a test
  project, the debug key). Credential Manager only hands out tokens for an app Google knows. The
  token's audience is the website's web client, which the API reads from the sign-in settings.
- Apple: turn on **Sign in with Apple** for the App ID `com.runovahq.app` in the Apple developer
  account, so the provisioning profile carries the `com.apple.developer.applesignin` entitlement
  that `project.yml` asks for. The website's Apple key must be enabled for this App ID too, and
  `appleBundleId` in the sign-in settings must be the app's bundle id (`com.runovahq.app` unless
  changed), since that is the audience of the app's tokens.
- Microsoft, and Google on the iPhone, go through the browser sign-in with `provider=` on the
  authorize link, so they need nothing more than the website's own setup.

### Several accounts (E118)

Nothing to set up. The website's `PushDevicesPerAccount` migration has to run before phones on this
version register their push token with an account tag (the API refuses an unknown field), so ship
the website first. Phones signed in on an earlier version keep their account: its tokens move to
the new slot on the first start.

### Push notifications

Needs a Firebase project and an APNs key. The website API reads them from `Push__Fcm__*` and
`Push__Apns__*`, see `docs/website/api-contract.md`, and stays silent without them. The Android build
also needs the project's public values:

| Repository secret | Value |
|---|---|
| `RUNOVA_FIREBASE_API_KEY` | from the Firebase Android app |
| `RUNOVA_FIREBASE_APP_ID` | from the Firebase Android app |
| `RUNOVA_FIREBASE_PROJECT_ID` | the project id |
| `RUNOVA_FIREBASE_SENDER_ID` | the project number |
