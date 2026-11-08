# E77 Vault

Milestone: standalone (Mobile). Depends on: E73.

## Goal

Reach the computer's Vault from the phone without weakening it.

## Design

Under the `vault` scope, off by default for a new phone. Unlocking needs the Vault passphrase, sent
only over the encrypted link. Each reveal needs biometrics on the phone, is audited on the computer,
and the value is zeroized when the screen closes. Vault screens block screenshots and hide in the
app switcher.

## Tasks

- [ ] T1 Bridge methods with risk levels
- [ ] T2 `store` with zeroized secrets
- [ ] T3 Screens: status, unlock, list, reveal, edit
- [ ] T4 Screenshot blocking on both OS

## Acceptance criteria

- AC1 Without the `vault` scope, nothing about the Vault is reachable.
- AC2 Reveal without biometrics is impossible, and each reveal appears in the audit log.
- AC3 Values do not reach logs, and no secret remains in the store after the screen closes.

## Not in this epic

Reading sealed sync entries with the computer off.
