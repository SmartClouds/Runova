# E68 Server support for phones

Milestone: standalone (Mobile, Website). Depends on: E60, E61, E67.

## Goal

A phone can sign in, get a cryptographic identity the hosts accept, and ask to manage a computer,
without appearing as a computer anyone can connect to.

## Design

- **Sign-in**: a `runova-mobile` client id with an app-link redirect in `DeviceTokenEndpoints.cs`
  and `AuthorizeDevice.tsx`. Session kind `mobile`. The desktop's loopback rules stay as they are.
- **Identity**: platforms `android|ios` and a controller-only device kind. It holds an Ed25519 key,
  has no Runova ID in use, and is left out of `/reachable-devices` and of connection targets.
- **Intent**: `manage` joins `RemoteIntents.All`.
- **Website copy**: phones show as "Runova app" with a generic device name. The forbidden-phrases
  list and its test do not change.

## Tasks

- [x] T1 Client id, redirect validation and session kind, with tests for refused redirects
- [x] T2 Platforms and controller device kind; directory and target exclusion
- [x] T3 `manage` intent through `RequestConnect`
- [x] T4 Generic labels on the authorize page and session list
- [x] T5 Mapperly mappers with a unit test each, no secrets in DTOs, contract and OpenAPI snapshot

## Acceptance criteria

- AC1 A PKCE sign-in with the mobile client id and its redirect returns tokens; any other redirect
  is refused.
- AC2 A controller device never appears in the directory and can not be a connection target.
- AC3 A controller's identity key reaches the host with a `manage` request.
- AC4 Revoking a phone's session closes its hub connection.
- AC5 The website's text scan still passes.

## Not in this epic

Host-side trust (E71) and push tokens (E82).
