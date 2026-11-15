# E95 Cloudflare Tunnel

Milestone: standalone (Deploy, security). Builds on E13 (firewall safe apply), E14 (Cloudflare),
E44 (core domain).

## Goal

A second way for the Cloudflare-only origin card to keep visitors from going around Cloudflare.
Instead of allowing ports 80 and 443 from Cloudflare's published ranges (E14 T6), the server runs
cloudflared, which dials out to Cloudflare, so the web ports (and Direct TLS's) close to everyone
and no address list needs keeping up to date. The sites and the core domain answer through the
tunnel. The person also chooses who may still open SSH: open as the firewall has it, closed to
everyone, Cloudflare only (SSH through the tunnel behind Cloudflare Access), or Cloudflare Mesh
only. Optional break-glass reopens SSH when the tunnel stays down; it is off by default.

## Tasks

- [x] T1 `TunnelFirewallPlanner`: close the web ports, then SSH per mode; turning off opens them
  again. The lockout guard already treats a loopback client as always let in.
- [x] T2 cloudflared from pkg.cloudflare.com with the key pinned, a hardened unit of the core's
  own, the token in a root-only environment file.
- [x] T3 Entity `CloudflareTunnelSetting` and migration `CloudflareTunnel`.
- [x] T4 Contracts, Mapperly `CloudflareTunnelMapper`, TypeScript regenerated.
- [x] T5 `CloudflareTunnelService` and its hub methods.
- [x] T6 nginx: a loopback listener per site and for the core domain.
- [x] T7 Watchdog, alerts and break-glass (`FirewallManager.ApplyBreakGlassAsync`).
- [x] T8 The server as a Cloudflare Mesh node (`warp-cli connector new`).
- [x] T9 Desktop: the tunnel, its routes, Access for SSH and Mesh nodes at Cloudflare.
- [x] T10 Desktop: SSH routes through Cloudflare Access or to the Mesh address.
- [x] T11 IPC and preload (`cloudflareTunnel.*`).
- [x] T12 to T13 The card's mode choice, the tunnel panel and its dialogs.
- [x] T14 Point domain to a server creates the tunnel's CNAME while the tunnel is on.
- [x] T15 Help and this file.
- [x] T16 e2e: the DevHost behind a tunnel and back.

## Acceptance criteria

1. With the tunnel on and its change kept, nothing from outside reaches 80, 443 or Direct TLS's
   port, for IPv4 and IPv6, while cloudflared on loopback reaches nginx.
2. Closing the web ports is refused until the tunnel is connected, so the sites never go dark.
3. A change to who may open SSH is applied over the way in that remains, so the lockout guard
   checks exactly that one, and it is kept over a new connection the same way.
4. The tunnel's token and the Access service token's secret never appear in an argument list, a
   unit file, a log, the audit trail, a hub response or a mapped DTO.
5. Break-glass is off by default, is the Owner's to turn on, and only ever adds or removes its own
   rule.

## Implementation notes

Core (`apps/server-core/src/Runova.ServerCore/Cloudflare/`):

- `TunnelFirewallPlanner` is pure. `PlanWeb` removes every editable single-port allow rule on the
  web ports, the origin lock's Cloudflare rules included, and names rules it cannot change (wider
  rules, rules the core cannot edit) as the lock does. `PlanSsh` removes the public SSH rules for
  Closed and Cloudflare (sshd stays reachable over loopback, which every backend lets through) and
  for Mesh adds `allow <ssh port>/tcp from 100.96.0.0/12` (comment `cloudflare mesh`). `PlanOff`
  opens SSH and, unless the IP lock takes over, the web ports. It refuses a firewall that is off
  or lets everything in, like the lock.
- `LinuxCloudflared` installs from Cloudflare's repository (suite `any`; the RPM repository on the
  RHEL family) after checking the key against `CC94B39C77AE7342A68B89628A682D308D4E5E73`, the
  fingerprint of `cloudflare-main.gpg` as published on 2026-11-15. The unit
  `runova-cloudflared.service` runs `cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:<port>
  run` with `DynamicUser`, an empty capability set, `ProtectSystem=strict` and the rest. systemd
  reads `TUNNEL_TOKEN` from `/etc/runova-core/cloudflared.env` (0600, root) before it drops
  privileges. `cloudflared service install <token>` is never used, since it writes the token into
  ExecStart. `TunnelToken` refuses anything but Cloudflare's base64 JSON shape before it reaches
  the file, so no newline can add a variable.
- The token is sealed with Data Protection under `Runova.Cloudflare.TunnelToken.v1` and never
  returned. Setting up is a job: install, write the token and unit, start, add nginx's listener,
  wait for `/ready` on the metrics port. Nothing in the firewall changes in it, so a failure costs
  nothing.
- nginx: with the tunnel on, each site also gets a server block on `127.0.0.2:<port>` (plain HTTP;
  Cloudflare ends TLS and the tunnel is encrypted) that includes `cloudflare/tunnel-real-ip.conf`
  (`set_real_ip_from 127.0.0.0/8`, `real_ip_header CF-Connecting-IP`), takes the scheme and port
  from `X-Forwarded-Proto` through two maps, answers ACME challenges and redirects plain HTTP to
  HTTPS when the site asks. A `default_server` on the listener returns 444. The public blocks
  never trust Cloudflare's headers. The core domain gets the same listener with its key and an
  empty certificate header, and counts as ready without a certificate on the server while the
  tunnel is on. Direct mode is refused then. Golden variant `cloudflare-tunnel`.
- Firewall steps are change sets kept like any other (`ChangeKind` web, ssh or off). A confirmed
  one is settled on the next status read or tick; turning off stops cloudflared and removes the
  token and unit only once its change is kept. Closing the web ports also turns the IP lock off.
- SSH modes: Cloudflare and Mesh need the SSH hostname or the Mesh address first. Closed needs the
  caller to have come through the core domain (`CoreDomainEndpoint.IsProxied`) and an Owner. With
  no SSH connection behind it, the guard asks for its phrase and a step-up, and `ConfirmAsync`
  already takes a confirmation over a new non-SSH connection for a change applied that way.
- Watchdog (`TickAsync` every 30 seconds): once a tunnel was connected, two minutes down raises
  `cloudflareTunnelDown` (critical). With break-glass on and SSH not open, after the chosen delay
  `ApplyBreakGlassAsync` adds `allow <ssh port>/tcp` with the comment `runova tunnel break-glass`
  (on firewalld an unlimited SSH allow, since it keeps no comments and the tunnel removed every
  other), raises `tunnelBreakGlassOpened`, and removes it once the tunnel has been back for five
  minutes. It refuses while a person's change waits for its confirmation and tries again on the
  next tick.
- Mesh: `LinuxCloudflareMesh` installs `cloudflare-warp` from pkg.cloudflareclient.com (key
  `C068A2B5771775193CBE1F2F6E2DD2174FA1C3BA`), then runs `warp-cli --accept-tos connector new
  <token>` and `connect`, as Cloudflare's guide for a Linux Mesh node does, and reads the address
  on `CloudflareWARP`, which must lie in 100.96.0.0/12. Deviation from the plan: warp-cli only
  takes the node token as an argument, so it is on that one root command's argument list while it
  runs. It never reaches the job log or an error message.
- Hub: reads are Viewer; set up, close ports, SSH, off and Mesh are Admin; Closed is checked for
  Owner in the method; break-glass is Owner. Every change is audited without request bodies.

Desktop:

- `main/deploy/cloudflare/tunnel.ts` makes the tunnel with `config_src: cloudflare` (or takes the
  server's own again), hands the core only `GET .../token`, and routes with one catch-all ingress
  to `http://127.0.0.2:<port>` (plus `ssh://localhost:<port>` for SSH's name) so adding sites later
  only needs DNS. Names in the tunnel's account get one proxied CNAME to `<id>.cfargotunnel.com`
  each (`planTunnelRecords`, idempotent); others are listed as left alone. For SSH it makes an
  Access application of type ssh with a policy that admits only a new service token, and seals the
  secret with the Servers vault next to the saved server (`cloudflareTunnel` on
  `ssh-servers.json`, moved on a passkey change, never sent to the renderer). Turning off and
  keeping the change runs `cleanUp`: names back to the server's addresses (proxied), tunnel,
  Access application, service token and Mesh node deleted.
- New optional permissions `tunnel`, `access` and `mesh`, named only when Cloudflare refuses.
- SSH routes: `SshEndpoint.via` opens a WebSocket to `wss://<ssh name>/` with
  `CF-Access-Client-Id` and `CF-Access-Client-Secret` and hands it to ssh2 as `sock`, the bytes as
  binary messages, as `cloudflared access ssh` does. Mesh only changes the host to the Mesh
  address. Host key pinning is unchanged. A route is switched on only after a brand-new test
  connection over it showed a loopback (or Mesh) client in `$SSH_CONNECTION`; then the pool and
  link are reset so every connection takes it.
- Keeping a firewall change falls back to a new core-domain connection when no SSH connection gets
  in. The core refuses that for a change applied over SSH, so it never keeps one it should not.
- UI: the Cloudflare-only origin card has a **Cloudflare Tunnel / Cloudflare IPs only** choice;
  the one that is on wins, else the last one looked at (per server, local storage), the tunnel at
  first. The setup dialog shows each name's fate (a name that will stop answering needs a tick),
  blocks while nginx is not Runova's or the core domain is Direct, and runs its four steps with
  their state, resuming from a failed one.

What is left or unverified:

- Nothing here has met the real Cloudflare API or a real cloudflared: the desktop runs against
  the recorded fake extended with tunnel, Access and connector routes, and the core against a
  fake cloudflared. The API payloads (Access application type `ssh`, the `non_identity` policy
  with a `service_token` include, a catch-all-only ingress) follow Cloudflare's API reference and
  SDK types.
- SSH through Access is tested against a local WebSocket relay standing in for Cloudflare's edge
  and cloudflared, not the real edge.
- The Mesh node commands follow Cloudflare's Linux Mesh guide; no Linux server ran them here.
- The `cloudflare-tunnel` golden is checked with a real `nginx -t` by the system tests, which need
  Docker and run on CI only.
- Mobile does not show the tunnel yet.
