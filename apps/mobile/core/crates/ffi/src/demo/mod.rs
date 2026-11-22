//! The demo (E119). The website hands out demo tokens, and while the account in use has one, this
//! switch puts a hub, a notification feed and links of its own in place of the live ones. They lead
//! to a computer inside the app that answers every screen with made-up data and keeps nothing.

mod answers;
mod host;
mod hub;

use crate::engine::HubConnector;
use crate::notifications::{FeedConnector, FeedEvent};
use crate::secure::{SecureStore, identity_seed};
use async_trait::async_trait;
use host::DemoHost;
use hub::{DemoHub, Waiting};
use runova_api::auth::is_demo_token;
use runova_crypto::handshake::Identity;
use runova_link::opener::Relay;
use runova_session::connect::{DirectLink, Transports};
use runova_session::hub::{HostKind, HubEvent, HubPort, RelayTicket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub use answers::answered_methods;

/// The demo computer's desktop, shown on the remote screen.
pub const DEMO_SCREEN: &[u8] = include_bytes!("screen.jpg");

/// The live hub, feed and links for real accounts, and the demo's own for the demo account.
pub struct DemoSwitch {
    live_hub: Arc<dyn HubConnector>,
    live_feed: Arc<dyn FeedConnector>,
    live_transports: Arc<dyn Transports>,
    secure: Arc<dyn SecureStore>,
    /// Set by the last hub connection: whether the account in use is the demo.
    active: AtomicBool,
    host: Arc<DemoHost>,
    /// Connections the demo hub has rung, waiting for their link.
    waiting: Arc<Mutex<Vec<Waiting>>>,
    /// Kept so the demo's feed stays open. It never has anything to say.
    feed: Mutex<Option<mpsc::Sender<FeedEvent>>>,
}

impl DemoSwitch {
    pub fn new(
        live_hub: Arc<dyn HubConnector>,
        live_feed: Arc<dyn FeedConnector>,
        live_transports: Arc<dyn Transports>,
        secure: Arc<dyn SecureStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            live_hub,
            live_feed,
            live_transports,
            secure,
            active: AtomicBool::new(false),
            host: Arc::new(DemoHost::new()),
            waiting: Arc::default(),
            feed: Mutex::new(None),
        })
    }

    fn in_demo(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// The phone's own key, which the demo computer holds the handshake to.
    fn phone_key(&self) -> [u8; 32] {
        Identity::from_seed(identity_seed(self.secure.as_ref())).public_key()
    }
}

#[async_trait]
impl HubConnector for DemoSwitch {
    async fn connect(
        &self,
        token: String,
    ) -> Result<(Arc<dyn HubPort>, mpsc::Receiver<HubEvent>), String> {
        let demo = is_demo_token(&token);
        self.active.store(demo, Ordering::SeqCst);
        if !demo {
            self.waiting.lock().unwrap().clear();
            return self.live_hub.connect(token).await;
        }
        let (hub, events) = DemoHub::start(self.waiting.clone());
        Ok((Arc::new(hub), events))
    }
}

#[async_trait]
impl FeedConnector for DemoSwitch {
    async fn connect(&self, token: String) -> Result<mpsc::Receiver<FeedEvent>, String> {
        if !is_demo_token(&token) {
            return self.live_feed.connect(token).await;
        }
        let (sender, queue) = mpsc::channel(1);
        *self.feed.lock().unwrap() = Some(sender);
        Ok(queue)
    }
}

impl Transports for DemoSwitch {
    fn direct(&self, signals: mpsc::Sender<String>) -> Arc<dyn DirectLink> {
        if !self.in_demo() {
            return self.live_transports.direct(signals);
        }
        // A computer only the relay reaches stays waiting for it.
        let waiting = {
            let mut waiting = self.waiting.lock().unwrap();
            match waiting.first() {
                Some(first) if first.kind == HostKind::App => Some(waiting.remove(0)),
                _ => None,
            }
        };
        self.host.direct(waiting, self.phone_key())
    }

    fn relay(&self, ticket: RelayTicket) -> Box<dyn Relay + Send> {
        if !self.in_demo() {
            return self.live_transports.relay(ticket);
        }
        let waiting = {
            let mut waiting = self.waiting.lock().unwrap();
            let at = waiting
                .iter()
                .position(|w| ticket.path.ends_with(&format!("/{}", w.session_id)));
            at.map(|at| waiting.remove(at))
        };
        self.host.relay(waiting, self.phone_key())
    }
}
