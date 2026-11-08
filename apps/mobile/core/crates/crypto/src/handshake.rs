//! The controller's half of the Runova Anywhere handshake: X25519 keys signed with Ed25519
//! identity keys over a transcript holding both DTLS fingerprints, HKDF keys per direction, and
//! CPace on ristretto255 when a password is involved.
//! Same construction as `packages/protocol/src/secure/handshake.ts`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use runova_protocol::handshake::HandshakeMessage;
use sha2::{Digest, Sha256, Sha512};
use subtle::ConstantTimeEq;
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, ZeroizeOnDrop};

const DOMAIN: &str = "runova-anywhere-v1";
const CPACE_DSI: &str = "CPaceRistretto255";
const CPACE_ISK_DSI: &str = "CPaceRistretto255_ISK";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum HandshakeError {
    #[error("the handshake broke its protocol")]
    Protocol,
    #[error("the computer's identity key is not the one expected")]
    Identity,
    #[error("the connection's fingerprint does not match")]
    Fingerprint,
    #[error("a signature did not verify")]
    Signature,
    #[error("the password is wrong")]
    WrongPassword,
}

impl HandshakeError {
    /// The reason an `hs-abort` carries for this failure.
    pub fn wire_name(self) -> &'static str {
        match self {
            HandshakeError::Identity => "identity",
            HandshakeError::Fingerprint => "fingerprint",
            HandshakeError::Signature => "signature",
            HandshakeError::WrongPassword => "wrong-password",
            HandshakeError::Protocol => "protocol",
        }
    }

    fn from_wire(name: Option<&str>) -> Self {
        match name {
            Some("identity") => HandshakeError::Identity,
            Some("fingerprint") => HandshakeError::Fingerprint,
            Some("signature") => HandshakeError::Signature,
            Some("wrong-password") => HandshakeError::WrongPassword,
            _ => HandshakeError::Protocol,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Ask,
    Password,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Mode::Ask => "ask",
            Mode::Password => "password",
        }
    }
}

pub fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A device's long-lived Ed25519 key. The signing key is wiped when this is dropped.
pub struct Identity {
    key: SigningKey,
}

impl Identity {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    fn sign(&self, role: &str, transcript: &[u8; 32]) -> [u8; 64] {
        self.key.sign(&role_message(role, transcript)).to_bytes()
    }
}

/// A fresh random seed for a new identity, from the OS generator.
pub fn new_identity_seed() -> Result<[u8; 32], HandshakeError> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|_| HandshakeError::Protocol)?;
    Ok(seed)
}

/// Random bytes from the OS generator, in the form the handshake takes them.
pub fn os_random(length: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; length];
    getrandom::getrandom(&mut bytes).expect("the OS random generator");
    bytes
}

/// The secret CPace runs on, from the password and the computer's identity key.
pub fn derive_password_secret(
    password: &str,
    host_identity_key: &str,
) -> Result<[u8; 32], HandshakeError> {
    let normalized: String = password.nfkc().collect();
    let params = scrypt::Params::new(15, 8, 1, 32).map_err(|_| HandshakeError::Protocol)?;
    let salt = format!("runova-anywhere-prs-v1|{host_identity_key}");
    let mut secret = [0u8; 32];
    scrypt::scrypt(normalized.as_bytes(), salt.as_bytes(), &params, &mut secret)
        .map_err(|_| HandshakeError::Protocol)?;
    Ok(secret)
}

fn role_message(role: &str, transcript: &[u8; 32]) -> Vec<u8> {
    let mut message = format!("{DOMAIN} {role}").into_bytes();
    message.extend_from_slice(transcript);
    message
}

/// Appends `value` with its length, u32 big-endian.
fn put_lv(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&(value.len() as u32).to_be_bytes());
    output.extend_from_slice(value);
}

fn lv(value: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(4 + value.len());
    put_lv(&mut output, value);
    output
}

struct CpaceState {
    scalar: Scalar,
    share: [u8; 32],
}

fn cpace_share(
    secret: &[u8; 32],
    controller_id: &[u8; 32],
    host_id: &[u8; 32],
    session_id: &str,
    random: &mut dyn FnMut(usize) -> Vec<u8>,
) -> Result<CpaceState, HandshakeError> {
    let mut parties = lv(controller_id);
    put_lv(&mut parties, host_id);
    let mut input = Vec::new();
    put_lv(&mut input, CPACE_DSI.as_bytes());
    put_lv(&mut input, secret);
    put_lv(&mut input, &parties);
    put_lv(&mut input, session_id.as_bytes());
    let digest: [u8; 64] = Sha512::digest(&input).into();
    input.zeroize();
    let generator = RistrettoPoint::from_uniform_bytes(&digest);
    loop {
        let wide: [u8; 64] = random(64)
            .try_into()
            .map_err(|_| HandshakeError::Protocol)?;
        let scalar = Scalar::from_bytes_mod_order_wide(&wide);
        if scalar == Scalar::ZERO {
            continue;
        }
        return Ok(CpaceState {
            scalar,
            share: (scalar * generator).compress().to_bytes(),
        });
    }
}

fn cpace_isk(
    session_id: &str,
    scalar: &Scalar,
    peer_share: &[u8; 32],
    ya: &[u8; 32],
    yb: &[u8; 32],
) -> Result<[u8; 64], HandshakeError> {
    let peer = CompressedRistretto(*peer_share)
        .decompress()
        .ok_or(HandshakeError::Protocol)?;
    let shared = (scalar * peer).compress().to_bytes();
    if shared == [0u8; 32] {
        return Err(HandshakeError::Protocol);
    }
    let mut input = Vec::new();
    put_lv(&mut input, CPACE_ISK_DSI.as_bytes());
    put_lv(&mut input, session_id.as_bytes());
    put_lv(&mut input, &shared);
    put_lv(&mut input, ya);
    put_lv(&mut input, yb);
    let isk = Sha512::digest(&input).into();
    input.zeroize();
    Ok(isk)
}

struct TranscriptParts<'a> {
    session_id: &'a str,
    mode: Mode,
    controller_id: &'a [u8; 32],
    host_id: &'a [u8; 32],
    controller_eph: &'a [u8; 32],
    host_eph: &'a [u8; 32],
    controller_nonce: &'a [u8; 16],
    host_nonce: &'a [u8; 16],
    controller_fp: &'a str,
    host_fp: &'a str,
    controller_share: Option<&'a [u8; 32]>,
    host_share: Option<&'a [u8; 32]>,
}

fn transcript(parts: &TranscriptParts<'_>) -> [u8; 32] {
    let mut input = Vec::with_capacity(320);
    put_lv(&mut input, DOMAIN.as_bytes());
    put_lv(&mut input, parts.session_id.as_bytes());
    put_lv(&mut input, parts.mode.name().as_bytes());
    put_lv(&mut input, parts.controller_id);
    put_lv(&mut input, parts.host_id);
    put_lv(&mut input, parts.controller_eph);
    put_lv(&mut input, parts.host_eph);
    put_lv(&mut input, parts.controller_nonce);
    put_lv(&mut input, parts.host_nonce);
    put_lv(&mut input, parts.controller_fp.as_bytes());
    put_lv(&mut input, parts.host_fp.as_bytes());
    put_lv(
        &mut input,
        parts.controller_share.map_or(&[][..], |s| &s[..]),
    );
    put_lv(&mut input, parts.host_share.map_or(&[][..], |s| &s[..]));
    Sha256::digest(&input).into()
}

fn confirm_tag(key: &[u8; 32], role: &str, transcript: &[u8; 32]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(role.as_bytes());
    mac.update(transcript);
    mac.finalize().into_bytes().into()
}

fn safety_code(transcript: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{DOMAIN} safety").as_bytes());
    hasher.update(transcript);
    let digest = hasher.finalize();
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    format!("{:06}", value % 1_000_000)
}

fn field<const N: usize>(value: Option<&str>) -> Result<[u8; N], HandshakeError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.ok_or(HandshakeError::Protocol)?)
        .map_err(|_| HandshakeError::Protocol)?;
    decoded.try_into().map_err(|_| HandshakeError::Protocol)
}

fn point(value: Option<&str>) -> Result<[u8; 32], HandshakeError> {
    let bytes: [u8; 32] = field(value)?;
    if bytes == [0u8; 32] || CompressedRistretto(bytes).decompress().is_none() {
        return Err(HandshakeError::Protocol);
    }
    Ok(bytes)
}

/// The keys of an established session. They are wiped when this is dropped.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SessionKeys {
    send: [u8; 32],
    receive: [u8; 32],
    #[zeroize(skip)]
    safety_code: String,
    #[zeroize(skip)]
    transcript: [u8; 32],
}

impl SessionKeys {
    pub fn send(&self) -> &[u8; 32] {
        &self.send
    }

    pub fn receive(&self) -> &[u8; 32] {
        &self.receive
    }

    /// Six digits both people can compare to rule out anyone in the middle.
    pub fn safety_code(&self) -> &str {
        &self.safety_code
    }

    pub fn transcript(&self) -> &[u8; 32] {
        &self.transcript
    }
}

/// Sends the hello, then checks the computer's reply and finishes.
pub struct ControllerHandshake {
    session_id: String,
    mode: Mode,
    identity: Identity,
    expected_host_key: [u8; 32],
    remote_fingerprint: String,
    eph: StaticSecret,
    eph_public: [u8; 32],
    nonce: [u8; 16],
    cpace: Option<CpaceState>,
    hello: HandshakeMessage,
}

impl ControllerHandshake {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_id: &str,
        mode: Mode,
        identity: Identity,
        expected_host_key: [u8; 32],
        password_secret: Option<[u8; 32]>,
        local_fingerprint: &str,
        remote_fingerprint: &str,
        random: &mut dyn FnMut(usize) -> Vec<u8>,
    ) -> Result<Self, HandshakeError> {
        let mut eph_bytes: [u8; 32] = random(32)
            .try_into()
            .map_err(|_| HandshakeError::Protocol)?;
        let eph = StaticSecret::from(eph_bytes);
        eph_bytes.zeroize();
        let eph_public = PublicKey::from(&eph).to_bytes();
        let nonce: [u8; 16] = random(16)
            .try_into()
            .map_err(|_| HandshakeError::Protocol)?;
        let public_key = identity.public_key();
        let cpace = match mode {
            Mode::Password => {
                let mut secret = password_secret.ok_or(HandshakeError::Protocol)?;
                let state =
                    cpace_share(&secret, &public_key, &expected_host_key, session_id, random)?;
                secret.zeroize();
                Some(state)
            }
            Mode::Ask => None,
        };
        let hello = HandshakeMessage {
            t: "hs-hello".into(),
            v: Some(1),
            eph: Some(base64url(&eph_public)),
            id: Some(base64url(&public_key)),
            nonce: Some(base64url(&nonce)),
            fp: Some(local_fingerprint.to_owned()),
            cpace: cpace.as_ref().map(|c| base64url(&c.share)),
            ..HandshakeMessage::default()
        };
        Ok(Self {
            session_id: session_id.to_owned(),
            mode,
            identity,
            expected_host_key,
            remote_fingerprint: remote_fingerprint.to_owned(),
            eph,
            eph_public,
            nonce,
            cpace,
            hello,
        })
    }

    pub fn hello(&self) -> &HandshakeMessage {
        &self.hello
    }

    pub fn complete(
        &mut self,
        reply: &HandshakeMessage,
    ) -> Result<(HandshakeMessage, SessionKeys), HandshakeError> {
        if reply.t != "hs-reply" {
            return Err(if reply.t == "hs-abort" {
                HandshakeError::from_wire(reply.reason.as_deref())
            } else {
                HandshakeError::Protocol
            });
        }

        let host_eph: [u8; 32] = field(reply.eph.as_deref())?;
        let host_id: [u8; 32] = field(reply.id.as_deref())?;
        let host_nonce: [u8; 16] = field(reply.nonce.as_deref())?;
        if !bool::from(host_id.ct_eq(&self.expected_host_key)) {
            return Err(HandshakeError::Identity);
        }
        let host_fp = reply.fp.as_deref().unwrap_or("");
        if host_fp != self.remote_fingerprint {
            return Err(HandshakeError::Fingerprint);
        }
        let host_share = match self.mode {
            Mode::Password => Some(point(reply.cpace.as_deref())?),
            Mode::Ask if reply.cpace.is_some() => return Err(HandshakeError::Protocol),
            Mode::Ask => None,
        };

        let controller_id = self.identity.public_key();
        let transcript = transcript(&TranscriptParts {
            session_id: &self.session_id,
            mode: self.mode,
            controller_id: &controller_id,
            host_id: &host_id,
            controller_eph: &self.eph_public,
            host_eph: &host_eph,
            controller_nonce: &self.nonce,
            host_nonce: &host_nonce,
            controller_fp: self.hello.fp.as_deref().unwrap_or(""),
            host_fp,
            controller_share: self.cpace.as_ref().map(|c| &c.share),
            host_share: host_share.as_ref(),
        });
        self.verify_host(reply, &host_id, &transcript)?;

        let isk = match (&self.cpace, &host_share) {
            (Some(cpace), Some(share)) => Some(cpace_isk(
                &self.session_id,
                &cpace.scalar,
                share,
                &cpace.share,
                share,
            )?),
            _ => None,
        };
        let shared = self.eph.diffie_hellman(&PublicKey::from(host_eph));
        if !shared.was_contributory() {
            return Err(HandshakeError::Protocol);
        }

        let mut ikm = shared.as_bytes().to_vec();
        if let Some(isk) = &isk {
            ikm.extend_from_slice(isk);
        }
        let mut okm = [0u8; 96];
        Hkdf::<Sha256>::new(Some(&transcript), &ikm)
            .expand(format!("{DOMAIN} keys").as_bytes(), &mut okm)
            .map_err(|_| HandshakeError::Protocol)?;
        ikm.zeroize();

        let result = self.finish(reply, &okm, transcript);
        okm.zeroize();
        result
    }

    fn verify_host(
        &self,
        reply: &HandshakeMessage,
        host_id: &[u8; 32],
        transcript: &[u8; 32],
    ) -> Result<(), HandshakeError> {
        let signature: [u8; 64] =
            field(reply.sig.as_deref()).map_err(|_| HandshakeError::Signature)?;
        let key = VerifyingKey::from_bytes(host_id).map_err(|_| HandshakeError::Signature)?;
        key.verify_strict(
            &role_message("host", transcript),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| HandshakeError::Signature)
    }

    fn finish(
        &self,
        reply: &HandshakeMessage,
        okm: &[u8; 96],
        transcript: [u8; 32],
    ) -> Result<(HandshakeMessage, SessionKeys), HandshakeError> {
        let wrong_confirm = match self.mode {
            Mode::Password => HandshakeError::WrongPassword,
            Mode::Ask => HandshakeError::Protocol,
        };
        let mut send = [0u8; 32];
        let mut receive = [0u8; 32];
        let mut confirm_key = [0u8; 32];
        send.copy_from_slice(&okm[..32]);
        receive.copy_from_slice(&okm[32..64]);
        confirm_key.copy_from_slice(&okm[64..]);

        let claimed: [u8; 32] = field(reply.confirm.as_deref()).map_err(|_| wrong_confirm)?;
        let expected = confirm_tag(&confirm_key, "host", &transcript);
        if !bool::from(claimed.ct_eq(&expected)) {
            send.zeroize();
            receive.zeroize();
            confirm_key.zeroize();
            return Err(wrong_confirm);
        }

        let finish = HandshakeMessage {
            t: "hs-finish".into(),
            sig: Some(base64url(&self.identity.sign("controller", &transcript))),
            confirm: Some(base64url(&confirm_tag(
                &confirm_key,
                "controller",
                &transcript,
            ))),
            ..HandshakeMessage::default()
        };
        confirm_key.zeroize();
        Ok((
            finish,
            SessionKeys {
                send,
                receive,
                safety_code: safety_code(&transcript),
                transcript,
            },
        ))
    }
}
