//! The demo computer: the same handshake and protocols the desktop speaks, over links that never
//! leave the phone. It answers from the demo's answer files, shows a still desktop, and throws
//! away what is sent to it.

use super::DEMO_SCREEN;
use super::answers::{Answer, answers};
use super::hub::{DEMO_HOST_SEED, Waiting};
use async_trait::async_trait;
use runova_crypto::handshake::{Identity, Mode, os_random};
use runova_link::opener::{Direct, Relay};
use runova_link::secure::{HostConfig, LinkEvent, SecureLink};
use runova_link::testing::{MemoryTransport, memory_pair};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_protocol::manage::{ManageMessage, encode_stream, parse_message};
use runova_protocol::remote::{BIN_SCREEN_TILE, ControlMessage, ScreenSize, parse_control};
use runova_protocol::send::{SendMessage, parse_send_message};
use runova_session::connect::DirectLink;
use runova_session::hub::Intent;
use runova_transfer::discard::discard_batch;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::watch;

/// Every scope there is, so every screen is open in the demo.
const SCOPES: &[&str] = &[
    "core",
    "terminal",
    "git",
    "vault",
    "deploy",
    "cloudflare",
    "ops",
    "studio",
    "control",
    "files",
    "tasks",
];
const SCREEN_WIDTH: u16 = 1280;
const SCREEN_HEIGHT: u16 = 720;
const NOT_IN_DEMO: &str = "That isn't part of the demo.";
const FOLLOW: &str = "terminals.follow";
const WRITE: &str = "terminals.write";
/// Both ends of a direct demo link agree on these, as WebRTC's would.
const PHONE_FINGERPRINT: &str = "sha-256 DE:M0:01";
const HOST_FINGERPRINT: &str = "sha-256 DE:M0:02";

pub(crate) struct DemoHost;

impl DemoHost {
    pub(crate) fn new() -> Self {
        Self
    }

    /// The direct link to a rung demo computer. One reached only through the relay, or none at all,
    /// never connects directly.
    pub(crate) fn direct(
        &self,
        waiting: Option<Waiting>,
        phone_key: [u8; 32],
    ) -> Arc<dyn DirectLink> {
        let Some(waiting) = waiting else {
            return Arc::new(DemoDirect(Mutex::new(None)));
        };
        let (phone, host) = memory_pair();
        serve(host, false, waiting, phone_key);
        Arc::new(DemoDirect(Mutex::new(Some(phone))))
    }

    pub(crate) fn relay(
        &self,
        waiting: Option<Waiting>,
        phone_key: [u8; 32],
    ) -> Box<dyn Relay + Send> {
        let Some(waiting) = waiting else {
            return Box::new(DemoRelay(Mutex::new(None)));
        };
        let (phone, host) = memory_pair();
        serve(host, true, waiting, phone_key);
        Box::new(DemoRelay(Mutex::new(Some(phone))))
    }
}

struct DemoDirect(Mutex<Option<MemoryTransport>>);

#[async_trait]
impl Direct for DemoDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        let transport = self.0.lock().unwrap().take();
        let Some(transport) = transport else {
            return std::future::pending().await;
        };
        Ok((
            Box::new(transport),
            Fingerprints {
                local: PHONE_FINGERPRINT.to_owned(),
                remote: HOST_FINGERPRINT.to_owned(),
            },
        ))
    }

    async fn cancel(&self) {}
}

#[async_trait]
impl DirectLink for DemoDirect {
    async fn deliver_signal(&self, _payload: String) {}
}

struct DemoRelay(Mutex<Option<MemoryTransport>>);

#[async_trait]
impl Relay for DemoRelay {
    async fn connect(&self) -> Result<Box<dyn LinkTransport>, String> {
        let transport = self.0.lock().unwrap().take();
        transport
            .map(|t| Box::new(t) as Box<dyn LinkTransport>)
            .ok_or_else(|| "This demo computer can't be reached.".to_owned())
    }
}

fn serve(transport: MemoryTransport, sealed: bool, waiting: Waiting, phone_key: [u8; 32]) {
    tokio::spawn(async move {
        let fingerprint = |value: &str| {
            if sealed {
                String::new()
            } else {
                value.to_owned()
            }
        };
        let Ok(link) = SecureLink::as_host(
            Box::new(transport),
            HostConfig {
                session_id: waiting.session_id.clone(),
                mode: Mode::Ask,
                identity: Identity::from_seed(DEMO_HOST_SEED),
                expected_controller_key: phone_key,
                password_secret: None,
                local_fingerprint: fingerprint(HOST_FINGERPRINT),
                remote_fingerprint: fingerprint(PHONE_FINGERPRINT),
            },
            sealed,
            &mut os_random,
        )
        .await
        else {
            return;
        };
        match waiting.intent {
            Intent::Manage => serve_manage(link, &waiting.name).await,
            Intent::Control => serve_control(link, &waiting.name).await,
            Intent::Send => serve_send(link).await,
        }
    });
}

async fn say(link: &mut SecureLink, message: &ManageMessage) -> bool {
    let text = serde_json::to_string(message).expect("a manage message");
    link.send_text(&text).await.is_ok()
}

async fn serve_manage(mut link: SecureLink, name: &str) {
    let ready = ManageMessage::ManageReady {
        v: 1,
        device_name: name.to_owned(),
        scopes: SCOPES.iter().map(|s| (*s).to_owned()).collect(),
    };
    if !say(&mut link, &ready).await {
        return;
    }
    // The open terminal stream, which typing is echoed to.
    let mut follow: Option<u64> = None;
    loop {
        let text = match link.next().await {
            Ok(LinkEvent::Text(text)) => text,
            Ok(LinkEvent::Binary(_)) => continue,
            Err(_) => break,
        };
        let ok = match parse_message(&text) {
            Some(ManageMessage::RpcCall { id, m, p }) => {
                let answered = say(&mut link, &call(id, &m, p.as_ref())).await;
                if answered
                    && m == WRITE
                    && let Some(stream) = follow
                {
                    echo(&mut link, stream, p.as_ref()).await
                } else {
                    answered
                }
            }
            Some(ManageMessage::RpcSub { id, m, .. }) => {
                if m == FOLLOW {
                    follow = Some(id);
                }
                stream(&mut link, id, &m).await
            }
            Some(ManageMessage::RpcUnsub { id }) => {
                if follow == Some(id) {
                    follow = None;
                }
                true
            }
            _ => true,
        };
        if !ok {
            break;
        }
    }
    link.close().await;
}

fn call(id: u64, method: &str, params: Option<&serde_json::Value>) -> ManageMessage {
    match answers().get(method) {
        Some(Answer {
            error: Some(refusal),
            ..
        }) => ManageMessage::RpcResult {
            id,
            ok: false,
            v: None,
            code: Some(refusal.code.clone()),
            message: Some(refusal.message.clone()),
        },
        Some(answer) => ManageMessage::RpcResult {
            id,
            ok: true,
            v: Some(answer.result_for(params)),
            code: None,
            message: None,
        },
        None => ManageMessage::RpcResult {
            id,
            ok: false,
            v: None,
            code: Some("unavailable".to_owned()),
            message: Some(NOT_IN_DEMO.to_owned()),
        },
    }
}

async fn stream(link: &mut SecureLink, id: u64, method: &str) -> bool {
    let Some(answer) = answers().get(method) else {
        return say(
            link,
            &ManageMessage::RpcEnd {
                id,
                code: Some("unavailable".to_owned()),
                message: Some(NOT_IN_DEMO.to_owned()),
            },
        )
        .await;
    };
    for event in &answer.events {
        let message = ManageMessage::RpcEvent {
            id,
            v: event.clone(),
        };
        if !say(link, &message).await {
            return false;
        }
    }
    for text in &answer.bytes {
        if link
            .send_binary(&encode_stream(id as u32, text.as_bytes()))
            .await
            .is_err()
        {
            return false;
        }
    }
    if !answer.end {
        return true;
    }
    let (code, message) = answer
        .error
        .as_ref()
        .map(|r| (r.code.clone(), r.message.clone()))
        .unzip();
    say(link, &ManageMessage::RpcEnd { id, code, message }).await
}

/// Shows what was typed, as a shell would.
async fn echo(link: &mut SecureLink, stream: u64, params: Option<&serde_json::Value>) -> bool {
    let Some(data) = params.and_then(|p| p["data"].as_str()) else {
        return true;
    };
    let shown = data.replace('\r', "\r\n$ ");
    link.send_binary(&encode_stream(stream as u32, shown.as_bytes()))
        .await
        .is_ok()
}

fn tile(frame_id: u32) -> Vec<u8> {
    let mut frame = vec![BIN_SCREEN_TILE];
    frame.extend_from_slice(&frame_id.to_be_bytes());
    for value in [0, 0, SCREEN_WIDTH, SCREEN_HEIGHT] {
        frame.extend_from_slice(&value.to_be_bytes());
    }
    frame.extend_from_slice(DEMO_SCREEN);
    frame
}

/// The remote screen: one still picture of a desktop. Input goes nowhere.
async fn serve_control(mut link: SecureLink, name: &str) {
    let mut frame_id = 0u32;
    loop {
        let text = match link.next().await {
            Ok(LinkEvent::Text(text)) => text,
            Ok(LinkEvent::Binary(_)) => continue,
            Err(_) => break,
        };
        let reply = match parse_control(&text) {
            Some(ControlMessage::Hello { .. }) => Some(ControlMessage::AuthOk {
                device_name: name.to_owned(),
                screen: ScreenSize {
                    width: u32::from(SCREEN_WIDTH),
                    height: u32::from(SCREEN_HEIGHT),
                },
            }),
            Some(ControlMessage::Ping) => Some(ControlMessage::Pong),
            Some(ControlMessage::Bye { .. }) => break,
            _ => None,
        };
        let sends_screen = matches!(
            parse_control(&text),
            Some(ControlMessage::Hello { .. } | ControlMessage::ControlStart)
        );
        if let Some(reply) = reply
            && link
                .send_text(&serde_json::to_string(&reply).expect("a control message"))
                .await
                .is_err()
        {
            break;
        }
        if sends_screen {
            frame_id += 1;
            if link.send_binary(&tile(frame_id)).await.is_err() {
                break;
            }
        }
    }
    link.close().await;
}

/// Takes files as the desktop does, and keeps none of them.
async fn serve_send(mut link: SecureLink) {
    let offer = loop {
        match link.next().await {
            Ok(LinkEvent::Text(text)) => {
                if let Some(offer @ SendMessage::SendOffer { .. }) = parse_send_message(&text) {
                    break offer;
                }
            }
            Ok(LinkEvent::Binary(_)) => {}
            Err(_) => return,
        }
    };
    let (keep, stop) = watch::channel(false);
    discard_batch(&mut link, &offer, stop).await;
    drop(keep);
    link.close().await;
}
