# E102 Cloudflare-only origin on the phone

Milestone: standalone (Mobile). Depends on: E98.

## Goal

Each saved server's Cloudflare-only origin on the phone, as the desktop's Firewall section has it:
the Cloudflare Tunnel (no open web ports at all) or the IP lock (ports 80 and 443 answer
Cloudflare's addresses only), set up, changed and turned off from the phone, with every firewall
change previewed first and kept or reverted afterwards.

## Design

- Bridge methods under the `cloudflare` scope: `origin` (the lock, the tunnel, and a firewall change
  waiting to be kept), `originLockPreview` and `originLockApply` (danger), `tunnelPlan`,
  `tunnelSetUp`, `tunnelRoute`, `tunnelClosePorts` (danger), `tunnelPreviewSsh`, `tunnelProbeSsh`,
  `tunnelApplySsh` (danger, audited), `tunnelPreviewOff`, `tunnelTurnOff` (danger), `tunnelCleanUp`,
  `tunnelJoinMesh`, `tunnelBreakGlass` (danger), `firewallKeep` and `firewallRevert` (danger). They
  reuse the desktop's own services and input checks, so the phone never builds a firewall rule.
- The Cloudflare home lists the saved servers. A server opens on the way Cloudflare reaches it:
  the tunnel, or the IP lock. While the tunnel is on, the choice is locked with a note on how to
  switch.
- Every change shows its firewall commands before it is made. A change that waits to be kept shows
  on top with its deadline, a Keep button and a Revert button that asks first.
- Setting up the tunnel runs the desktop's four steps one after another, each with its state: make
  the tunnel and install cloudflared, wait up to three minutes for its first connection, point the
  names at it, close ports 80 and 443. A failed step says why and the button turns into Try again,
  which picks up from that step. Names outside the chosen account are listed in amber and need an
  explicit "go ahead without them". A core domain that points straight at the server blocks setup
  with the fix to make first.
- Changing SSH access lists the four choices with what each risks, greys out the ones not
  possible (no SSH name yet, or not an Owner), and tests the tunnel or Mesh route from the
  computer before the change can be made, since the computer is whose way in it keeps. Closing SSH
  to everyone needs the typed phrase and the password on the server core. The password is held in
  zeroized memory and only sent with the change.
- Turning the tunnel off chooses whether ports 80 and 443 open again or stay closed for the IP
  lock, and whether the names point back at the server. Once the server reports the tunnel off,
  the phone asks the computer to clean it up at Cloudflare.
- Break-glass (reopen SSH if the tunnel stays down) is a switch with its delay, for Owners.

## Tasks

- [x] T1 Bridge methods, with tests.
- [x] T2 Rust: the origin view, the dialogs, the setup steps, the SSH test and the clean-up.
- [x] T3 Android screens and snapshots.
- [x] T4 iOS, written to match.

## Acceptance criteria

- AC1 A server shows how Cloudflare reaches it, and a waiting firewall change is kept or reverted
  (after asking) from the phone.
- AC2 The IP lock goes on and off after a preview of its commands and of which names stay proxied.
- AC3 The tunnel is set up step by step, and a failed step says where it stopped.
- AC4 SSH through the tunnel or Mesh can only be chosen after the computer reaches it that way;
  closing SSH takes the phrase and the password.
- AC5 Turning the tunnel off cleans it up at Cloudflare once it is off.

## Status

Desktop bridge, Rust core and Android are tested. iOS is written to match but not compiled yet
(needs the Mobile iOS CI job). The real Cloudflare API and a real server's firewall are not
exercised here; the bridge reuses the desktop services, which have their own tests.
