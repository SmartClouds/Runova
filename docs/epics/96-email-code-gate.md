# E96 Email code gate

Milestone: standalone (Deploy, security). Builds on E14 (Cloudflare), E44 (core domain), E95
(Cloudflare Tunnel, Access for SSH).

## Goal

Cloudflare Access in front of any name the user picks, the way Cloudflare's dashboard does it with
the One-time PIN login: someone opens the name, types their email address, Cloudflare mails a
code, and only the people listed get in. Each name has its own switch, its own list of people
(addresses and whole email domains) and its own session length. It works on the core server's
domain too, without locking the app out of its own core.

## Tasks

- [x] T1 Shared rules (`shared/cloudflare/emailGate.ts`): parsing typed and pasted people
  (addresses, `@domain`, `Name <address>`), validation, session lengths, the row summary and the
  dialog's sentence, the names of the applications the app makes.
- [x] T2 Optional permission `accessLogin` (Access: Organizations, Identity Providers, and Groups);
  `access` now also covers the gate.
- [x] T3 The recorded fake: Zero Trust organizations, identity providers, application and policy
  reads and updates.
- [x] T4 `CloudflareEmailGateOps`: plan, find, prepare, save, remove, let this computer through,
  proxy.
- [x] T5 This computer's pass through a gate on a core domain: sealed in `cloudflare.json`, sent by
  the core domain transport, moved on a passkey change.
- [x] T6 The core domain check names a gate that stopped this computer (`access-gate`).
- [x] T7 IPC and preload (`cloudflareEmailGate.*`).
- [x] T8 The zone's Access tab, the dialog and the people field.
- [x] T9 Shortcuts on the core domain card and a saved site's Domains tab.
- [x] T10 Help and this file.
- [x] T11 e2e: email codes turned on, a gate on, changed, a name proxied, the gate off.

## Acceptance criteria

1. A switch per name of the zone puts the gate on and takes it off; the people and the session
   are saved at Cloudflare and read back from it.
2. A name without Cloudflare's proxy cannot get a gate until the proxy is on, and the tab offers to
   turn it on.
3. An Access application the app did not make is shown and never changed or removed.
4. Every gated name keeps `/.well-known/acme-challenge` open, so HTTP-01 renewals still work.
5. With the gate on the core domain the app still reaches its core from this computer, and another
   computer can get its own pass. The pass secret never reaches the renderer, a log or a mapped
   response.

## Implementation notes

- `main/deploy/cloudflare/emailGate.ts` reads everything from Cloudflare on each plan: the zone's
  A, AAAA and CNAME records (no wildcards), the account's Access applications, and what each name
  is to a server. The core domain each server is reached at is known locally (`deploy.json`), so
  it gets its pass even when the server is offline; sites and SSH's name come from the cores of
  servers whose link is already online (`getCoreDomain`, `listSites`, `getCloudflareTunnel`, each
  with a short timeout), so opening the tab never logs in to a server.
- A gate is two `self_hosted` applications named `Runova, <name>`: the gate with
  `allowed_idps: [one-time PIN]`, `auto_redirect_to_identity`, the chosen `session_duration` and
  an `allow` policy of `email` and `email_domain` includes; and `Runova, <name>, certificate
  checks` on `<name>/.well-known/acme-challenge` with a `bypass` policy for everyone. A failed
  policy create removes the gate it was for, so no gate ever lets nobody in.
- `prepare` creates the Zero Trust organization (`<team>.cloudflareaccess.com`) only when the
  account has none, then the `onetimepin` identity provider.
- On a name that is a server's core domain, `save` also makes a service token for this computer
  with a `non_identity` policy, and keeps it in `cloudflare.json` (`passes`, keyed by name, the
  secret sealed with the Servers vault and moved on a passkey change). `cloudflareCoreDomainTransport`
  adds `CF-Access-Client-Id` and `CF-Access-Client-Secret` to the request head before the device
  proof. Turning the gate off deletes every service token its policies name.
- The core domain probe reads a redirect to `*.cloudflareaccess.com`, or a 403 with Access's own
  headers, as `access-gate` and says how to let this computer through.
- UI: `components/cloudflare/access/`. The Access tab sits between Security and Servers. A new
  gate starts from the last list used here (local storage, per viewer).

What is left or unverified:

- Nothing here has met the real Cloudflare API or edge: the desktop runs against the recorded fake
  extended with organization, identity provider, application and policy routes. The payloads
  follow Cloudflare's API reference and SDK types.
- Whether a brand-new account can create its Zero Trust organization over the API without first
  choosing the free plan on the dashboard is unknown; a refusal is shown as Cloudflare words it.
- A computer's pass is a service token valid for a year (`8760h`). When it runs out the core domain
  check says the gate stopped this computer, and Let this computer through makes a new one.
- No server core change: Access runs at Cloudflare's edge.
