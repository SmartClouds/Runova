---

title: Android
category: Ship
order: 50
summary: Run Android emulators, create virtual devices, and work with connected phones.
keywords: android, emulator, avd, adb, phone, usb debugging
route: /android
---

The Android page lists your virtual devices (emulators) and any phones plugged in.

## Start an emulator

1. Click **Start** on a virtual device card.
2. Wait for the badge to say **Running**.

## Connect a phone

### Over Wi-Fi

1. On the phone, go to Settings, Developer options, Wireless debugging, then "Pair device with pairing code".
2. Enter the six digit **Pairing code**, then click **Pair**.

```text
adb pair <address>:<port>
```

Use `adb devices` or the `<serial>` shown on the card.
