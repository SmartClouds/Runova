---
title: Runova on your phone
category: Connect
order: 14
summary: The Runova app for Android and iOS reaches your computers from anywhere. Follow and answer agents, commit, deploy, watch traffic and monitors, send files and open the Vault, with everything running on your computer.
keywords: phone, mobile, android, ios, app, sign in, qr code, approve phone, trusted phones, notifications, inbox, app lock, passcode, biometrics, face id, fingerprint, manage, scopes, forget phone
---

The Runova app for Android and iOS is a remote for your computers. The work still happens on the computer: the phone shows what is going on there and sends what you ask for, over the same encrypted link as [Runova Anywhere](remote-anywhere.md). The apps are coming to Google Play and the App Store.

## Sign in

Open the app and sign in with your Runova account in the browser, or tap **Scan QR code** and scan the code a signed-in computer shows under **Account**, **Devices** (the website shows one under **Devices and sessions** too). The computer then shows four digits. Check that your phone shows the same four, and click **Approve**.

## Approve the phone on a computer

The **Systems** tab lists your computers with whether they are online. The first time the phone connects to one, that computer shows a window, **(phone) wants to manage this computer**, with a code to check against the phone. Pick what the phone may do, then click **Approve phone**. From then on the phone connects without asking.

What a phone may do is set per computer:

- **Terminals and CLIs**: see them and send them commands.
- **Git**: see changes, commit and push.
- **The Vault**: open saved secrets after unlocking it. Off for a new phone.
- **Deploy and servers**, **Cloudflare**, **Monitoring and pipelines** and **Studio**.
- **Control the screen**: see the screen and use the mouse.
- **Files**: send and receive files.

Change these later, or click **Forget** to remove the phone, in **Remote**, **Anywhere**, **Access settings**, under **Phones**. Changing what a phone may do ends its session, so it reconnects with the new limits.

## What you can do from the phone

- **Agents and terminals**: see the CLIs running on the computer, read them live, answer them and see their processes. Pick the CLI, model and effort for a new agent, and send a prompt from the Prompt Builder.
- **Git**: changes and diffs, stage, commit, branches, sync, tags, pull requests and the AI help from the computer.
- **Status**: the limits for Claude, Codex and Cursor, CPU and RAM, project runs and Relay plans.
- **Deploy**: servers and what runs on them, [traffic and attacks](deploy-traffic.md#on-your-phone), and Cloudflare through the tokens saved on the computer. The phone never holds a Cloudflare token.
- **Monitoring and pipelines**: monitors and their history (cloud monitors even while the computer is off), and CI runs, including a fix with an agent.
- **Studio**: start a video from a sentence, follow the work, ask for changes and bring the finished film to the phone.
- **Remote**: see and control a computer's screen.
- **Files**: send files, photos and folders to your computers and your teammates', and receive files from your own computers. See [Send files](remote-send-files.md#send-from-your-phone).
- **Vault**: open the computer's Vault with its passphrase. Each value you reveal needs your fingerprint or face, and Vault screens can not be captured in a screenshot.

## Notifications

Every kind of Runova notification reaches the phone, in the app's **Inbox** and in the background. Turn each category on or off in the app. On paid plans you can [encrypt notifications end to end](account-sync.md#encryption), so the server forwards them without being able to read them.

## Lock the app

In the app's settings, set a 4 digit code, a 6 digit code or a password that locks the whole app. Open it with Face ID, Touch ID or a fingerprint instead if you like, and pick how long the app may stay in the background before it locks again. The app also keeps recovery phrases you scan from a computer behind this lock (see [Account, sync and teams](account-sync.md#encryption)).
