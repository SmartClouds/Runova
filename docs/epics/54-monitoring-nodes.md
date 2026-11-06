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
- **At least once.** A batch stays in the node's SQLite outbox until `BatchAck`. The gateway acks
  only after RabbitMQ confirmed the message. Every result has a UUIDv7 id, so the API stores it
  once.
- **Identity is the certificate.** The API keeps a private ECDSA P-256 Node CA, sealed with Data
  Protection. Enrolling: the Admin makes a one-time token (24 hours, kept hashed); the node makes
  its own key, sends a CSR and the token to `POST /monitoring-node-enrollments` over HTTPS, and gets
  a 7 day certificate with `urn:runova:node:{id}` as its URI, the CA bundle and the gateway
  address. The key never leaves the node. It renews every day. The gateway takes the node id from
  the verified certificate, never from a message, and stamps it on what it forwards.
- **Revoke.** The API marks the node revoked and its certificate serials denied and tells every
  gateway, which closes the stream at once. Gateways load the deny list from an internal endpoint
  when they start.
- **Distribution.** A monitor weighs 1 / interval. A new one goes to the online node with the
  least weight per capacity. A node joining or leaving moves monitors only when the spread is over
  20 percent. A node silent for 45 seconds is offline and its monitors move.
- **Checks.** The node only checks public addresses: it resolves the host once, refuses loopback,
  private, link-local, CGNAT, multicast and metadata addresses (IPv4 and IPv6), and connects to
  that address. No redirects, 512 KB at most, HTTPS unless the monitor allows plain HTTP.

## Tasks

- [ ] T1 `Runova.Monitoring.Core`: the health protocol parser, the two-sample transitions and
  the interval rules ported from `@runova/core`, with shared JSON fixtures both test suites read.
- [ ] T2 The safe address check and HTTP handler (`PublicAddressGuard`, `SafeHttpHandler`).
- [ ] T3 `Runova.Monitoring.Contracts`: `node.proto` and the gateway and API message records.
- [ ] T4 API: Node CA, `MonitoringNodes` and `NodeCertificates` tables, enrollment and renewal.
- [ ] T5 API: admin `/monitoring-nodes` (list, create, rename, drain, revoke, enrollment tokens),
  audited; the internal deny list endpoint.
- [ ] T6 API: Wolverine with the Postgres outbox and the internal RabbitMQ; handlers for
  `NodeConnected`, `NodeHeartbeat` and `NodeDisconnected`; `NodeLivenessJob`.
- [ ] T7 Gateway: mTLS, the deny list, one stream per node, forwarding with publisher confirms.
- [ ] T8 Node: enrollment, the gateway connection, the scheduler, the prober, the batcher and the
  SQLite outbox.
- [ ] T9 Docker: gateway and node Dockerfiles, RabbitMQ and the gateway in the website compose
  files without published ports, `apps/website/monitoring-node/compose.yaml`, CD images.
- [ ] T10 Contract: `docs/website/api-contract.md` and the OpenAPI snapshot.
- [ ] T11 Web: `/admin/monitoring-nodes` with live status, the create dialog with the token and
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
- The gateway needs a normal certificate for `nodes.runovahq.com` (Let's Encrypt), mounted at
  `Gateway__ServerCertificatePath`.
- A node: on `/admin/monitoring-nodes` press **Add node**, copy the compose file and the `.env`,
  run `docker compose up -d` on the node's server.
