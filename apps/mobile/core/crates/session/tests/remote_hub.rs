//! The real hub client calling a small server that speaks the hub protocol.

use futures_util::{SinkExt, StreamExt};
use runova_session::hub::{AccessMode, HostKind, HubPort, Intent, RelayTicket, RemoteHub};
use runova_signalr::client::{HubClient, HubOptions};
use runova_signalr::wire::RS;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Seen = Arc<Mutex<Vec<(String, Vec<Value>)>>>;

async fn hub_answering(result: Value) -> (RemoteHub, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen: Seen = Arc::default();
    let record = seen.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::text(format!("{{}}{RS}")))
            .await
            .unwrap();
        while let Some(Ok(message)) = socket.next().await {
            let Ok(text) = message.into_text() else {
                continue;
            };
            for part in text.as_str().split(RS).filter(|p| !p.is_empty()) {
                let value: Value = serde_json::from_str(part).unwrap();
                if value["type"] != 1 {
                    continue;
                }
                record.lock().unwrap().push((
                    value["target"].as_str().unwrap().to_owned(),
                    value["arguments"].as_array().unwrap().clone(),
                ));
                let reply = json!({"type":3,"invocationId":value["invocationId"],"result":result});
                socket
                    .send(Message::text(format!("{reply}{RS}")))
                    .await
                    .unwrap();
            }
        }
    });
    let url = format!("ws://{address}/hubs/remote");
    let (client, _events) = HubClient::connect(&url, "rd1.token", HubOptions::default())
        .await
        .unwrap();
    (RemoteHub(client), seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_asks_to_manage_and_reads_the_answer() {
    let (hub, seen) = hub_answering(json!({
        "status": "ringing",
        "sessionId": "s1",
        "host": {"name": "Sam's desk", "identityKey": "key"},
    }))
    .await;

    let answer = hub
        .request_connect("111222333", 7, Intent::Manage, AccessMode::Ask)
        .await
        .unwrap();

    assert_eq!(answer.status, "ringing");
    assert_eq!(answer.session_id.as_deref(), Some("s1"));
    assert_eq!(answer.host.unwrap().identity_key, "key");
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].0, "RequestConnect");
    assert_eq!(
        seen[0].1[0],
        json!({"remoteId":"111222333","mode":"ask","controllerDeviceId":7,"intent":"manage"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_asks_for_control_with_its_mode_and_reads_the_agent_kind() {
    let (hub, seen) = hub_answering(json!({
        "status": "ringing",
        "sessionId": "s1",
        "host": {"name": "Sam's desk", "identityKey": "key", "kind": "agent"},
    }))
    .await;

    let answer = hub
        .request_connect("111222333", 7, Intent::Control, AccessMode::Password)
        .await
        .unwrap();

    assert_eq!(answer.host.unwrap().kind, HostKind::Agent);
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen[0].1[0],
        json!({"remoteId":"111222333","mode":"password","controllerDeviceId":7,"intent":"control"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_it_cannot_read_is_an_error() {
    let (hub, _) = hub_answering(json!({"nope": true})).await;

    assert!(
        hub.request_connect("111222333", 7, Intent::Manage, AccessMode::Ask)
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_ticket_is_read() {
    let (hub, seen) = hub_answering(json!({"path": "/relay/s1", "ticket": "t"})).await;

    let ticket = hub.relay_ticket("s1").await.unwrap();

    assert_eq!(
        ticket,
        RelayTicket {
            path: "/relay/s1".into(),
            ticket: "t".into(),
        }
    );
    assert_eq!(seen.lock().unwrap()[0].0, "CreateRelayTicket");
}

#[tokio::test(flavor = "multi_thread")]
async fn signals_and_ending_name_the_session() {
    let (hub, seen) = hub_answering(Value::Null).await;

    hub.signal("s1", "{}").await;
    hub.end("s1").await;

    let seen = seen.lock().unwrap();
    assert_eq!(
        seen[0],
        ("Signal".to_owned(), vec![json!("s1"), json!("{}")])
    );
    assert_eq!(seen[1], ("End".to_owned(), vec![json!("s1")]));
}
