//! A Runova Anywhere connection: the secure handshake first, then framed messages, over whichever
//! transport reached the other device. Until the handshake succeeds nothing but handshake messages
//! is accepted. Frames are sealed only where the transport is not encrypted end to end.

use crate::transport::LinkTransport;
use runova_crypto::cipher::FrameCipher;
use runova_crypto::handshake::{
    ControllerHandshake, HandshakeError, HostHandshake, Identity, Mode, SessionKeys,
};
use runova_protocol::framing::{LINK_TEXT, LinkKind, LinkReassembler, encode_link_message};
use runova_protocol::handshake::HandshakeMessage;
use std::time::Duration;
use thiserror::Error;
use tokio::time::timeout;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LinkError {
    #[error("the secure handshake failed: {0}")]
    Handshake(HandshakeError),
    #[error("the other device did not answer the secure handshake")]
    TimedOut,
    #[error("the link closed")]
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkEvent {
    Text(String),
    Binary(Vec<u8>),
}

pub struct ControllerConfig {
    pub session_id: String,
    pub mode: Mode,
    pub identity: Identity,
    pub expected_host_key: [u8; 32],
    pub password_secret: Option<[u8; 32]>,
    pub local_fingerprint: String,
    pub remote_fingerprint: String,
}

pub struct HostConfig {
    pub session_id: String,
    pub mode: Mode,
    pub identity: Identity,
    pub expected_controller_key: [u8; 32],
    pub password_secret: Option<[u8; 32]>,
    pub local_fingerprint: String,
    pub remote_fingerprint: String,
}

type Random<'a> = &'a mut (dyn FnMut(usize) -> Vec<u8> + Send);

pub struct SecureLink {
    transport: Box<dyn LinkTransport>,
    reassembler: LinkReassembler,
    cipher: Option<FrameCipher>,
    next_message_id: u32,
    safety_code: String,
}

/// Writes one handshake message as a link frame, unsealed.
async fn send_handshake(
    transport: &mut Box<dyn LinkTransport>,
    message: &HandshakeMessage,
) -> Result<(), LinkError> {
    let text = serde_json::to_vec(message).map_err(|_| LinkError::Closed)?;
    for frame in encode_link_message(LinkKind::Text, &text, 0).map_err(|_| LinkError::Closed)? {
        transport.send(frame).await.map_err(|_| LinkError::Closed)?;
    }
    Ok(())
}

async fn next_handshake(
    transport: &mut Box<dyn LinkTransport>,
) -> Result<HandshakeMessage, LinkError> {
    let frame = timeout(HANDSHAKE_TIMEOUT, transport.recv())
        .await
        .map_err(|_| LinkError::TimedOut)?
        .ok_or(LinkError::Closed)?;
    let (&kind, body) = frame
        .split_first()
        .ok_or(LinkError::Handshake(HandshakeError::Protocol))?;
    if kind != LINK_TEXT {
        return Err(LinkError::Handshake(HandshakeError::Protocol));
    }
    match serde_json::from_slice::<HandshakeMessage>(body) {
        Ok(message) if message.t.starts_with("hs-") => Ok(message),
        _ => Err(LinkError::Handshake(HandshakeError::Protocol)),
    }
}

/// Tells the other side why, closes, and gives back the error.
async fn abort(mut transport: Box<dyn LinkTransport>, error: HandshakeError) -> LinkError {
    let message = HandshakeMessage {
        t: "hs-abort".into(),
        reason: Some(error.wire_name().to_owned()),
        ..HandshakeMessage::default()
    };
    let _ = send_handshake(&mut transport, &message).await;
    transport.close().await;
    LinkError::Handshake(error)
}

impl SecureLink {
    fn open(transport: Box<dyn LinkTransport>, keys: &SessionKeys, encrypted: bool) -> Self {
        Self {
            transport,
            reassembler: LinkReassembler::new(),
            cipher: encrypted.then(|| FrameCipher::new(*keys.send(), *keys.receive())),
            next_message_id: 1,
            safety_code: keys.safety_code().to_owned(),
        }
    }

    pub async fn as_controller(
        mut transport: Box<dyn LinkTransport>,
        config: ControllerConfig,
        encrypted: bool,
        random: Random<'_>,
    ) -> Result<Self, LinkError> {
        let mut handshake = ControllerHandshake::new(
            &config.session_id,
            config.mode,
            config.identity,
            config.expected_host_key,
            config.password_secret,
            &config.local_fingerprint,
            &config.remote_fingerprint,
            random,
        )
        .map_err(LinkError::Handshake)?;
        send_handshake(&mut transport, handshake.hello()).await?;
        let reply = match next_handshake(&mut transport).await {
            Ok(reply) => reply,
            Err(LinkError::Handshake(error)) => return Err(abort(transport, error).await),
            Err(other) => return Err(other),
        };
        let (finish, keys) = match handshake.complete(&reply) {
            Ok(done) => done,
            Err(error) => return Err(abort(transport, error).await),
        };
        send_handshake(&mut transport, &finish).await?;
        Ok(Self::open(transport, &keys, encrypted))
    }

    pub async fn as_host(
        mut transport: Box<dyn LinkTransport>,
        config: HostConfig,
        encrypted: bool,
        random: Random<'_>,
    ) -> Result<Self, LinkError> {
        let mut handshake = HostHandshake::new(
            &config.session_id,
            config.mode,
            config.identity,
            config.expected_controller_key,
            config.password_secret,
            &config.local_fingerprint,
            &config.remote_fingerprint,
        );
        let hello = next_handshake(&mut transport).await?;
        let reply = match handshake.respond(&hello, random) {
            Ok(reply) => reply,
            Err(error) => return Err(abort(transport, error).await),
        };
        send_handshake(&mut transport, &reply).await?;
        let finish = next_handshake(&mut transport).await?;
        let keys = match handshake.complete(&finish) {
            Ok(keys) => keys,
            Err(error) => return Err(abort(transport, error).await),
        };
        Ok(Self::open(transport, &keys, encrypted))
    }

    /// Six digits both people can compare to rule out anyone in the middle.
    pub fn safety_code(&self) -> &str {
        &self.safety_code
    }

    async fn send(&mut self, kind: LinkKind, payload: &[u8]) -> Result<(), LinkError> {
        let id = self.next_message_id;
        self.next_message_id = id.wrapping_add(1);
        for frame in encode_link_message(kind, payload, id).map_err(|_| LinkError::Closed)? {
            let frame = match self.cipher.as_mut() {
                Some(cipher) => cipher.seal(&frame).map_err(|_| LinkError::Closed)?,
                None => frame,
            };
            self.transport
                .send(frame)
                .await
                .map_err(|_| LinkError::Closed)?;
        }
        Ok(())
    }

    pub async fn send_text(&mut self, text: &str) -> Result<(), LinkError> {
        self.send(LinkKind::Text, text.as_bytes()).await
    }

    pub async fn send_binary(&mut self, payload: &[u8]) -> Result<(), LinkError> {
        self.send(LinkKind::Binary, payload).await
    }

    /// The next whole message. Any malformed or forged frame ends the link.
    pub async fn next(&mut self) -> Result<LinkEvent, LinkError> {
        loop {
            let frame = self.transport.recv().await.ok_or(LinkError::Closed)?;
            let frame = match self.cipher.as_mut() {
                Some(cipher) => match cipher.open(&frame) {
                    Ok(frame) => frame,
                    Err(_) => return self.fail().await,
                },
                None => frame,
            };
            match self.reassembler.push(&frame) {
                Ok(Some(message)) => {
                    return match message.kind {
                        LinkKind::Binary => Ok(LinkEvent::Binary(message.payload)),
                        LinkKind::Text => match String::from_utf8(message.payload) {
                            Ok(text) => Ok(LinkEvent::Text(text)),
                            Err(_) => self.fail().await,
                        },
                    };
                }
                Ok(None) => {}
                Err(_) => return self.fail().await,
            }
        }
    }

    async fn fail(&mut self) -> Result<LinkEvent, LinkError> {
        self.transport.close().await;
        Err(LinkError::Closed)
    }

    pub async fn close(&mut self) {
        self.transport.close().await;
    }
}
