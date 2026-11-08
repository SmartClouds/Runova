//! The relay client against a small server that behaves like `RemoteRelay.cs`.

use futures_util::{SinkExt, StreamExt};
use runova_link::transport::LinkTransport;
use runova_relay::{RelayError, connect_relay, relay_url};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

#[allow(clippy::result_large_err)]
fn record_path(
    seen: Arc<Mutex<String>>,
) -> impl FnOnce(
    &Request,
    Response,
) -> Result<Response, tokio_tungstenite::tungstenite::handshake::server::ErrorResponse> {
    move |request, response| {
        *seen.lock().unwrap() = request.uri().to_string();
        Ok(response)
    }
}

/// Accepts one socket, says `ready`, then echoes binary frames until told otherwise.
async fn echo_relay() -> (String, Arc<Mutex<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(String::new()));
    let path = seen.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, record_path(path))
            .await
            .unwrap();
        socket.send(Message::text("ready")).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            if message.is_binary() {
                socket.send(message).await.unwrap();
            }
        }
    });
    (format!("http://{address}"), seen)
}

#[test]
fn the_address_is_a_websocket_with_the_ticket_escaped() {
    assert_eq!(
        relay_url("https://runovahq.com/", "/relay/remote/abc", "a+b/c"),
        "wss://runovahq.com/relay/remote/abc?ticket=a%2Bb%2Fc"
    );
}

#[tokio::test]
async fn it_waits_for_ready_and_carries_binary_frames() {
    let (site, seen) = echo_relay().await;

    let mut relay = connect_relay(&site, "/relay/remote/s1", "tick")
        .await
        .unwrap();
    relay.send(vec![1, 2, 3]).await.unwrap();

    assert_eq!(
        timeout(Duration::from_secs(2), relay.recv()).await.unwrap(),
        Some(vec![1, 2, 3])
    );
    assert_eq!(*seen.lock().unwrap(), "/relay/remote/s1?ticket=tick");
}

#[tokio::test]
async fn a_relay_that_closes_before_ready_is_an_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.close(None).await.unwrap();
    });

    let result = connect_relay(&format!("http://{address}"), "/relay/remote/s", "t").await;

    assert_eq!(result.err(), Some(RelayError::ClosedEarly));
}

#[tokio::test]
async fn text_after_ready_ends_the_link() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.send(Message::text("ready")).await.unwrap();
        socket.send(Message::text("not a frame")).await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    let mut relay = connect_relay(&format!("http://{address}"), "/relay/remote/s", "t")
        .await
        .unwrap();

    assert_eq!(
        timeout(Duration::from_secs(2), relay.recv()).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn the_relays_reason_for_ending_a_session_is_kept() {
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.send(Message::text("ready")).await.unwrap();
        socket
            .close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: "Out of data.".into(),
            }))
            .await
            .unwrap();
    });
    let mut relay = connect_relay(&format!("http://{address}"), "/relay/remote/s", "t")
        .await
        .unwrap();

    assert_eq!(
        timeout(Duration::from_secs(2), relay.recv()).await.unwrap(),
        None
    );
    assert_eq!(relay.end_reason(), Some("Out of data."));
}

#[tokio::test]
async fn closing_ends_the_link() {
    let (site, _) = echo_relay().await;
    let mut relay = connect_relay(&site, "/relay/remote/s", "t").await.unwrap();

    relay.close().await;

    assert!(relay.send(vec![1]).await.is_err());
}
