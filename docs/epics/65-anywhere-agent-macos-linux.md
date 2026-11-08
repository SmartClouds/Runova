# E65 Runova Anywhere: the background agent on macOS and Linux

Milestone: standalone (Remote). Depends on: E64.

## Goal

Macs and Linux computers stay reachable while no one is signed in, as Windows ones do since E64.

## Design

The agent's protocol, session, policy, relay transport and hub client were portable already
(`Runova.RemoteAgent.Core` and `AgentService`). What each OS adds is its screen, its input and how
the agent is set up. JPEG tiles now go through SkiaSharp on all three, which also replaced GDI+ on
Windows.

- **Linux** (`Linux/`): a systemd service running as root (`/opt/runova-agent`, config in
  `/etc/runova-agent`, a folder and file only root can open). It finds the X server on the physical
  screen by reading Xorg's command line (auth file and terminal) and the active terminal, which
  works the same for GDM, LightDM and SDDM, greeter or signed-in desktop, and looks again every two
  seconds so it follows the computer between them. It captures with XShm, falling back to XGetImage,
  and types with XTest, putting each character on a spare key so any keyboard layout works. Xlib ends
  the process when its server goes away; systemd starts the agent again.
- **macOS** (`Mac/`): a LaunchAgent limited to the `LoginWindow` session, running as root
  (`/Library/LaunchAgents`, program and config in a root-only folder under
  `/Library/Application Support/Runova/Agent`). Capture is `CGDisplayCreateImage` and input is
  `CGEvent`, both through P/Invoke, so there is no Swift shim to build.
- **The app** installs through the system's own prompt: `pkexec` on Linux (with a private copy of
  the agent, since root can not read an AppImage's mount) and an administrator `do shell script` on
  macOS.
- **No screen, no session**: with nothing to capture (a Wayland greeter, or macOS refusing the
  capture) the agent turns requests down instead of showing a blank picture.

### Changes from the first design

- Core Graphics through P/Invoke instead of a Swift shim using ScreenCaptureKit. It needs no Swift
  toolchain and matches how the Windows side works. `CGDisplayCreateImage` is deprecated by Apple,
  so a macOS release could remove it; the agent then reports no screen rather than crashing.
- A root-only file instead of the System keychain, the same protection as on Linux, because
  `security` would need the secret on its command line.
- `do shell script` instead of `SMAppService`, which needs a Developer ID the project does not have.

## Tasks

- [x] T1 Linux: systemd unit, display discovery, XShm capture, XTest input
- [x] T2 macOS: LaunchAgent, login window capture and input through Core Graphics
- [x] T3 The app's installer for both, the config store's permissions, CI against Xvfb, and CD

## Acceptance criteria

- AC1 On Linux the agent reads a real X server's screen and moves its pointer, clicks and types.
- AC2 The X server chosen is the one on the active terminal, for any display manager.
- AC3 The config and its folder are readable by root alone from the moment they exist.
- AC4 Turning the agent on asks the system for permission, and declining leaves nothing behind.

## Limits

- Wayland greeters do not let another program capture or type. GDM defaults to Wayland on many
  distributions, so those computers need `WaylandEnable=false` in GDM's config for this to work.
- macOS covers the login window only, when no one is signed in. A locked session belongs to its
  user, whose processes can not read the root-only config.
- Linux hosts are x64 only, matching the app's builds.
