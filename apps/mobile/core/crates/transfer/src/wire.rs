//! One side's view of a send link: it says messages, hears the next one, pings while it waits,
//! and calls the link gone once nothing has been heard for a while, as a dead network gives no
//! other sign.

use runova_link::secure::{LinkEvent, SecureLink};
use runova_protocol::file::FileMessage;
use runova_protocol::send::{
    SEND_PING_MS, SEND_SILENCE_MS, SendMessage, is_send_message, parse_send_message,
};
use serde::Serialize;
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

pub(crate) enum Heard {
    Send(SendMessage),
    File(FileMessage),
    Binary(Vec<u8>),
    /// The person here stopped it.
    Stop,
    /// The link closed or went silent.
    Gone,
    /// Nothing that mattered came before the deadline.
    Timeout,
}

pub(crate) struct Wire<'a> {
    link: &'a mut SecureLink,
    stop: watch::Receiver<bool>,
    /// False once the stop's sender is gone, so it is not waited on any more.
    stop_live: bool,
    last_heard: Instant,
    next_ping: Instant,
    ping: Duration,
    silence: Duration,
}

enum Step {
    Event(Result<LinkEvent, runova_link::secure::LinkError>),
    Stop,
    StopGone,
    Ping,
    Timeout,
}

impl<'a> Wire<'a> {
    pub(crate) fn new(link: &'a mut SecureLink, stop: watch::Receiver<bool>) -> Self {
        let now = Instant::now();
        let ping = Duration::from_millis(SEND_PING_MS);
        Self {
            link,
            stop,
            stop_live: true,
            last_heard: now,
            next_ping: now + ping,
            ping,
            silence: Duration::from_millis(SEND_SILENCE_MS),
        }
    }

    pub(crate) fn stopped(&self) -> bool {
        *self.stop.borrow()
    }

    pub(crate) async fn say(&mut self, message: &impl Serialize) -> Result<(), ()> {
        let text = serde_json::to_string(message).map_err(|_| ())?;
        self.link.send_text(&text).await.map_err(|_| ())
    }

    pub(crate) async fn say_binary(&mut self, bytes: &[u8]) -> Result<(), ()> {
        self.link.send_binary(bytes).await.map_err(|_| ())?;
        Ok(())
    }

    /// The next message that means something, pinging the other side while it waits.
    pub(crate) async fn hear(&mut self, until: Option<Instant>) -> Heard {
        loop {
            if self.stopped() {
                return Heard::Stop;
            }
            let step = {
                let stop_live = self.stop_live;
                tokio::select! {
                    biased;
                    event = self.link.next() => Step::Event(event),
                    changed = self.stop.changed(), if stop_live => {
                        if changed.is_ok() { Step::Stop } else { Step::StopGone }
                    }
                    () = sleep_until(self.next_ping) => Step::Ping,
                    () = sleep_until(until.unwrap_or_else(far_away)), if until.is_some() => Step::Timeout,
                }
            };
            match step {
                Step::Event(Ok(LinkEvent::Text(text))) => {
                    self.last_heard = Instant::now();
                    if is_send_message(&text) {
                        match parse_send_message(&text) {
                            Some(SendMessage::SendPing) | None => {}
                            Some(message) => return Heard::Send(message),
                        }
                    } else if let Some(message) = FileMessage::parse(&text) {
                        return Heard::File(message);
                    }
                }
                Step::Event(Ok(LinkEvent::Binary(bytes))) => {
                    self.last_heard = Instant::now();
                    return Heard::Binary(bytes);
                }
                Step::Event(Err(_)) => return Heard::Gone,
                Step::Stop => {
                    if self.stopped() {
                        return Heard::Stop;
                    }
                }
                Step::StopGone => self.stop_live = false,
                Step::Ping => {
                    if self.last_heard.elapsed() > self.silence {
                        return Heard::Gone;
                    }
                    if self.say(&SendMessage::SendPing).await.is_err() {
                        return Heard::Gone;
                    }
                    self.next_ping = Instant::now() + self.ping;
                }
                Step::Timeout => return Heard::Timeout,
            }
        }
    }
}

fn far_away() -> Instant {
    Instant::now() + Duration::from_secs(86_400)
}
