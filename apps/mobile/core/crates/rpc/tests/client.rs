//! The management client against a scripted host over a real secure link.

use runova_crypto::handshake::{Identity, Mode, os_random};
use runova_link::secure::{ControllerConfig, HostConfig, LinkEvent, SecureLink};
use runova_link::testing::memory_pair;
use runova_protocol::manage::{ManageMessage, encode_stream, parse_message};
use runova_rpc::{ManageClient, RpcError, StreamEvent};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(5);

async fn linked() -> (SecureLink, SecureLink) {
    let (a, b) = memory_pair();
    let controller_key = Identity::from_seed([2; 32]).public_key();
    let host_key = Identity::from_seed([1; 32]).public_key();
    let host = tokio::spawn(async move {
        SecureLink::as_host(
            Box::new(b),
            HostConfig {
                session_id: "s".into(),
                mode: Mode::Ask,
                identity: Identity::from_seed([1; 32]),
                expected_controller_key: controller_key,
                password_secret: None,
                local_fingerprint: String::new(),
                remote_fingerprint: String::new(),
            },
            false,
            &mut os_random,
        )
        .await
        .unwrap()
    });
    let phone = SecureLink::as_controller(
        Box::new(a),
        ControllerConfig {
            session_id: "s".into(),
            mode: Mode::Ask,
            identity: Identity::from_seed([2; 32]),
            expected_host_key: host_key,
            password_secret: None,
            local_fingerprint: String::new(),
            remote_fingerprint: String::new(),
        },
        false,
        &mut os_random,
    )
    .await
    .unwrap();
    (phone, host.await.unwrap())
}

async fn say(host: &mut SecureLink, message: &ManageMessage) {
    host.send_text(&serde_json::to_string(message).unwrap())
        .await
        .unwrap();
}

async fn hear(host: &mut SecureLink) -> ManageMessage {
    match timeout(WAIT, host.next()).await.unwrap().unwrap() {
        LinkEvent::Text(text) => parse_message(&text).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

fn ready() -> ManageMessage {
    ManageMessage::ManageReady {
        v: 1,
        device_name: "Sam's desk".into(),
        scopes: vec!["core".into(), "git".into()],
    }
}

async fn started() -> (ManageClient, SecureLink) {
    let (phone, mut host) = linked().await;
    say(&mut host, &ready()).await;
    let client = timeout(WAIT, ManageClient::start(phone))
        .await
        .unwrap()
        .unwrap();
    (client, host)
}

fn ok(id: u64, value: Value) -> ManageMessage {
    ManageMessage::RpcResult {
        id,
        ok: true,
        v: Some(value),
        code: None,
        message: None,
    }
}

#[tokio::test]
async fn it_learns_the_computer_and_its_scopes_first() {
    let (client, _host) = started().await;

    assert_eq!(client.device_name(), "Sam's desk");
    assert!(client.has_scope("git"));
    assert!(!client.has_scope("vault"));
}

#[tokio::test]
async fn a_newer_protocol_is_reported_as_needing_an_update() {
    let (phone, mut host) = linked().await;
    say(
        &mut host,
        &ManageMessage::ManageReady {
            v: 2,
            device_name: "x".into(),
            scopes: vec![],
        },
    )
    .await;

    let result = timeout(WAIT, ManageClient::start(phone)).await.unwrap();

    assert_eq!(result.err(), Some(RpcError::VersionMismatch));
}

#[tokio::test(start_paused = true)]
async fn a_computer_that_never_says_ready_needs_an_update() {
    let (phone, _host) = linked().await;

    let result = ManageClient::start(phone).await;

    assert_eq!(result.err(), Some(RpcError::VersionMismatch));
}

#[tokio::test]
async fn a_call_gets_its_answer() {
    let (client, mut host) = started().await;
    let reply = tokio::spawn(async move { client.call("projects.list", None).await });

    let ManageMessage::RpcCall { id, m, .. } = hear(&mut host).await else {
        panic!("expected a call");
    };
    say(&mut host, &ok(id, json!([{"id": "a"}]))).await;

    assert_eq!(m, "projects.list");
    assert_eq!(
        timeout(WAIT, reply).await.unwrap().unwrap(),
        Ok(json!([{"id": "a"}]))
    );
}

#[tokio::test]
async fn answers_out_of_order_reach_the_right_caller() {
    let (client, mut host) = started().await;
    let first_client = client.clone();
    let first = tokio::spawn(async move { first_client.call("a", None).await });
    let ManageMessage::RpcCall { id: first_id, .. } = hear(&mut host).await else {
        panic!();
    };
    let second_client = client.clone();
    let second = tokio::spawn(async move { second_client.call("b", None).await });
    let ManageMessage::RpcCall { id: second_id, .. } = hear(&mut host).await else {
        panic!();
    };

    say(&mut host, &ok(second_id, json!("second"))).await;
    say(&mut host, &ok(first_id, json!("first"))).await;

    assert_eq!(first.await.unwrap(), Ok(json!("first")));
    assert_eq!(second.await.unwrap(), Ok(json!("second")));
}

#[tokio::test]
async fn a_refusal_carries_the_computers_reason() {
    let (client, mut host) = started().await;
    let reply = tokio::spawn(async move { client.call("vault.reveal", None).await });
    let ManageMessage::RpcCall { id, .. } = hear(&mut host).await else {
        panic!();
    };

    say(
        &mut host,
        &ManageMessage::RpcResult {
            id,
            ok: false,
            v: None,
            code: Some("forbidden".into()),
            message: Some("Not allowed.".into()),
        },
    )
    .await;

    assert_eq!(
        reply.await.unwrap(),
        Err(RpcError::Refused {
            code: "forbidden".into(),
            message: "Not allowed.".into()
        })
    );
}

#[tokio::test]
async fn a_subscription_receives_values_and_bytes_and_then_its_end() {
    let (client, mut host) = started().await;
    let subscribing = client.clone();
    let task = tokio::spawn(async move { subscribing.subscribe("terminal.follow", None).await });
    let ManageMessage::RpcSub { id, .. } = hear(&mut host).await else {
        panic!("expected a subscription");
    };
    let mut subscription = task.await.unwrap().unwrap();

    say(
        &mut host,
        &ManageMessage::RpcEvent {
            id,
            v: json!({"cpu": 1}),
        },
    )
    .await;
    host.send_binary(&encode_stream(id as u32, b"hello"))
        .await
        .unwrap();
    say(
        &mut host,
        &ManageMessage::RpcEnd {
            id,
            code: None,
            message: None,
        },
    )
    .await;

    assert_eq!(
        timeout(WAIT, subscription.next()).await.unwrap(),
        Some(StreamEvent::Value(json!({"cpu": 1})))
    );
    assert_eq!(
        timeout(WAIT, subscription.next()).await.unwrap(),
        Some(StreamEvent::Bytes(b"hello".to_vec()))
    );
    assert_eq!(
        timeout(WAIT, subscription.next()).await.unwrap(),
        Some(StreamEvent::Ended(None))
    );
}

#[tokio::test]
async fn dropping_a_subscription_tells_the_computer() {
    let (client, mut host) = started().await;
    let subscribing = client.clone();
    let task = tokio::spawn(async move { subscribing.subscribe("system.stats", None).await });
    let ManageMessage::RpcSub { id, .. } = hear(&mut host).await else {
        panic!();
    };
    let subscription = task.await.unwrap().unwrap();

    drop(subscription);

    assert_eq!(hear(&mut host).await, ManageMessage::RpcUnsub { id });
}

#[tokio::test]
async fn a_subscriber_that_falls_behind_is_ended_instead_of_filling_memory() {
    let (client, mut host) = started().await;
    let subscribing = client.clone();
    let task = tokio::spawn(async move { subscribing.subscribe("terminal.follow", None).await });
    let ManageMessage::RpcSub { id, .. } = hear(&mut host).await else {
        panic!();
    };
    let mut subscription = task.await.unwrap().unwrap();

    for _ in 0..5_000 {
        host.send_binary(&encode_stream(id as u32, b"x"))
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut last = None;
    while let Ok(Some(event)) = timeout(Duration::from_millis(200), subscription.next()).await {
        last = Some(event);
    }
    assert_eq!(last, Some(StreamEvent::Ended(Some(RpcError::FellBehind))));
}

#[tokio::test]
async fn when_the_link_goes_everything_waiting_is_told() {
    let (client, host) = started().await;
    let calling = client.clone();
    let reply = tokio::spawn(async move { calling.call("a", None).await });
    tokio::time::sleep(Duration::from_millis(50)).await;

    drop(host);

    assert_eq!(
        timeout(WAIT, reply).await.unwrap().unwrap(),
        Err(RpcError::Closed)
    );
    assert_eq!(client.call("b", None).await, Err(RpcError::Closed));
}

#[tokio::test]
async fn nonsense_from_the_computer_ends_the_session() {
    let (client, mut host) = started().await;

    host.send_text("{\"t\":\"nope\"}").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(client.call("a", None).await, Err(RpcError::Closed));
}
