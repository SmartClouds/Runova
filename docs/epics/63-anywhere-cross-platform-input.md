# E63 Runova Anywhere: control on macOS and Linux

Milestone: standalone (Remote). Depends on: E61.

## Goal

A Mac or a Linux computer can be controlled, not only watched, like a Windows one; when a desktop
can not be driven the person is told why.

## Design

- `input/backends.ts` keeps one long-lived helper per OS, fed one command per line, with no native
  module: PowerShell with `SendInput` on Windows (as before), `osascript -l JavaScript` posting
  CGEvents on macOS, and `python3` calling XTest through ctypes on X11 (text through a spare keycode
  remapped per character, as xdotool does). The translation from a controller's event to commands is
  pure and tested for each OS: physical pixels on Windows and X11, global points on macOS, X button
  numbers and keysyms, macOS key codes.
- Wayland has no way for one app to drive the others without its remote-desktop portal, so a
  Wayland host is view only and the tab says so.
- On macOS the tab asks for the Accessibility and Screen Recording permissions (**Allow control**,
  **Allow screen recording**), showing macOS's own prompt first and System Settings after.

## Tasks

- [x] T1 Backends and their command translation, with tests
- [x] T2 `InputInjector` on the backends, with the reason when unsupported
- [x] T3 Readiness in the Anywhere state and the permission notice on the tab

## Acceptance criteria

- AC1 The same controller event becomes the right command on each OS.
- AC2 A Wayland or display-less Linux host says it can be seen but not controlled.
- AC3 A Mac without the permissions says which it needs and opens the right setting.

## Not in this epic

The xdg-desktop-portal RemoteDesktop session for Wayland, and the lock and sign-in screens (E64,
E65).
