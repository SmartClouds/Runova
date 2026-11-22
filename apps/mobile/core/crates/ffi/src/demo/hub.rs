//! The demo's own hub. Every demo computer is online and says yes after a moment, as a person at
//! it would.

use runova_crypto::handshake::{Identity, base64url};
use runova_link::opener::RELAY_SIGNAL;
use runova_session::hub::{
    AccessMode, ConnectResult, HostInfo, HostKind, HubEvent, HubPort, Intent, RelayTicket,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

use async_trait::async_trait;

/// The demo computer's key. Fixed, so the key the phone pins stays the same from one demo to the
/// next.
pub(crate) const DEMO_HOST_SEED: [u8; 32] = *b"runova-demo-computer-key-seed-01";

/// How long the person at a demo computer takes to say yes.
const APPROVE_AFTER: Duration = Duration::from_millis(600);
const EVENTS: usize = 32;

/// A connection the demo hub rang, waiting for its link.
#[derive(Debug, Clone)]
pub(crate) struct Waiting {
    pub session_id: String,
    pub intent: Intent,
    pub kind: HostKind,
    pub name: String,
}

/// The demo's computers, by remote id, as the website's demo directory lists them. Anything else
/// the phone asks for is the workstation.
fn computer(remote_id: &str) -> (&'static str, HostKind) {
    match remote_id {
        "000000002" => ("Demo laptop", HostKind::App),
        "000000003" => ("Northwind build box", HostKind::Agent),
        _ => ("Demo workstation", HostKind::App),
    }
}

pub(crate) fn host_key() -> String {
    base64url(&Identity::from_seed(DEMO_HOST_SEED).public_key())
}

pub(crate) struct DemoHub {
    events: mpsc::Sender<HubEvent>,
    waiting: Arc<Mutex<Vec<Waiting>>>,
    next: AtomicU64,
}

impl DemoHub {
    pub(crate) fn start(waiting: Arc<Mutex<Vec<Waiting>>>) -> (Self, mpsc::Receiver<HubEvent>) {
        let (events, queue) = mpsc::channel(EVENTS);
        let hub = Self {
            events,
            waiting,
            next: AtomicU64::new(1),
        };
        (hub, queue)
    }
}

#[async_trait]
impl HubPort for DemoHub {
    async fn request_connect(
        &self,
        remote_id: &str,
        _device_id: i64,
        intent: Intent,
        _mode: AccessMode,
    ) -> Result<ConnectResult, String> {
        let session_id = format!("demo-{}", self.next.fetch_add(1, Ordering::SeqCst));
        let (name, kind) = computer(remote_id);
        self.waiting.lock().unwrap().push(Waiting {
            session_id: session_id.clone(),
            intent,
            kind,
            name: name.to_owned(),
        });
        let events = self.events.clone();
        let resolved = session_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(APPROVE_AFTER).await;
            let _ = events
                .send(HubEvent::Resolved {
                    session_id: resolved.clone(),
                    accepted: true,
                    reason: None,
                })
                .await;
            if kind == HostKind::Agent {
                // The background agent has no WebRTC, and says so straight away.
                let _ = events
                    .send(HubEvent::Signal {
                        session_id: resolved,
                        payload: RELAY_SIGNAL.to_owned(),
                    })
                    .await;
            }
        });
        Ok(ConnectResult {
            status: "ringing".to_owned(),
            session_id: Some(session_id),
            host: Some(HostInfo {
                name: name.to_owned(),
                identity_key: host_key(),
                kind,
            }),
        })
    }

    async fn signal(&self, _session_id: &str, _payload: &str) {}

    async fn relay_ticket(&self, session_id: &str) -> Result<RelayTicket, String> {
        Ok(RelayTicket {
            path: format!("/relay/remote/{session_id}"),
            ticket: "demo".to_owned(),
        })
    }

    async fn end(&self, session_id: &str) {
        self.waiting
            .lock()
            .unwrap()
            .retain(|w| w.session_id != session_id);
    }
}
