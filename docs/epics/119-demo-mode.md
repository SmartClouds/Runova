# E119 Demo mode for the phone app

Milestone: standalone (Accounts, Mobile, Website). Depends on: E93, E118.

## Goal

App store reviewers, and anyone curious, can try every part of the phone app without an account or
a computer running Runova. The website has a page at `/demo` with a QR code. Scanning it with the
app's "Scan QR code" button signs into a demo account. Everything shows made-up data, every action
answers as if it worked, and nothing anyone does is saved, on the server or on a computer.

## Design

- **The code.** The QR holds the page's own address, `https://runovahq.com/demo`. A phone camera that
  scans it opens the page, which says to use the app. The app's scanner treats exactly
  `{site}/demo` as the demo code, so a staging page only works with a staging build.
- **Signing in.** The phone posts the `demo` grant to `POST /api/v1/device-tokens`. The website
  answers with stateless tokens: `rdm1.` for access (15 minutes) and `rrm1.` for refresh (30 days),
  both sealed with Data Protection. The account and session ids are `-1`, which no database row can
  have. No session row, activity, email or idempotency record is written. `Demo:Enabled` turns it
  off.
- **What the website answers.** A demo token only works under `/api/v1`, so the hubs and the relay
  refuse it. A middleware after authorization answers every demo request itself, before any handler
  or the idempotency store runs. Reads the phone makes get mock answers built from the real DTOs.
  Changes the phone makes get their usual success answer and are dropped. Anything else gets a 403
  problem. A test lists every account route, so a new route has to be classed as answered or refused.
- **The pretend computer.** The phone app has a demo computer inside it. When the account in use
  has a demo token, one switch puts an in-app hub, notification feed and memory link in place of the
  live ones. The computer runs the real handshake with a fixed key and answers every management
  method the app calls from JSON files, including scripted streams. It shows a still picture of a
  desktop for the remote screen and throws away files sent to it. Changes answer as done and change
  nothing.
- **The banner.** While the demo account is in use, both apps show "Demo. Nothing you do is saved."
- **Leaving.** The demo is an account like any other on the phone. Signing out of it removes it.

## Out of scope

- Receiving files from a computer, which would save a real file on the phone.
- Push notifications for the demo account.

## Tests

- Website: integration tests for the grant, refresh, refusal on hubs and staff routes, every mock
  answer, unchanged row counts, the route classification, and unit tests for the tokens and data.
- Rust: the demo code and token, the demo sign-in, the switch, a walk through every section, writes
  that change nothing, the remote screen and sending a file. A coverage test checks that every
  management method the app calls has a demo answer.
- Android and iOS: the banner on a fixture, snapshot tests.
- Web: the page, the QR path and the link from the download page.

## Store review

`docs/mobile-release-setup.md` holds the notes for App Review and the Play "App access" form.
