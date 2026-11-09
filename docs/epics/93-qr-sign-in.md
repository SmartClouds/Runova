# E93 Sign in to the app with a QR code

The phone app can sign in by scanning a QR code that a signed-in desktop app or the website account
shows, as well as through the browser.

## Flow

1. The signed-in side asks for a code (`POST /qr-sign-ins`) and shows `rq1.<code>` as a QR. Desktop:
   Account, Devices. Website: Devices and sessions.
2. The phone's sign-in screen has **Scan QR code**. The Rust core checks the text is one of ours and
   claims it with a PKCE challenge (`POST /qr-sign-in-claims`). The claim returns four digits.
3. The signed-in side polls, sees the scan and shows the same digits with Approve and Not my phone.
4. Once approved, the phone's poll (`POST /qr-sign-in-polls`) gets an ordinary one-time code and
   trades it at `POST /device-tokens`. So the session, the activity entry and the new sign-in email
   are the same as for a browser sign-in.

## Why it is safe to show

- The code alone does nothing. It needs an approval on the signed-in side, and the digits tell the
  person that the device they are approving is the one in their hand.
- A code is 32 random bytes kept only as its SHA-256, good for two minutes and one claim. Asking for
  a new one retires any code of that person nobody has scanned.
- A photo of the code can't race the real phone unnoticed: the second scanner is refused, so the
  person's own phone says the code is no longer valid.
- The token only ever reaches the device that made the PKCE challenge.

## Choices

- Scanning uses CameraX with ZXing on Android rather than ML Kit, because the APK is sideloaded and
  may land on phones with no Google Play services. iOS uses AVFoundation.
- The website stays silent about the mobile version: its copy says "the Runova app on your other
  device", and the code is drawn from `qrcode` as one SVG path.

## Not verified

- The Swift code has not been compiled, as with the rest of the iOS app (needs the Mac).
- Nothing has been tried with a real camera. The decoder is tested on generated frames.
