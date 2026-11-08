# E65 Runova Anywhere: the background agent on macOS and Linux

Milestone: standalone (Remote). Depends on: E64.

## Goal

Macs and Linux computers stay reachable while no one is signed in, as Windows ones do since E64.

## Design

The agent's protocol, session, policy, relay transport and hub client are portable already
(`Runova.RemoteAgent.Core` and `AgentService`); `RunovaAgent run` stops with a clear message on these
systems today. What is missing is per OS:

- **macOS**: a LaunchDaemon for the service and a LaunchAgent with `LimitLoadToSessionType`
  `LoginWindow` so a helper runs at the login window; capture through ScreenCaptureKit and input
  through CGEvent from a small Swift shim; the config in the System keychain; installing through
  `SMAppService` with the person's approval in System Settings.
- **Linux**: a systemd service that attaches to the greeter's X11 display (GDM, LightDM) with its
  Xauthority, capturing with XShm and typing with XTest; the config in a root-only file (the
  `AgentConfigStore` path already). Wayland greeters do not let another program capture or type, so
  they stay out.

## Tasks

- [ ] T1 macOS: launchd plists, the login-window helper, ScreenCaptureKit and CGEvent shim, keychain
- [ ] T2 Linux: systemd unit, greeter display discovery, XShm capture, XTest input
- [ ] T3 The app's installer for both, and their CI runners

## Not in this epic

Wayland greeters.
