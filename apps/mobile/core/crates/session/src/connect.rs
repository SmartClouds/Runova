//! From "connect to this computer" to a working session: a management session, or a remote-control
//! link that the viewer takes over.

use crate::hub::{AccessMode, HostKind, HubEvent, HubPort, Intent, RelayTicket};
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_crypto::handshake::{HandshakeError, Identity, Mode, derive_password_secret, os_random};
use runova_link::opener::{Direct, LinkKind, RELAY_SIGNAL, Relay, RelaySignal, open_link};
use runova_link::secure::{ControllerConfig, LinkError, SecureLink};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_rpc::{ManageClient, RpcError};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{Notify, mpsc};
use tokio::time::{Instant, timeout_at};
use zeroize::Zeroizing;

/// A little past the hub's minute of ringing, so its answer arrives first when there is one.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(65);
const SIGNAL_QUEUE: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Requesting,
    WaitingForApproval,
    Connecting,
    Securing,
    Connected { safety_code: String, direct: bool },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ConnectError {
    #[error("This computer is offline.")]
    Offline,
    #[error("This computer can't be reached from this phone.")]
    Unavailable,
    #[error("Too many tries. Wait a moment and try again.")]
    RateLimited,
    #[error("The request was declined on the computer.")]
    Declined,
    #[error("No one answered on the computer.")]
    NoAnswer,
    #[error("This computer's identity has changed. Check it before connecting again.")]
    KeyChanged,
    #[error("Update Runova on this computer to manage it from your phone.")]
    NeedsUpdate,
    #[error("That password is not the one for this computer.")]
    WrongPassword,
    #[error("{0}")]
    Failed(String),
}

/// The computer asked for, and who is asking.
#[derive(Clone)]
pub struct ConnectTarget {
    pub remote_id: String,
    pub device_id: i64,
    pub identity_seed: [u8; 32],
}

/// The computers' keys, remembered the first time each is seen.
pub trait PinStore: Send + Sync {
    fn pinned(&self, remote_id: &str) -> Option<String>;
    fn pin(&self, remote_id: &str, key: &str);
}

#[async_trait]
pub trait DirectLink: Direct + Send + Sync {
    async fn deliver_signal(&self, payload: String);
}

/// Makes the two kinds of link, so tests can stand in for the network.
pub trait Transports: Send + Sync {
    fn direct(&self, signals: mpsc::Sender<String>) -> Arc<dyn DirectLink>;
    fn relay(&self, ticket: RelayTicket) -> Box<dyn Relay + Send>;
}

pub struct ManageSession {
    pub client: ManageClient,
    pub session_id: String,
    pub safety_code: String,
    pub direct: bool,
}

/// A secured link to a computer that will show its screen. The viewer owns it from here on.
pub struct ControlLink {
    pub link: SecureLink,
    pub session_id: String,
    pub safety_code: String,
    pub direct: bool,
    pub host_kind: HostKind,
}

struct LinkDetails {
    session_id: String,
    safety_code: String,
    direct: bool,
    host_kind: HostKind,
}

struct TicketRelay<'a> {
    hub: &'a dyn HubPort,
    transports: &'a dyn Transports,
    session_id: &'a str,
}

#[async_trait]
impl Relay for TicketRelay<'_> {
    async fn connect(&self) -> Result<Box<dyn LinkTransport>, String> {
        let ticket = self.hub.relay_ticket(self.session_id).await?;
        self.transports.relay(ticket).connect().await
    }
}

struct HubSignal<'a> {
    hub: &'a dyn HubPort,
    session_id: &'a str,
}

#[async_trait]
impl RelaySignal for HubSignal<'_> {
    async fn tell_other_side(&self, payload: &str) {
        self.hub.signal(self.session_id, payload).await;
    }
}

/// A direct attempt that also ends when the computer says to use the relay, as the background
/// agent always does.
struct RelayOnWord<'a> {
    direct: &'a dyn DirectLink,
    relay_now: &'a Notify,
}

#[async_trait]
impl Direct for RelayOnWord<'_> {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        tokio::select! {
            connected = self.direct.connect() => connected,
            () = self.relay_now.notified() => Err("the computer asked for the relay".to_owned()),
        }
    }

    async fn cancel(&self) {
        self.direct.cancel().await;
    }
}

async fn wait_for_answer(
    session_id: &str,
    events: &mut mpsc::Receiver<HubEvent>,
) -> Result<(), ConnectError> {
    let deadline = Instant::now() + APPROVAL_TIMEOUT;
    loop {
        let event = timeout_at(deadline, events.recv())
            .await
            .map_err(|_| ConnectError::NoAnswer)?
            .ok_or_else(|| ConnectError::Failed("Lost the connection to Runova.".to_owned()))?;
        match event {
            HubEvent::Resolved {
                session_id: id,
                accepted,
                reason,
            } if id == session_id => {
                return match (accepted, reason.as_deref()) {
                    (true, _) => Ok(()),
                    (false, Some("timeout")) => Err(ConnectError::NoAnswer),
                    (false, _) => Err(ConnectError::Declined),
                };
            }
            HubEvent::Ended { session_id: id, .. } if id == session_id => {
                return Err(ConnectError::Declined);
            }
            _ => {}
        }
    }
}

fn host_key_bytes(key: &str) -> Result<[u8; 32], ConnectError> {
    URL_SAFE_NO_PAD
        .decode(key)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| ConnectError::Failed("This computer sent an unusable key.".to_owned()))
}

/// The app and the background agent keep separate keys, so each is remembered on its own.
fn pin_key(remote_id: &str, kind: HostKind) -> String {
    match kind {
        HostKind::App => remote_id.to_owned(),
        HostKind::Agent => format!("{remote_id}#agent"),
    }
}

/// The key CPace runs on. Slow on purpose, so it does not run on the app's few workers.
async fn password_secret(
    password: Zeroizing<String>,
    host_key: String,
) -> Result<[u8; 32], ConnectError> {
    tokio::task::spawn_blocking(move || derive_password_secret(&password, &host_key))
        .await
        .map_err(|_| ConnectError::Failed("Couldn't use that password.".to_owned()))?
        .map_err(|_| ConnectError::Failed("Couldn't use that password.".to_owned()))
}

/// Opens a link and secures it. Signaling runs alongside this in [`connect_with`].
#[allow(clippy::too_many_arguments)]
async fn establish(
    session_id: &str,
    target: &ConnectTarget,
    host_key: [u8; 32],
    mode: Mode,
    password_secret: Option<[u8; 32]>,
    direct: &dyn DirectLink,
    relay_now: &Notify,
    hub: &dyn HubPort,
    transports: &dyn Transports,
    on_phase: &(dyn Fn(Phase) + Send + Sync),
) -> Result<(SecureLink, bool), ConnectError> {
    let relay = TicketRelay {
        hub,
        transports,
        session_id,
    };
    let signal = HubSignal { hub, session_id };
    let direct = RelayOnWord { direct, relay_now };
    let opened = open_link(&direct, &relay, &signal, false)
        .await
        .map_err(|e| ConnectError::Failed(e.to_string()))?;
    on_phase(Phase::Securing);

    let is_direct = opened.kind == LinkKind::Direct;
    let config = ControllerConfig {
        session_id: session_id.to_owned(),
        mode,
        identity: Identity::from_seed(target.identity_seed),
        expected_host_key: host_key,
        password_secret,
        local_fingerprint: opened.fingerprints.local.clone(),
        remote_fingerprint: opened.fingerprints.remote.clone(),
    };
    // Only the relay needs sealing: a direct link is encrypted end to end already.
    let link = SecureLink::as_controller(opened.transport, config, !is_direct, &mut os_random)
        .await
        .map_err(|error| match error {
            LinkError::Handshake(HandshakeError::WrongPassword) => ConnectError::WrongPassword,
            other => ConnectError::Failed(other.to_string()),
        })?;
    Ok((link, is_direct))
}

/// Everything a connection needs, whatever it is for. `finish` turns the secured link into what
/// the caller wanted; if it fails the request is ended like any other failure.
#[allow(clippy::too_many_arguments)]
async fn connect_with<T, Finish, Fut>(
    target: ConnectTarget,
    intent: Intent,
    password: Option<Zeroizing<String>>,
    hub: &dyn HubPort,
    transports: &dyn Transports,
    pins: &dyn PinStore,
    events: &mut mpsc::Receiver<HubEvent>,
    on_phase: &(dyn Fn(Phase) + Send + Sync),
    finish: Finish,
) -> Result<T, ConnectError>
where
    Finish: FnOnce(SecureLink, LinkDetails) -> Fut + Send,
    Fut: Future<Output = Result<T, ConnectError>> + Send,
    T: Send,
{
    let access = if password.is_some() {
        AccessMode::Password
    } else {
        AccessMode::Ask
    };
    on_phase(Phase::Requesting);
    let result = hub
        .request_connect(&target.remote_id, target.device_id, intent, access)
        .await
        .map_err(ConnectError::Failed)?;
    match result.status.as_str() {
        "ringing" => {}
        "offline" => return Err(ConnectError::Offline),
        "rate-limited" => return Err(ConnectError::RateLimited),
        _ => return Err(ConnectError::Unavailable),
    }
    let (Some(session_id), Some(host)) = (result.session_id, result.host) else {
        return Err(ConnectError::Unavailable);
    };
    let pin = pin_key(&target.remote_id, host.kind);

    // A key that differs from the one seen before could be someone in the middle.
    if pins
        .pinned(&pin)
        .is_some_and(|pinned| pinned != host.identity_key)
    {
        hub.end(&session_id).await;
        return Err(ConnectError::KeyChanged);
    }

    // No one has to answer a password request; the computer checks the password in the handshake.
    if access == AccessMode::Ask {
        on_phase(Phase::WaitingForApproval);
    }
    if let Err(error) = wait_for_answer(&session_id, events).await {
        hub.end(&session_id).await;
        return Err(error);
    }

    on_phase(Phase::Connecting);
    let (mode, secret) = match password {
        Some(password) => match self::password_secret(password, host.identity_key.clone()).await {
            Ok(secret) => (Mode::Password, Some(secret)),
            Err(error) => {
                hub.end(&session_id).await;
                return Err(error);
            }
        },
        None => (Mode::Ask, None),
    };
    let host_key = match host_key_bytes(&host.identity_key) {
        Ok(key) => key,
        Err(error) => {
            hub.end(&session_id).await;
            return Err(error);
        }
    };
    let (signals, mut outgoing_signals) = mpsc::channel(SIGNAL_QUEUE);
    let direct = transports.direct(signals);
    let relay_now = Notify::new();
    let work = establish(
        &session_id,
        &target,
        host_key,
        mode,
        secret,
        direct.as_ref(),
        &relay_now,
        hub,
        transports,
        on_phase,
    );
    tokio::pin!(work);
    let opened = loop {
        tokio::select! {
            biased;
            Some(event) = events.recv() => match event {
                HubEvent::Signal { session_id: id, payload } if id == session_id => {
                    if payload == RELAY_SIGNAL {
                        relay_now.notify_one();
                    } else {
                        direct.deliver_signal(payload).await;
                    }
                }
                HubEvent::Ended { session_id: id, .. } if id == session_id => {
                    direct.cancel().await;
                    return Err(ConnectError::Failed("The computer ended the request.".to_owned()));
                }
                _ => {}
            },
            Some(payload) = outgoing_signals.recv() => hub.signal(&session_id, &payload).await,
            result = &mut work => break result,
        }
    };

    let (link, is_direct) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            hub.end(&session_id).await;
            return Err(error);
        }
    };
    let safety_code = link.safety_code().to_owned();
    let details = LinkDetails {
        session_id: session_id.clone(),
        safety_code: safety_code.clone(),
        direct: is_direct,
        host_kind: host.kind,
    };
    match finish(link, details).await {
        Ok(session) => {
            pins.pin(&pin, &host.identity_key);
            on_phase(Phase::Connected {
                safety_code,
                direct: is_direct,
            });
            Ok(session)
        }
        Err(error) => {
            hub.end(&session_id).await;
            Err(error)
        }
    }
}

pub async fn connect_to(
    target: ConnectTarget,
    hub: &dyn HubPort,
    transports: &dyn Transports,
    pins: &dyn PinStore,
    events: &mut mpsc::Receiver<HubEvent>,
    on_phase: &(dyn Fn(Phase) + Send + Sync),
) -> Result<ManageSession, ConnectError> {
    connect_with(
        target,
        Intent::Manage,
        None,
        hub,
        transports,
        pins,
        events,
        on_phase,
        |link, details| async move {
            let client = ManageClient::start(link)
                .await
                .map_err(|error| match error {
                    RpcError::VersionMismatch => ConnectError::NeedsUpdate,
                    other => ConnectError::Failed(other.to_string()),
                })?;
            Ok(ManageSession {
                client,
                session_id: details.session_id,
                safety_code: details.safety_code,
                direct: details.direct,
            })
        },
    )
    .await
}

/// Opens a link to show this computer's screen, with its password when one is given.
pub async fn connect_control(
    target: ConnectTarget,
    password: Option<String>,
    hub: &dyn HubPort,
    transports: &dyn Transports,
    pins: &dyn PinStore,
    events: &mut mpsc::Receiver<HubEvent>,
    on_phase: &(dyn Fn(Phase) + Send + Sync),
) -> Result<ControlLink, ConnectError> {
    connect_with(
        target,
        Intent::Control,
        password.map(Zeroizing::new),
        hub,
        transports,
        pins,
        events,
        on_phase,
        |link, details| async move {
            Ok(ControlLink {
                link,
                session_id: details.session_id,
                safety_code: details.safety_code,
                direct: details.direct,
                host_kind: details.host_kind,
            })
        },
    )
    .await
}
