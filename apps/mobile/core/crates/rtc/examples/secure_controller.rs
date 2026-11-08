//! The phone's side of the interop test in `apps/mobile/core/interop/chromium.mjs`: a real link to
//! a real browser, then the real handshake. Signals travel over stdin and stdout.

use runova_crypto::handshake::{Identity, Mode, os_random};
use runova_link::opener::Direct;
use runova_link::secure::{ControllerConfig, LinkEvent, SecureLink};
use runova_rtc::direct::{Role, RtcDirect, RtcOptions};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tokio::time::timeout;

#[tokio::main]
async fn main() {
    let host_key: [u8; 32] = hex::decode(std::env::args().nth(1).expect("the host's key in hex"))
        .expect("hex")
        .try_into()
        .expect("32 bytes");
    let (signals, mut outgoing) = mpsc::channel::<String>(64);
    let options = RtcOptions {
        stun_servers: vec![],
        allow_loopback: true,
        gather_timeout: Duration::from_millis(50),
    };
    let direct = Arc::new(RtcDirect::new(Role::Controller, options, signals));

    tokio::spawn(async move {
        while let Some(signal) = outgoing.recv().await {
            println!("SIGNAL {signal}");
        }
    });
    let target = direct.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            target.deliver_signal(line).await;
        }
    });

    let (transport, fingerprints) = timeout(Duration::from_secs(30), direct.connect())
        .await
        .expect("the channel opened in time")
        .expect("the channel opened");
    println!("OPEN {}", fingerprints.local);

    let config = ControllerConfig {
        session_id: "interop".into(),
        mode: Mode::Ask,
        identity: Identity::from_seed([0x22; 32]),
        expected_host_key: host_key,
        password_secret: None,
        local_fingerprint: fingerprints.local,
        remote_fingerprint: fingerprints.remote,
    };
    let mut link = SecureLink::as_controller(transport, config, false, &mut os_random)
        .await
        .expect("the secure handshake");
    println!("SECURE {}", link.safety_code());

    link.send_text("ping").await.expect("send");
    match link.next().await.expect("an answer") {
        LinkEvent::Text(text) => assert_eq!(text, "pong:ping"),
        other => panic!("expected text, got {other:?}"),
    }

    let big: Vec<u8> = (0..300_000).map(|i| (i % 251) as u8).collect();
    link.send_binary(&big).await.expect("send");
    match link.next().await.expect("an answer") {
        LinkEvent::Binary(echo) => assert_eq!(echo, big),
        other => panic!("expected binary, got {other:?}"),
    }
    println!("DONE");
    tokio::time::sleep(Duration::from_millis(300)).await;
}
