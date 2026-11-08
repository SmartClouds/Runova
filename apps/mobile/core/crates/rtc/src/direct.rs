//! A direct link: one reliable, ordered data channel named `runova-link`, as the desktop makes it.
//!
//! str0m does no I/O of its own, so one task owns the `Rtc` and the sockets. Every change to the
//! `Rtc` is followed by draining its output, which is the contract str0m asks for.

use crate::signals::{Signal, fingerprint_of};
use crate::stun::{binding_request, read_mapped_address};
use async_trait::async_trait;
use runova_link::opener::Direct;
use runova_link::transport::{Fingerprints, LinkTransport, TransportClosed};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::{UdpSocket, lookup_host};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio::time::{sleep_until, timeout_at};

const LABEL: &str = "runova-link";
const QUEUE: usize = 64;
const PACKET_QUEUE: usize = 256;
const MTU: usize = 2048;
/// Past this many unsent bytes in the channel, no more frames are taken from the app.
const HIGH_WATER: usize = 2 * 1024 * 1024;
/// How soon to look again while waiting for the channel's buffer to drain.
const WRITE_RETRY: Duration = Duration::from_millis(10);
/// Time to deliver the closing messages once the app has hung up.
const CLOSE_GRACE: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Makes the offer, as a phone or desktop connecting to a computer does.
    Controller,
    /// Answers the offer. Only tests and the fake host play this part.
    Answerer,
}

#[derive(Debug, Clone)]
pub struct RtcOptions {
    pub stun_servers: Vec<String>,
    pub allow_loopback: bool,
    pub gather_timeout: Duration,
}

impl Default for RtcOptions {
    fn default() -> Self {
        Self {
            stun_servers: vec![
                "stun.l.google.com:19302".to_owned(),
                "stun.cloudflare.com:3478".to_owned(),
            ],
            allow_loopback: false,
            gather_timeout: Duration::from_millis(1200),
        }
    }
}

pub struct RtcDirect {
    role: Role,
    options: RtcOptions,
    signals_out: mpsc::Sender<String>,
    inbox: mpsc::Sender<String>,
    inbox_queue: Mutex<Option<mpsc::Receiver<String>>>,
    cancel: watch::Sender<bool>,
}

struct RtcTransport {
    outgoing: Option<mpsc::Sender<Vec<u8>>>,
    incoming: mpsc::Receiver<Vec<u8>>,
}

#[async_trait]
impl LinkTransport for RtcTransport {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), TransportClosed> {
        let outgoing = self.outgoing.as_ref().ok_or(TransportClosed)?;
        outgoing.send(frame).await.map_err(|_| TransportClosed)
    }

    async fn recv(&mut self) -> Option<Vec<u8>> {
        self.incoming.recv().await
    }

    async fn close(&mut self) {
        self.outgoing = None;
    }
}

struct Bound {
    socket: Arc<UdpSocket>,
    local: SocketAddr,
}

fn local_addresses(allow_loopback: bool) -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|interface| interface.ip())
        .filter(|ip| match ip {
            IpAddr::V4(v4) => !v4.is_link_local() && (allow_loopback || !v4.is_loopback()),
            IpAddr::V6(_) => false,
        })
        .collect()
}

/// One socket per address: ICE has to know which of its candidates a packet arrived on.
async fn bind_all(allow_loopback: bool) -> Vec<Bound> {
    let mut bound = Vec::new();
    for ip in local_addresses(allow_loopback) {
        if let Ok(socket) = UdpSocket::bind(SocketAddr::new(ip, 0)).await
            && let Ok(local) = socket.local_addr()
        {
            bound.push(Bound {
                socket: Arc::new(socket),
                local,
            });
        }
    }
    bound
}

/// What the internet sees each socket as, from the STUN servers that answer in time.
async fn gather_reflexive(bound: &[Bound], options: &RtcOptions) -> Vec<(SocketAddr, SocketAddr)> {
    let mut servers = Vec::new();
    for server in &options.stun_servers {
        if let Ok(mut found) = lookup_host(server).await
            && let Some(address) = found.find(SocketAddr::is_ipv4)
        {
            servers.push(address);
        }
    }
    if servers.is_empty() {
        return Vec::new();
    }
    let deadline = tokio::time::Instant::now() + options.gather_timeout;
    let mut waits = Vec::new();
    for (index, entry) in bound.iter().enumerate() {
        let id = [index as u8 + 1; 12];
        for server in &servers {
            let _ = entry.socket.send_to(&binding_request(&id), server).await;
        }
        let socket = entry.socket.clone();
        let base = entry.local;
        waits.push(tokio::spawn(async move {
            let mut found = Vec::new();
            let mut buffer = [0u8; 576];
            while let Ok(Ok((length, _))) =
                timeout_at(deadline, socket.recv_from(&mut buffer)).await
            {
                if let Some(mapped) = read_mapped_address(&buffer[..length], &id)
                    && !found.contains(&(mapped, base))
                {
                    found.push((mapped, base));
                }
            }
            found
        }));
    }
    let mut reflexive = Vec::new();
    for wait in waits {
        reflexive.extend(wait.await.unwrap_or_default());
    }
    reflexive
}

impl RtcDirect {
    pub fn new(role: Role, options: RtcOptions, signals_out: mpsc::Sender<String>) -> Self {
        let (inbox, queue) = mpsc::channel(QUEUE);
        let (cancel, _) = watch::channel(false);
        Self {
            role,
            options,
            signals_out,
            inbox,
            inbox_queue: Mutex::new(Some(queue)),
            cancel,
        }
    }

    /// A signaling message from the other side.
    pub async fn deliver_signal(&self, payload: String) {
        let _ = self.inbox.send(payload).await;
    }
}

#[async_trait]
impl Direct for RtcDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        let inbox = self
            .inbox_queue
            .lock()
            .await
            .take()
            .ok_or("this link was already started")?;
        let bound = bind_all(self.options.allow_loopback).await;
        if bound.is_empty() {
            return Err("this device has no network address".to_owned());
        }
        let reflexive = gather_reflexive(&bound, &self.options).await;

        let mut rtc = Rtc::new(Instant::now());
        for entry in &bound {
            let candidate = Candidate::host(entry.local, "udp").map_err(|e| e.to_string())?;
            rtc.add_local_candidate(candidate);
        }
        for (mapped, base) in reflexive {
            if let Ok(candidate) = Candidate::server_reflexive(mapped, base, "udp") {
                rtc.add_local_candidate(candidate);
            }
        }

        let (outgoing_tx, outgoing) = mpsc::channel(QUEUE);
        let (incoming, incoming_rx) = mpsc::channel(QUEUE);
        let (opened, opened_rx) = oneshot::channel();
        let mut cancel = self.cancel.subscribe();
        let mut engine = Engine {
            rtc,
            sockets: bound
                .iter()
                .map(|entry| (entry.local, entry.socket.clone()))
                .collect(),
            role: self.role,
            channel: None,
            pending_offer: None,
            local_sdp: String::new(),
            remote_sdp: String::new(),
            signals_out: self.signals_out.clone(),
            opened: Some(opened),
            incoming,
            hanging_up: false,
        };
        engine.start()?;
        let cancel_for_engine = self.cancel.subscribe();
        tokio::spawn(engine.run(bound, inbox, outgoing, cancel_for_engine));

        tokio::select! {
            result = opened_rx => {
                let fingerprints = result.map_err(|_| "the connection ended before it opened".to_owned())?;
                let transport = RtcTransport { outgoing: Some(outgoing_tx), incoming: incoming_rx };
                Ok((Box::new(transport) as Box<dyn LinkTransport>, fingerprints))
            }
            _ = stopped(&mut cancel) => Err("cancelled".to_owned()),
        }
    }

    async fn cancel(&self) {
        let _ = self.cancel.send(true);
    }
}

/// Waits for cancellation. Returns nothing so the channel's read guard is released at once.
async fn stopped(cancel: &mut watch::Receiver<bool>) {
    let _ = cancel.wait_for(|stop| *stop).await;
}

struct Engine {
    rtc: Rtc,
    sockets: HashMap<SocketAddr, Arc<UdpSocket>>,
    role: Role,
    channel: Option<ChannelId>,
    pending_offer: Option<SdpPendingOffer>,
    local_sdp: String,
    remote_sdp: String,
    signals_out: mpsc::Sender<String>,
    opened: Option<oneshot::Sender<Fingerprints>>,
    incoming: mpsc::Sender<Vec<u8>>,
    /// The app has hung up, and the closing messages are still going out.
    hanging_up: bool,
}

impl Engine {
    /// The controller's offer. It carries every candidate, so nothing has to trickle.
    fn start(&mut self) -> Result<(), String> {
        if self.role == Role::Answerer {
            return Ok(());
        }
        let mut change = self.rtc.sdp_api();
        let channel = change.add_channel(LABEL.to_owned());
        let (offer, pending) = change.apply().ok_or("nothing to offer")?;
        self.channel = Some(channel);
        self.pending_offer = Some(pending);
        self.local_sdp = offer.to_sdp_string();
        let _ = self.signals_out.try_send(
            Signal::Sdp {
                kind: "offer".to_owned(),
                sdp: self.local_sdp.clone(),
            }
            .to_json(),
        );
        Ok(())
    }

    async fn apply_signal(&mut self, payload: &str) {
        match Signal::parse(payload) {
            Some(Signal::Sdp { kind, sdp }) if kind == "answer" => {
                if let (Some(pending), Ok(answer)) =
                    (self.pending_offer.take(), SdpAnswer::from_sdp_string(&sdp))
                {
                    self.remote_sdp = sdp;
                    let _ = self.rtc.sdp_api().accept_answer(pending, answer);
                }
            }
            Some(Signal::Sdp { kind, sdp }) if kind == "offer" && self.role == Role::Answerer => {
                if let Ok(offer) = SdpOffer::from_sdp_string(&sdp) {
                    self.remote_sdp = sdp;
                    let answer = self
                        .rtc
                        .sdp_api()
                        .accept_offer(offer)
                        .ok()
                        .map(|answer| answer.to_sdp_string());
                    if let Some(answer) = answer {
                        self.local_sdp = answer;
                        let reply = Signal::Sdp {
                            kind: "answer".to_owned(),
                            sdp: self.local_sdp.clone(),
                        };
                        let _ = self.signals_out.send(reply.to_json()).await;
                    }
                }
            }
            // Chromium hides local addresses behind .local names, which do not parse. Those are
            // skipped: its connectivity checks still reach the addresses this side offered.
            Some(Signal::Ice { candidate }) => {
                if let Ok(candidate) = Candidate::from_sdp_string(&candidate) {
                    self.rtc.add_remote_candidate(candidate);
                }
            }
            _ => {}
        }
    }

    /// Runs one event. False means the link is over.
    async fn handle_event(&mut self, event: Event) -> bool {
        match event {
            Event::ChannelOpen(id, label) if label == LABEL => {
                self.channel = Some(id);
                if let Some(opened) = self.opened.take() {
                    let _ = opened.send(Fingerprints {
                        local: fingerprint_of(&self.local_sdp),
                        remote: fingerprint_of(&self.remote_sdp),
                    });
                }
                true
            }
            // Waiting here is the backpressure: a slow app slows the sender down.
            Event::ChannelData(data) => self.incoming.send(data.data).await.is_ok(),
            Event::ChannelClose(_) => self.hanging_up,
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => false,
            _ => true,
        }
    }

    /// Runs the output to its end and gives the next deadline, or `None` when the link is over.
    async fn drain(&mut self) -> Option<Instant> {
        loop {
            match self.rtc.poll_output() {
                Err(_) => return None,
                Ok(Output::Timeout(deadline)) => return Some(deadline),
                Ok(Output::Transmit(transmit)) => {
                    if let Some(socket) = self.sockets.get(&transmit.source) {
                        let _ = socket
                            .send_to(&transmit.contents, transmit.destination)
                            .await;
                    }
                }
                Ok(Output::Event(event)) => {
                    if !self.handle_event(event).await {
                        return None;
                    }
                }
            }
        }
    }

    fn writable(&mut self) -> bool {
        let Some(id) = self.channel else { return false };
        self.opened.is_none()
            && self
                .rtc
                .channel(id)
                .is_some_and(|mut channel| channel.buffered_amount() < HIGH_WATER)
    }

    /// True once the frame has been accepted.
    fn write(&mut self, frame: &[u8]) -> bool {
        let Some(id) = self.channel else { return true };
        match self.rtc.channel(id) {
            Some(mut channel) => channel.write(true, frame).unwrap_or(true),
            None => true,
        }
    }

    async fn run(
        mut self,
        bound: Vec<Bound>,
        mut inbox: mpsc::Receiver<String>,
        mut outgoing: mpsc::Receiver<Vec<u8>>,
        mut cancel: watch::Receiver<bool>,
    ) {
        let (packets_tx, mut packets) = mpsc::channel(PACKET_QUEUE);
        let readers: Vec<_> = bound
            .into_iter()
            .map(|entry| {
                let queue = packets_tx.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; MTU];
                    while let Ok((length, source)) = entry.socket.recv_from(&mut buffer).await {
                        let packet = (entry.local, source, buffer[..length].to_vec());
                        if queue.send(packet).await.is_err() {
                            break;
                        }
                    }
                })
            })
            .collect();
        drop(packets_tx);

        let mut waiting_frame: Option<Vec<u8>> = None;
        let mut closing_at: Option<Instant> = None;
        loop {
            let Some(mut deadline) = self.drain().await else {
                break;
            };
            if let Some(frame) = waiting_frame.take() {
                if !self.write(&frame) {
                    waiting_frame = Some(frame);
                } else {
                    continue;
                }
            }
            let can_take = !self.hanging_up && waiting_frame.is_none() && self.writable();
            let now = Instant::now();
            if !self.hanging_up && self.opened.is_none() && !can_take {
                deadline = deadline.min(now + WRITE_RETRY);
            }
            if let Some(end) = closing_at {
                if now >= end {
                    break;
                }
                deadline = deadline.min(end);
            }

            tokio::select! {
                _ = sleep_until(deadline.max(now).into()) => {
                    if self.rtc.handle_input(Input::Timeout(Instant::now())).is_err() {
                        break;
                    }
                }
                Some((destination, source, contents)) = packets.recv() => {
                    let contents: &[u8] = &contents;
                    let Ok(contents) = contents.try_into() else { continue };
                    let input = Input::Receive(Instant::now(), Receive {
                        proto: Protocol::Udp,
                        source,
                        destination,
                        contents,
                    });
                    if self.rtc.handle_input(input).is_err() {
                        break;
                    }
                }
                Some(signal) = inbox.recv() => self.apply_signal(&signal).await,
                frame = outgoing.recv(), if can_take => match frame {
                    Some(frame) => {
                        if !self.write(&frame) {
                            waiting_frame = Some(frame);
                        }
                    }
                    None => {
                        self.hanging_up = true;
                        closing_at = Some(Instant::now() + CLOSE_GRACE);
                        if let Some(id) = self.channel {
                            self.rtc.direct_api().close_data_channel(id);
                        }
                    }
                },
                _ = stopped(&mut cancel) => break,
            }
        }
        for reader in readers {
            reader.abort();
        }
    }
}
