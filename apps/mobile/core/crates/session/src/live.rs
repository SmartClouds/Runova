//! The real network behind [`Transports`]: WebRTC through `str0m`, and the website's relay.

use crate::connect::{DirectLink, Transports};
use crate::hub::RelayTicket;
use async_trait::async_trait;
use runova_link::opener::{Direct, Relay};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_relay::connect_relay;
use runova_rtc::direct::{Role, RtcDirect, RtcOptions};
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct LiveTransports {
    pub site: String,
}

struct LiveDirect(RtcDirect);

#[async_trait]
impl Direct for LiveDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        self.0.connect().await
    }

    async fn cancel(&self) {
        self.0.cancel().await;
    }
}

#[async_trait]
impl DirectLink for LiveDirect {
    async fn deliver_signal(&self, payload: String) {
        self.0.deliver_signal(payload).await;
    }
}

struct LiveRelay {
    site: String,
    ticket: RelayTicket,
}

#[async_trait]
impl Relay for LiveRelay {
    async fn connect(&self) -> Result<Box<dyn LinkTransport>, String> {
        let transport = connect_relay(&self.site, &self.ticket.path, &self.ticket.ticket)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Box::new(transport))
    }
}

impl Transports for LiveTransports {
    fn direct(&self, signals: mpsc::Sender<String>) -> Arc<dyn DirectLink> {
        Arc::new(LiveDirect(RtcDirect::new(
            Role::Controller,
            RtcOptions::default(),
            signals,
        )))
    }

    fn relay(&self, ticket: RelayTicket) -> Box<dyn Relay + Send> {
        Box::new(LiveRelay {
            site: self.site.clone(),
            ticket,
        })
    }
}
