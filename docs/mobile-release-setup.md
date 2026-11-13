# Mobile release setup

What the owner has to do once so that a `v1.2.3` tag produces a signed Android build and a TestFlight
build, and so that push notifications reach both. Do the steps in order. `.github/workflows/cd-mobile.yml`
runs the builds. Until its secrets exist it skips each build and leaves a warning on the run.

Checked on 2026-11-09: the repository has no Actions secrets or variables yet, so every secret below
is new.

The `gh` and `base64` lines work in Git Bash or on a Mac. Replace anything in `<angle brackets>`. Keep
every downloaded key out of the repository.

## 1. Apple App IDs

Find your ten-character Team ID on [developer.apple.com/account](https://developer.apple.com/account)
under Membership details.

On [Identifiers](https://developer.apple.com/account/resources/identifiers/list), press +, choose
App IDs, then App, and register these two as Explicit:

| Description | Bundle ID | Capabilities |
|---|---|---|
| Runova | `com.runovahq.app` | Push Notifications |
| Runova Notifications | `com.runovahq.app.notifications` | none |

The shared keychain group (`$(AppIdentifierPrefix)com.runovahq.app.shared`) needs no registration. It
works because both App IDs belong to the same team.

```
gh secret set APPLE_TEAM_ID --repo SmartClouds/Runova --body "<team id>"
```

## 2. APNs key

On [Keys](https://developer.apple.com/account/resources/authkeys/list), press +, name it
`Runova Push`, tick Apple Push Notifications service (APNs), choose Production or Sandbox & Production
if asked, then Register and Download. Apple lets you download it only once. Note the Key ID. It goes
on the server in step 9.

## 3. The app in App Store Connect

On [Apps](https://appstoreconnect.apple.com/apps), press + and New App. Platform iOS, name Runova,
bundle ID `com.runovahq.app`, any SKU such as `runova-ios`.

## 4. App Store Connect API key

On [Users and Access, Integrations, App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api),
open Team Keys and generate a key named `Runova CI` with the **Admin** role. CD signs automatically,
so Xcode creates the certificates and a profile for each target with this key, and a key with a lower
role is refused. A key's role can't be changed later. Download the `.p8` (once only) and note the Key
ID and the Issuer ID at the top of the page.

```
gh secret set APP_STORE_CONNECT_KEY_ID --repo SmartClouds/Runova --body "<key id>"
gh secret set APP_STORE_CONNECT_ISSUER_ID --repo SmartClouds/Runova --body "<issuer id>"
base64 -w0 AuthKey_<key id>.p8 | gh secret set APP_STORE_CONNECT_KEY_BASE64 --repo SmartClouds/Runova
```

On a Mac, use `base64 -i AuthKey_<key id>.p8` instead of `base64 -w0`.

## 5. The Mac runner

Xcode 27.2 is already on `SmartAgent-Mac-01`, so there is nothing to install. After every Xcode update,
an admin on the Mac has to run `sudo xcodebuild -runFirstLaunch` once, or the iOS job in CI stops at
Check for Xcode (its CoreSimulator is still the old one, so there is no simulator to test on).
Automatic signing stores
a certificate in the keychain of the user the runner runs as, so that keychain has to be unlocked.
Sign in on the Mac as that user, keep the session open, and run:

```
xcodebuild -version
security unlock-keychain login.keychain-db
security find-identity -v -p codesigning
```

The last line may list nothing before the first build. An error about the keychain is the thing to
fix.

## 6. Firebase and the Android build

In the [Firebase console](https://console.firebase.google.com), create a project called Runova. Open
Project settings, General, Your apps, add an Android app with the package name `com.runovahq.app`, and
download `google-services.json`. The build doesn't read that file and it shouldn't be committed. It's
only where these four values come from:

| Secret | Field in `google-services.json` |
|---|---|
| `RUNOVA_FIREBASE_API_KEY` | `client[0].api_key[0].current_key` |
| `RUNOVA_FIREBASE_APP_ID` | `client[0].client_info.mobilesdk_app_id` |
| `RUNOVA_FIREBASE_PROJECT_ID` | `project_info.project_id` |
| `RUNOVA_FIREBASE_SENDER_ID` | `project_info.project_number` |

```
gh secret set RUNOVA_FIREBASE_API_KEY --repo SmartClouds/Runova --body "<value>"
gh secret set RUNOVA_FIREBASE_APP_ID --repo SmartClouds/Runova --body "<value>"
gh secret set RUNOVA_FIREBASE_PROJECT_ID --repo SmartClouds/Runova --body "<value>"
gh secret set RUNOVA_FIREBASE_SENDER_ID --repo SmartClouds/Runova --body "<value>"
```

Set all four or none. CD stops the build if only some are set, because the app would break at launch.

## 7. Firebase service account

In Project settings, Service accounts, press Generate new private key and save the file as
`service-account.json`. This prints the three server settings for step 9:

```
node -e "const k=require('./service-account.json');console.log('PUSH_FCM_PROJECT_ID='+k.project_id);console.log('PUSH_FCM_CLIENT_EMAIL='+k.client_email);console.log('PUSH_FCM_PRIVATE_KEY=\"'+k.private_key.replace(/\n/g,'\\\\n')+'\"')"
```

## 8. Android keystore

```
keytool -genkeypair -v -keystore release.keystore -alias runova -keyalg RSA -keysize 4096 -validity 10000
```

Use one password for the store and the key. Keep a copy of the file and the password somewhere safe.
If they're lost, updates to the app can't be signed.

```
base64 -w0 release.keystore | gh secret set RUNOVA_ANDROID_KEYSTORE_BASE64 --repo SmartClouds/Runova
gh secret set RUNOVA_ANDROID_KEY_ALIAS --repo SmartClouds/Runova --body "runova"
gh secret set RUNOVA_ANDROID_STORE_PASSWORD --repo SmartClouds/Runova
gh secret set RUNOVA_ANDROID_KEY_PASSWORD --repo SmartClouds/Runova
```

The last two ask for the value, so it stays out of your shell history.

## 9. Server settings

Turn the APNs key into one line:

```
awk 'NF { sub(/\r$/, ""); printf "%s\\n", $0 }' AuthKey_<apns key id>.p8
```

In Runova, open Projects, Environments, and add these to the website's Production environment (a copy
of `apps/website/.env.production`). `docker-compose.production.yaml` passes them to the API:

```
PUSH_FCM_PROJECT_ID=<from step 7>
PUSH_FCM_CLIENT_EMAIL=<from step 7>
PUSH_FCM_PRIVATE_KEY="<from step 7>"
PUSH_APNS_KEY_ID=<key id from step 2>
PUSH_APNS_TEAM_ID=<team id from step 1>
PUSH_APNS_PRIVATE_KEY="<the line printed above>"
```

The API sends for `com.runovahq.app` on Apple's production service by default, which is right for
TestFlight and the App Store. If a service's settings are missing or its key can't be read, that
service stays off and the API logs `FCM push is off` or `APNs push is off` once. Nothing else breaks,
and the inbox still works.

## 10. Check the secrets

```
gh secret list --repo SmartClouds/Runova
```

You should see these 12 names: `APPLE_TEAM_ID`, `APP_STORE_CONNECT_KEY_ID`,
`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_BASE64`, `RUNOVA_ANDROID_KEYSTORE_BASE64`,
`RUNOVA_ANDROID_STORE_PASSWORD`, `RUNOVA_ANDROID_KEY_ALIAS`, `RUNOVA_ANDROID_KEY_PASSWORD`,
`RUNOVA_FIREBASE_API_KEY`, `RUNOVA_FIREBASE_APP_ID`, `RUNOVA_FIREBASE_PROJECT_ID` and
`RUNOVA_FIREBASE_SENDER_ID`.

## 11. Release, server first

1. CD only builds a commit that CI passed on. A new push to master cancels CI on the commit before it,
   so hold pushes until CI is green on the commit you'll tag. If it was cancelled, run CI on the tag:
   `gh workflow run ci.yml --repo SmartClouds/Runova --ref <tag>`, then re-run CD and CD Mobile.
2. Push the tag. CD pushes the website images to GitHub Container Registry as the version and
   `latest`. It doesn't deploy them. Tags with a `-` such as `v1.2.3-beta.1` don't move `latest`, and
   CD Mobile refuses them.
3. In Runova, open Deploy, Apps and redeploy the website. The new API applies its migrations before it
   starts listening (`Database__MigrateOnStart`). Do this before anyone installs the new phone apps,
   since their push and encryption calls need this API.
4. Look in the API log for `push is off`. If it isn't there, the keys were read.
5. Download `runova-<version>.aab` from the GitHub Release and upload it by hand in the
   [Play Console](https://play.google.com/console) under Testing, Internal testing. Accept Play App
   Signing. CD doesn't publish to Play, and Google requires the first upload to be manual anyway.
6. The iOS build arrives in TestFlight. In App Store Connect, answer the export compliance question
   for the build. The app does use encryption, so answer it for what the app really does.
7. Try a real push on a real phone on each OS. Nothing has sent one yet.

## 12. Store listings: the privacy address

Both stores ask for a public privacy policy address. Use the same one in each:

```
https://runovahq.com/privacy
```

The page ships with the website, so redeploy the website (step 11.3) first and open the address in a
browser before you submit. Google also asks for a web page that explains how to delete an account:
use `https://runovahq.com/privacy#delete-account`.

- App Store Connect: App Information, Privacy Policy URL. Under App Privacy the app collects contact
  info (email address, name) and identifiers (the push token) for app functionality, linked to the
  user, and nothing is used for tracking.
- Play Console: App content, Privacy policy, then the Data safety form. Personal info (email address,
  name) and device IDs (the push token) are collected for app functionality, encrypted in transit and
  can be deleted on request. Nothing is shared with a third party for its own use, and push goes
  through Google's own service.

These answers match the policy page and what the apps do today (no analytics, ads or crash SDKs,
camera only for the sign-in QR code). Check them against each store's current form before you submit.
When an app starts collecting something new, change the page (`apps/website/web/src/pages/privacy.astro`)
and these answers in the same commit.
