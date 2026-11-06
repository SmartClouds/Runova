# E54 Monitoring nodes, gateway and the gRPC link

Milestone: standalone (Website). Depends on: E41 (the website API), E22 (the Runova Health
Protocol the nodes speak).

## Goal

Online monitors (E55) are checked by **monitoring nodes**: small .NET 10 services run as Docker
containers in several regions. An Admin adds a node on `/admin/monitoring-nodes`, gets a one-time
token and a ready compose file, starts it, and watches it come online. The server spreads the
checks across the nodes and moves them when a node goes away.

The rule that shapes everything: nothing inside the website is reachable from the internet. Nodes
only open an outbound gRPC connection with mutual TLS to one service, the **Monitoring Gateway**.
RabbitMQ, Postgres and the API's internal endpoints have no published ports.

## Design

- **Shape.**

  ```
  API (EF Core, Hangfire, Wolverine, Node CA)
     ▲ │ Wolverine over AMQP, internal network only
  RabbitMQ (no published port)
     ▲ │
  Gateway (gRPC, Kestrel mTLS, no database)
     ▲   nodes.runovahq.com:443, TLS 1.3, HTTP/2, client certificates
  Nodes (worker, SQLite outbox)
  ```

- **The nodes own the timing.** The API sends a node its monitors (with a version) as a snapshot
  and then as changes. The node runs each check on its own timer wheel and sends results back in
  batches (200 results or 2 seconds). Hangfire can not run thousands of 30 second schedules
  cleanly, so the node uses a `BackgroundService`; Hangfire stays the job system of the API.
- **gRPC** (`node.proto`). `Connect` is one bidirectional stream per node. The node sends
  `Hello`, `Heartbeat` (every 10 seconds), `ResultBatch` and `ConfirmResult`; the gateway sends
  `AssignmentSnapshot`, `AssignmentDelta`, `ConfirmCheck`, `Drain` and `BatchAck`.
  `RenewCertificate` gives a node a fresh certificate.
- **At least once.** A batch stays in the node's SQLite outbox until `BatchAck`. The gateway asks
  the API with the batch (a Wolverine request) and acks only once the API answers `BatchStored`.
  Every result has a UUIDv7 id, so the API stores it once.
- **Identity is the certificate.** The API keeps a private ECDSA P-256 Node CA, sealed with Data
  Protection. Enrolling: the Admin makes a one-time token (24 hours, kept hashed); the node makes
  its own key, sends a CSR and the token to `POST /monitoring-node-enrollments` over HTTPS, and gets
  a 7 day certificate with `urn:runova:node:{id}` as its URI, the CA bundle and the gateway
  address. The key never leaves the node. It renews every day. The gateway takes the node id from
  the verified certificate, never from a message, and stamps it on what it forwards.
- **Revoke.** The API marks the node revoked and its certificate serials denied and tells every
  gateway, which closes the stream at once. Gateways ask the API for the trust list (the CA and what
  is revoked) when they start and every 5 minutes, and refuse every node until they have it.
- **Distribution.** A monitor weighs 1 / interval. A new one goes to the online node with the
  least weight per capacity. A node joining or leaving moves monitors only when the spread is over
  20 percent. A node silent for 45 seconds is offline and its monitors move.
- **Checks.** The node only checks public addresses: it resolves the host once, refuses loopback,
  private, link-local, CGNAT, multicast and metadata addresses (IPv4 and IPv6), and connects to
  that address. No redirects, 512 KB at most, HTTPS unless the monitor allows plain HTTP.

## Tasks

- [x] T1 `Runova.Monitoring.Core`: the health protocol parser, the two-sample transitions and
  the interval rules ported from `@runova/core`, with shared JSON fixtures both test suites read.
- [x] T2 The safe address check and HTTP handler (`PublicAddressGuard`, `SafeHttpHandler`).
- [x] T3 `Runova.Monitoring.Contracts`: `node.proto` and the gateway and API message records.
- [x] T4 API: Node CA, `MonitoringNodes` and `NodeCertificates` tables, enrollment and renewal.
- [x] T5 API: admin `/monitoring-nodes` (list, create, rename, drain, revoke, enrollment tokens),
  audited; the internal deny list endpoint.
- [x] T6 API: Wolverine with the Postgres outbox and the internal RabbitMQ; handlers for
  `NodeConnected`, `NodeHeartbeat` and `NodeDisconnected`; `NodeLivenessJob`.
- [x] T7 Gateway: mTLS, the deny list, one stream per node, forwarding with publisher confirms.
- [x] T8 Node: enrollment, the gateway connection, the scheduler, the prober, the batcher and the
  SQLite outbox.
- [x] T9 Docker: gateway and node Dockerfiles, RabbitMQ and the gateway in the website compose
  files without published ports, `apps/website/monitoring-node/compose.yaml`, CD images.
- [x] T10 Contract: `docs/website/api-contract.md` and the OpenAPI snapshot.
- [x] T11 Web: `/admin/monitoring-nodes` with live status, the create dialog with the token and
  compose file, drain and revoke.
- [ ] T12 Run a real node on another server against runovahq.com.

## Acceptance criteria

- AC1 The gateway refuses a connection without a client certificate, with one from another CA,
  with an expired or revoked one.
- AC2 Revoking a node closes its stream within a second and it can not connect again.
- AC3 An enrollment token works once and not after 24 hours.
- AC4 A node never checks a private, loopback or metadata address, even when DNS changes between
  the check and the connection.
- AC5 Results made while the gateway is away arrive once it is back, each stored once.
- AC6 A node silent for 45 seconds is shown offline and its monitors move to the others.
- AC7 No compose file publishes a RabbitMQ or Postgres port.

## Setting it up

- DNS: `nodes.runovahq.com` to the website server.
- nginx on that server passes it through by SNI, so the gateway itself sees client certificates:

  ```
  stream {
    map $ssl_preread_server_name $runova_upstream {
      nodes.runovahq.com runova_gateway;
      default            local_https;
    }
    upstream runova_gateway { server 127.0.0.1:8043; }
    upstream local_https    { server 127.0.0.1:8443; }
    server { listen 443; ssl_preread on; proxy_pass $runova_upstream; }
  }
  ```

  Without a `stream` block, publish the gateway on port 7443 instead and open only that port.
- The gateway needs a normal certificate for `nodes.runovahq.com` (Let's Encrypt). The gateway runs
  as uid 1654, so a certbot deploy hook copies `fullchain.pem` and `privkey.pem` to
  `MONITORING_TLS_DIR` (default `/etc/runova/monitoring-tls`) readable by that user.
- In the app's environment: `COMPOSE_PROFILES=monitoring`, a long random `RABBITMQ_PASSWORD`,
  `RABBITMQ_URI=amqp://runova:<the same password>@rabbitmq:5672` and
  `MONITORING_GATEWAY_ADDRESS=https://nodes.runovahq.com`. Without the profile the stack runs as
  before, and enrollment answers 503.
- A node: on `/admin/monitoring-nodes` press **Add node**, copy the compose file and the `.env`,
  run `docker compose up -d` on the node's server.

## Implementation notes

- **Acks come from the API, not the broker.** The plan had the gateway ack a batch after RabbitMQ's
  publisher confirm. A test with the broker stopped showed a Wolverine publish returns as if sent:
  it keeps the message in memory and retries, so a gateway restart would lose an acked batch. The
  gateway now asks the API with the batch (`InvokeAsync<BatchStored>`, 10 second wait) and acks only
  on its answer; `NodeConnected` is asked the same way, so a refused node is closed at once. A
  request that times out also expires in RabbitMQ, so it never lands late.
- **No internal HTTP endpoint for the deny list.** The gateway asks for `NodeTrust` over the same
  internal queue, so the API has no extra surface for it. Revocations are also pushed at once on the
  fanout exchange.
- **The gateway's own certificate** is a normal one (Let's Encrypt) checked against the system roots
  and the host name. A node can trust one more CA (`NODE_GATEWAY_CA_PATH`) for a self-signed gateway;
  the tests use that.
- **RabbitMQ 4** has no transient shared queues. Each gateway's queue is durable, expires 10 minutes
  after its gateway goes (`x-expires`), and drops a message for a node after a minute
  (`x-message-ttl`). The gateway declares the API's queue too: RabbitMQ confirms a message it can not
  route, so a batch sent before the API ever started would otherwise vanish.
- **Wolverine 6** no longer ships the runtime compiler: `WolverineFx.RuntimeCompilation` compiles
  the handlers at start. The API's handlers take scoped services registered with factories, so the
  API sets `ServiceLocationPolicy.AlwaysAllowed`. A gateway that asks before Wolverine has started
  is left with a route it keeps, so the trust loader waits for the host to start.
- **gRPC 2.80.** The 2.85 packages would not download here (the connection kept breaking), so all
  gRPC packages are pinned to 2.80.0, the newest the cache had.
- **Without RabbitMQ** (`RabbitMq__Uri` empty) the API runs without Wolverine: the admin pages and
  enrollment work and no gateway is told anything. The existing 830 API tests run that way; the
  messaging tests start a RabbitMQ container.
- **Monitors come with E55.** `IAssignmentSource`, `IResultIngestor` and `INodeRebalancer` do nothing
  yet: every node gets an empty snapshot and results are dropped. The distribution rule
  (`MonitorDistribution`: weight 1 / interval, 20 percent tolerance, lightest moves first, confirms
  go to another region) is built and tested here for E55 to use.
- **The health core port** (T1) found two problems the TypeScript has too: a body like `a=a=a=...`
  made redaction recurse once per pair (a stack overflow that would kill a node), and one like
  `a.a.a.` took seconds of regex time. The C# masks values nested past 32 levels whole and cuts text
  long past its limit before redacting. Both parsers run the same JSON fixtures
  (`packages/core/src/health/fixtures`).
- **Draining** is a flag next to the status, so a draining node stays online or offline as it is.

## Known limits

- T12 is open: no node ran on another server against runovahq.com yet, and the stack has not run
  with the monitoring profile end to end in Docker (the images build; the link ran in process).
- RabbitMQ has one user (`runova`, no guest) shared by the API and the gateway, not one each with
  narrower rights: RabbitMQ's definitions file takes password hashes only, so that waits for a
  small setup step.
- AC6 is met for "shown offline" and the liveness job; "its monitors move" is the distribution rule
  and its tests until E55 brings monitors to move.
- Wolverine compiles its handlers at start (a few seconds and some memory); pre-generated code
  (`TypeLoadMode.Static`) would avoid it.
