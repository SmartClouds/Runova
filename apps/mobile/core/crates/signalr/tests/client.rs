//! The client against a small WebSocket server that speaks the hub protocol.

// The WebSocket library's own accept callback has this large error type.
#![allow(clippy::result_large_err)]

use futures_util::{SinkExt, StreamExt};
use runova_signalr::client::{HubClient, HubError, HubOptions};
use runova_signalr::wire::RS;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

type Headers = Arc<Mutex<Option<String>>>;

/// Serves one connection: answers the handshake, then runs `script` on each hub message.
async fn serve<F>(script: F) -> (String, Headers)
where
    F: Fn(Value) -> Vec<String> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let authorization: Headers = Arc::new(Mutex::new(None));
    let seen = authorization.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(
            stream,
            move |request: &Request, response: Response| {
                *seen.lock().unwrap() = request
                    .headers()
                    .get("authorization")
                    .map(|v| v.to_str().unwrap().to_owned());
                Ok(response)
            },
        )
        .await
        .unwrap();
        let handshake = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(handshake.as_str().starts_with("{\"protocol\":\"json\""));
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
                for reply in script(value) {
                    socket.send(Message::text(reply)).await.unwrap();
                }
            }
        }
    });
    (format!("ws://{address}/hubs/remote"), authorization)
}

fn completion(id: &Value, result: Value) -> String {
    format!(
        "{}{RS}",
        json!({"type":3,"invocationId":id,"result":result})
    )
}

fn options() -> HubOptions {
    HubOptions {
        keep_alive: Duration::from_millis(50),
        server_timeout: Duration::from_millis(400),
        event_buffer: 8,
    }
}

#[tokio::test]
async fn it_sends_the_token_as_a_header_and_gets_a_typed_result() {
    let (url, authorization) = serve(|message| {
        if message["type"] == 1 {
            vec![completion(
                &message["invocationId"],
                json!({"status":"ringing"}),
            )]
        } else {
            vec![]
        }
    })
    .await;
    let (client, _events) = HubClient::connect(&url, "rd1.token", options())
        .await
        .unwrap();

    let answer = client
        .invoke("RequestConnect", vec![json!({"remoteId":"1"})])
        .await
        .unwrap();

    assert_eq!(answer, json!({"status":"ringing"}));
    assert_eq!(
        authorization.lock().unwrap().as_deref(),
        Some("Bearer rd1.token")
    );
}

#[tokio::test]
async fn a_refused_invocation_is_an_error_with_the_hubs_words() {
    let (url, _) = serve(|message| {
        if message["type"] == 1 {
            vec![format!("{}{RS}", json!({"type":3,"invocationId":message["invocationId"],"error":"That signaling message is too large."}))]
        } else {
            vec![]
        }
    })
    .await;
    let (client, _events) = HubClient::connect(&url, "t", options()).await.unwrap();

    let error = client.invoke("Signal", vec![]).await.unwrap_err();

    assert_eq!(
        error,
        HubError::Refused("That signaling message is too large.".into())
    );
}

#[tokio::test]
async fn events_from_the_hub_arrive_in_order() {
    let (url, _) = serve(|message| {
        if message["type"] == 1 {
            vec![
                format!(
                    "{}{RS}",
                    json!({"type":1,"target":"Signal","arguments":["s","one"]})
                ),
                format!(
                    "{}{RS}",
                    json!({"type":1,"target":"Signal","arguments":["s","two"]})
                ),
                completion(&message["invocationId"], Value::Null),
            ]
        } else {
            vec![]
        }
    })
    .await;
    let (client, mut events) = HubClient::connect(&url, "t", options()).await.unwrap();

    client.invoke("GoOnline", vec![json!(1)]).await.unwrap();
    let first = events.recv().await.unwrap();
    let second = events.recv().await.unwrap();

    assert_eq!(first.target, "Signal");
    assert_eq!(first.arguments, vec![json!("s"), json!("one")]);
    assert_eq!(second.arguments[1], json!("two"));
}

#[tokio::test]
async fn it_keeps_the_connection_alive_with_pings() {
    let pings = Arc::new(Mutex::new(0));
    let counted = pings.clone();
    let (url, _) = serve(move |message| {
        if message["type"] == 6 {
            *counted.lock().unwrap() += 1;
            return vec![format!("{{\"type\":6}}{RS}")];
        }
        vec![]
    })
    .await;
    let (_client, _events) = HubClient::connect(&url, "t", options()).await.unwrap();

    tokio::time::sleep(Duration::from_millis(220)).await;

    assert!(*pings.lock().unwrap() >= 2);
}

#[tokio::test]
async fn a_silent_server_closes_the_connection_and_fails_what_was_waiting() {
    let (url, _) = serve(|_| vec![]).await;
    let (client, mut events) = HubClient::connect(&url, "t", options()).await.unwrap();

    let error = client.invoke("GoOnline", vec![]).await.unwrap_err();

    assert_eq!(error, HubError::Closed);
    assert!(events.recv().await.is_none());
}

#[tokio::test]
async fn a_connection_refused_at_the_handshake_says_why() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.next().await;
        socket
            .send(Message::text(format!(
                "{}{RS}",
                json!({"error":"no such protocol"})
            )))
            .await
            .unwrap();
    });

    let result = HubClient::connect(&format!("ws://{address}/hubs/remote"), "t", options()).await;

    assert_eq!(
        result.err(),
        Some(HubError::Refused("no such protocol".into()))
    );
}

#[tokio::test]
async fn a_slow_reader_does_not_lose_the_replies_it_is_waiting_for() {
    let (url, _) = serve(|message| {
        if message["type"] == 1 {
            let mut replies: Vec<String> = (0..100)
                .map(|i| format!("{}{RS}", json!({"type":1,"target":"Noise","arguments":[i]})))
                .collect();
            replies.push(completion(&message["invocationId"], json!("done")));
            replies
        } else {
            vec![]
        }
    })
    .await;
    let (client, _events) = HubClient::connect(&url, "t", options()).await.unwrap();

    let answer = tokio::time::timeout(Duration::from_secs(2), client.invoke("Go", vec![]))
        .await
        .expect("the reply was not starved by the full event queue")
        .unwrap();

    assert_eq!(answer, json!("done"));
}
