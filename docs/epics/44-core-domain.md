# E44 Core domain

Milestone: standalone (Deploy). Depends on: E10 (nginx websites), E11 (certificates), E16 (direct
TLS: the device certificate and the fallback order).

## Goal

Reach a server's core over HTTPS on a domain of its own, through the nginx Runova already manages,
so the app keeps working when SSH is closed in the firewall. Before this, the link (SignalR and
REST) always rode inside SSH, or on direct TLS's own port; closing SSH with no direct TLS cut the
app off from the server.

## Tasks

- [x] T1 Core: a loopback-only HTTP endpoint for nginx, opened and closed at runtime like direct
  TLS, and a guard that takes a request only with nginx's key and the certificate of an enrolled,
  unrevoked device.
- [x] T2 nginx: the core domain as a reserved site (`runova-core`) with the usual certificate and
  renewals; HTTPS only, the device certificate asked for and passed on, the file root-only.
- [x] T3 Core: turning it on needs nginx installed and running, an Owner and a step-up; refused
  while the Cloudflare origin lock is on or another site holds the domain. Hub methods and audit.
- [x] T4 Desktop: a transport through the domain, tried before direct TLS and SSH, and a check
  from this computer that names the usual mistakes (Cloudflare's proxy above all).
- [x] T5 Desktop: a Core domain card on the Security area's Connection tab, help.

## Acceptance criteria

1. Nothing listens for nginx until the mode is on, and nothing after it is turned off.
2. A request on the core's port for nginx without the key, without a device certificate, or with
   one for an unknown or revoked device is refused; the core treats an accepted one like direct TLS
   (bound to that device, no enrolling).
3. Plain HTTP on the domain never reaches the core.
4. The app connects through the domain first when it is ready and passed a check from this
   computer, then direct TLS, then SSH.

## Implementation notes

- **Where it lives.** Server core: `CoreDomain/` (settings and their store, the endpoint and its
  guard, the manager and its start-up), `Hubs/CoreHub.CoreDomain.cs`,
  `Contracts/CoreDomainContracts.cs`, the core site in `Nginx/NginxRenderer.cs` and
  `Nginx/NginxValidator.cs`, and the reserved site in `Web/WebSites.cs`. Desktop main process:
  `main/deploy/coreDomain/` (transport, probe, service), the route order in `main/deploy/service.ts`,
  the route in `state.ts`, `main/ipc/deployCoreDomain.ts`. Shared:
  `shared/deployCoreDomainTypes.ts`, `shared/deploy/coreDomainValidation.ts`. Renderer:
  `components/deploy/security/coreDomain/`.
- **Why nginx stands in front.** A domain on 443 next to the server's websites needs nginx anyway,
  and it brings a certificate from a public CA with renewals (E11). So the core does not get a public
  port of its own: nginx ends TLS and passes requests to a port the core opens on 127.0.0.1 only.
- **Keeping the device check.** Over SSH and direct TLS every connection proves this computer's
  device key. Behind nginx it still does: the site sets `ssl_verify_client optional_no_ca`, so nginx
  asks for the client certificate and the handshake proves the caller holds its key, without asking
  a CA to vouch for it (the desktop signs its own, as for direct TLS). nginx cannot check the key
  against the devices, so it sends the certificate on in a header (`$ssl_client_escaped_cert`) and
  the core checks it on every request, the same lookup direct TLS uses. A request is then treated
  exactly like one over direct TLS (`DirectTlsDevices.IsDirect` covers both): tokens and challenges
  are bound to that device and enrolling is refused.
- **Why a key.** Any local process could reach a loopback port and write the certificate header
  itself. nginx also sends a 256-bit key the core made, which lives only in `core-domain.json` (0600)
  and in the site file, written 0600 (nginx's master reads it as root; release files gained a
  `Private` flag for this). A Unix socket with group permissions was the other option; it was left
  out because nginx connecting to a socket of a process outside its SELinux domain needs a policy
  module, and loopback works with the `httpd_can_network_connect` boolean Runova already sets.
- **DNS only.** Cloudflare's proxy ends TLS at its edge and never passes the device certificate on,
  so the domain has to point straight at the server. The core refuses the mode while the origin lock
  is on (it would keep everyone but Cloudflare off 80 and 443). The desktop's check reads the answer's
  headers: a `cf-ray` or `server: cloudflare` names the proxy, a 403 without them names a refused
  certificate. This computer only uses the domain after a check passes.
- **The reserved site.** It is a normal row in the sites table, so certificates (issue, upload,
  renew, remove) work through the usual calls with site id `runova-core`. The Websites calls refuse to
  save, delete or add snippets to it, and leave it out of the list. Its upstream kind (`RunovaCore`)
  is refused for any other site. The validator allows it no snippets, basic auth, cache, rate limit or
  extra headers (anything that could rewrite a header or answer for the core); IP rules (the sources)
  and timeouts are all it takes. A new domain drops the old certificate.
- **Plain HTTP.** Port 80 answers ACME challenges, and otherwise 404 before a certificate exists and
  a redirect to HTTPS after; it never proxies. Over HTTPS nginx refuses a request without a client
  certificate itself, the core refuses an unknown one.
- **The port.** The OS picks a free loopback port the first time, kept while the mode is on. The
  Host nginx sends the core is `runova-core`, so the core's host filter is unchanged.
- **Fallback order.** `DeployService.offSshRoutes` lists the ways in without SSH: the core domain
  when this computer has it on, then direct TLS. The link, health and short calls try them in order;
  each that fails is left alone for a minute on its own, and a direct TLS pin mismatch still stops the
  link. `withSshHub` treats both as off SSH. The domain's certificate is checked against the public
  CAs (not pinned: Let's Encrypt renews with new keys), with the domain as SNI and Host.
- **Evidence.** Server core: `HubCoreDomainTests` (8: roles and step-up, nginx missing, the site
  over HTTP and HTTPS with a certificate and its file mode, the Websites calls refused, a domain
  another site holds, the origin lock, turning it off), `CoreDomainListenerTests` (6, a real Kestrel:
  closed until on, an enrolled device gets through, no key, a wrong key, no or an unknown certificate,
  a revoked device and a mode turned off refused at once, the device binding and enrolling, the
  headers ignored on the core's own listener), `NginxCoreSiteTests` (6). Desktop: transport against a
  loopback TLS server, the probe's verdicts, the service's route decisions, the fallback order in
  `service.coreDomain.test.ts` (10), IPC, state, validation and the card.

## Known limits

- Not yet tried against a real server with nginx and a real certificate; the nginx side is checked
  by the simulated machine and the renderer tests, not by `nginx -t` in a system test.
- The firewall rule for 80 and 443 is not offered from the card; the Websites flow and the Firewall
  section open those ports.
- A server backup restored on another machine brings the reserved site with it; turn the core domain
  off and on there to make a new key.
