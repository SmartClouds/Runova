# E82 Notifications and push

Milestone: standalone (Mobile, Website). Depends on: E73, E81. Needs from the owner: a Firebase
project and an APNs key.

## Goal

Every kind of Runova notification reaches the phone, in the app and in the background, and each
category can be turned on or off.

## Design

- **Sources**: the desktop forwards the kinds in its inbox plus those that reach only the OS or
  Telegram today, including agent "needs input" from `agents/statusTracker.ts`.
- **Server**: device token registration, FCM and APNs sending, per-category preferences. Live
  delivery over `/hubs/notifications`. New DTOs through Mapperly.
- **Content**: one short line. Never terminal output or secrets.

## Tasks

- [ ] T1 Categories and preferences on the server
- [ ] T2 Device tokens, FCM and APNs senders behind an interface with fakes
- [ ] T3 Desktop forwarding
- [ ] T4 Inbox and settings screens
- [ ] T5 OS integration on both, with opening a notification going to the right screen

## Acceptance criteria

- AC1 Each category arrives while the app is open and while it is closed.
- AC2 A category turned off stops arriving.
- AC3 A test proves terminal text can not be placed in a push payload.
- AC4 Signing out stops pushes to that phone.

## Not in this epic

Encrypted push payloads.
