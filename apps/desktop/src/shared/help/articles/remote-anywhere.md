---
title: Runova Anywhere
category: Connect
order: 11
summary: Connect to any computer by its Runova ID, let teammates ask to connect to yours, or set a password for when no one is there to accept. Direct when it can be, through the Runova relay when it has to, and encrypted end to end.
keywords: anywhere, runova id, remote id, connect by id, teamviewer, anydesk, unattended access, password, teammate, team, relay, p2p, peer to peer, direct, safety code, remote control, internet, outside network
route: /remote?tab=anywhere
---

Runova Anywhere lets you control another computer over the internet, not just on your own network. Every computer signed in to Runova gets a **Runova ID**: nine digits, shown in three groups like 482 193 775. Type someone's ID on another computer and connect.

Both computers need Runova open and signed in to a Runova account. If you are signed out, the **Anywhere** tab shows a **Sign in to Runova** button, which opens the sign-in page in your browser. You can create an account on the same page.

## Where to find it

Click **Remote** in the sidebar, then the **Anywhere** tab. The top card, **This computer**, shows this computer's ID with a dot that is green while it can be reached. **Copy ID** copies it without the spaces.

## Connect to a computer

1. Type the other computer's ID in **Connect to a computer**. The digits group themselves as you type.
2. Click **Connect** for the screen, mouse and keyboard, or **Files** to only send and receive files.
3. A window shows each step: finding the computer, someone accepting (when it asks), securing the connection, and connected.

Your own computers and the computers your teammates show to your teams are listed below the field with whether they are online. Click **Connect** on one instead of typing its ID. Computers you connected to recently are listed under **Recent**; a key next to one means its password is saved.

### When it asks for a password

A computer that does not know you, such as one outside your teams, takes a connection only with its unattended-access password. Type it and click **Connect**. Tick **Save it in Runova for next time** to skip typing it again on this computer.

The password never leaves your computer. Runova checks it with the other computer directly, in a way that tells nobody in between anything about it, not even Runova's servers. What Runova saves is a key made from the password that works only for that one computer, kept in the same vault as your saved RDP and SSH passwords. If the vault is locked, Runova asks for the password instead.

After a few wrong passwords the other computer makes you wait longer before the next try, and after ten it turns password access off for 15 minutes and tells its owner.

### When the key changed

The first time you connect to a computer, Runova remembers its key. If the key is different next time, Runova stops and says so. That happens when Runova was reinstalled there, but it can also mean someone is pretending to be that computer. Check with the owner, then click **Trust the new key and connect**.

### Direct or through the relay

Runova first tries to reach the other computer directly. When a router or firewall stands in the way, it goes through the Runova relay instead. The window shows which one you got: **Direct, computer to computer** or **Through the Runova relay**. Either way the connection is encrypted end to end, so the relay passes on data it can not read.

### The safety code

When connected, the window shows a six-digit **Safety code**. The person at the other computer sees one too, in the list of who is connected. If the two match, no one is in between.

## Let others connect to this computer

Nothing can connect to a new computer until you allow it. Click **Access settings** on the **This computer** card. The chips on the card sum up what is on.

- **My other computers connect without asking**: computers signed in to your own account get in with no one accepting.
- **Teammates who can ask**: tick the teams that can see this computer. Their members can ask to connect, and someone at this computer accepts each time.
- **Unattended access**: set a password for when no one is at the computer. Anyone signed in to Runova with the ID and the password can connect without anyone accepting. Use at least 10 characters; a short phrase works well. **Remove password** turns it off.
- **A new session may**: what someone who connects may do unless you change it when you accept. Turn off **Use the mouse and keyboard** for view only. **Share the clipboard** and **Send and receive files** are separate.
- **Always connect through the Runova relay**: slower, but the other computer never learns this computer's network address.
- **Allow connections to this computer** turns all of it off at once.

### When no one is signed in to the computer

**Keep this computer reachable while no one is signed in** in **Access settings** sets up a small background service that starts with the computer. It answers instead of the app, under the same ID, and shows the sign-in screen. Your computer asks for administrator permission to set it up, and again to remove it. It stays on if you sign out of Runova, until you turn it off.

- **Windows**: it answers while no one is signed in and while the computer is locked.
- **macOS**: it answers at the login window, when no one is signed in. It can not answer on the lock screen of a signed-in account.
- **Linux**: it needs an X11 sign-in screen, such as LightDM or SDDM. GDM often uses Wayland, which does not let other programs see or control the screen; set `WaylandEnable=false` in GDM's config to use the service there.

With no one there to accept, the service lets in only what you allowed without asking: your own computers (when **My other computers connect without asking** is on), teammates you always let in, and the unattended-access password. If a password is set, Runova asks for it once more when you turn the service on, and the service gets a key of its own made from it. Changing the password sets the service up again.

The background service shows the screen as pictures rather than video, does not share the clipboard or files, and uses the Runova relay. It keeps the settings from when it was turned on: turn it off and on again after changing who can connect.

### When someone asks

A window comes up over everything else, even when Runova is minimized. It shows who is asking, their email, the computer they ask from and how you know them, for example **Teammate in Ops**. Change what they may do, then click **Accept** or **Decline**. Tick **Always let them in without asking** to skip this window for that teammate next time; you can undo it in **Access settings**. If no one answers within a minute, the request is declined.

### While someone is connected

A bar at the top of the screen stays there for as long as anyone is connected. It says who, how long, and whether it is direct or through the relay. **Pause input** stops their mouse and keyboard without ending the session; **End session** ends it. The **Anywhere** tab lists the same sessions with an **End** button each, and their safety codes.

## What Runova keeps

The website keeps which computers belong to your account and their IDs, and a list of sessions for 30 days: who connected to which computer, how and when. Never what was on the screen, typed or copied, and no network addresses. Both sides can see a session in that list and either can delete it. Your passwords and saved keys stay on your computers.

## When it does not connect

- **That computer is offline**: Runova has to be open and signed in there. It can run minimized.
- **There is no computer with that ID, or it does not take requests from you**: check the ID, or ask the owner for the password or to show the computer to your team.
- **No one answered in time** or **declined**: try again when someone is there, or use the password.
- **On Linux with Wayland**, others can see the screen but not use the mouse and keyboard yet. Sign in to an X11 session for full control.
- **On macOS**, the tab asks for the Accessibility and Screen Recording permissions before others can see and control the Mac. Click **Allow control** and **Allow screen recording**, then turn Runova on in System Settings.
