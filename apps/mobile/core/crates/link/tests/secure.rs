//! The secure link over an in-memory pair, with a real handshake on both ends.

use runova_crypto::handshake::{Identity, Mode, os_random};
use runova_link::secure::{ControllerConfig, HostConfig, LinkError, LinkEvent, SecureLink};
use runova_link::testing::memory_pair;
use std::time::Duration;

const CONTROLLER_SEED: [u8; 32] = [2; 32];
const HOST_SEED: [u8; 32] = [1; 32];

fn controller_config(expected_host: [u8; 32]) -> ControllerConfig {
    ControllerConfig {
        session_id: "session-1".into(),
        mode: Mode::Ask,
        identity: Identity::from_seed(CONTROLLER_SEED),
        expected_host_key: expected_host,
        password_secret: None,
        local_fingerprint: "sha-256 AA".into(),
        remote_fingerprint: "sha-256 BB".into(),
    }
}

fn host_config() -> HostConfig {
    HostConfig {
        session_id: "session-1".into(),
        mode: Mode::Ask,
        identity: Identity::from_seed(HOST_SEED),
        expected_controller_key: Identity::from_seed(CONTROLLER_SEED).public_key(),
        password_secret: None,
        local_fingerprint: "sha-256 BB".into(),
        remote_fingerprint: "sha-256 AA".into(),
    }
}

fn host_key() -> [u8; 32] {
    Identity::from_seed(HOST_SEED).public_key()
}

async fn opened(encrypted: bool) -> (SecureLink, SecureLink) {
    let (a, b) = memory_pair();
    let host = tokio::spawn(async move {
        SecureLink::as_host(Box::new(b), host_config(), encrypted, &mut os_random).await
    });
    let controller = SecureLink::as_controller(
        Box::new(a),
        controller_config(host_key()),
        encrypted,
        &mut os_random,
    )
    .await
    .unwrap();
    (controller, host.await.unwrap().unwrap())
}

#[tokio::test]
async fn both_sides_finish_with_the_same_safety_code() {
    let (controller, host) = opened(false).await;

    assert_eq!(controller.safety_code(), host.safety_code());
    assert_eq!(controller.safety_code().len(), 6);
}

#[tokio::test]
async fn text_and_binary_cross_both_ways() {
    let (mut controller, mut host) = opened(false).await;

    controller.send_text("{\"t\":\"hello\"}").await.unwrap();
    host.send_binary(&[1, 2, 3]).await.unwrap();

    assert_eq!(
        host.next().await.unwrap(),
        LinkEvent::Text("{\"t\":\"hello\"}".into())
    );
    assert_eq!(
        controller.next().await.unwrap(),
        LinkEvent::Binary(vec![1, 2, 3])
    );
}

#[tokio::test]
async fn a_large_message_is_fragmented_and_arrives_whole() {
    let (mut controller, mut host) = opened(false).await;
    let payload: Vec<u8> = (0..300_000).map(|i| (i % 251) as u8).collect();

    let sent = payload.clone();
    tokio::spawn(async move { controller.send_binary(&sent).await.unwrap() });

    assert_eq!(host.next().await.unwrap(), LinkEvent::Binary(payload));
}

#[tokio::test]
async fn an_encrypted_link_carries_messages_too() {
    let (mut controller, mut host) = opened(true).await;

    controller.send_text("sealed").await.unwrap();

    assert_eq!(host.next().await.unwrap(), LinkEvent::Text("sealed".into()));
}

#[tokio::test]
async fn an_impostor_host_is_refused_and_nothing_passes() {
    let (a, b) = memory_pair();
    let host = tokio::spawn(async move {
        let mut impostor = host_config();
        impostor.identity = Identity::from_seed([7; 32]);
        SecureLink::as_host(Box::new(b), impostor, false, &mut os_random)
            .await
            .err()
    });

    let result = SecureLink::as_controller(
        Box::new(a),
        controller_config(host_key()),
        false,
        &mut os_random,
    )
    .await;

    assert!(matches!(result.err(), Some(LinkError::Handshake(_))));
    assert!(host.await.unwrap().is_some());
}

#[tokio::test(start_paused = true)]
async fn a_silent_peer_times_out_the_handshake() {
    let (a, _kept) = memory_pair();

    let result = SecureLink::as_controller(
        Box::new(a),
        controller_config(host_key()),
        false,
        &mut os_random,
    )
    .await;

    assert_eq!(result.err(), Some(LinkError::TimedOut));
}

#[tokio::test]
async fn the_other_side_leaving_ends_the_link() {
    let (mut controller, host) = opened(false).await;

    drop(host);

    let next = tokio::time::timeout(Duration::from_secs(1), controller.next())
        .await
        .unwrap();
    assert_eq!(next.err(), Some(LinkError::Closed));
}

#[tokio::test]
async fn a_message_before_the_handshake_is_refused() {
    let (a, mut b) = memory_pair();
    use runova_link::transport::LinkTransport;
    b.send(vec![2, 9, 9]).await.unwrap();

    let result = SecureLink::as_controller(
        Box::new(a),
        controller_config(host_key()),
        false,
        &mut os_random,
    )
    .await;

    assert!(matches!(result.err(), Some(LinkError::Handshake(_))));
}
