//! Two real WebRTC peers joined over this computer's own network.

use runova_link::opener::Direct;
use runova_link::transport::LinkTransport;
use runova_rtc::direct::{Role, RtcDirect, RtcOptions};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

fn options() -> RtcOptions {
    RtcOptions {
        stun_servers: vec![],
        allow_loopback: true,
        gather_timeout: Duration::from_millis(50),
    }
}

/// Starts both peers with their signals crossed.
fn pair() -> (Arc<RtcDirect>, Arc<RtcDirect>) {
    let (to_answerer, mut from_controller) = mpsc::channel::<String>(64);
    let (to_controller, mut from_answerer) = mpsc::channel::<String>(64);
    let controller = Arc::new(RtcDirect::new(Role::Controller, options(), to_answerer));
    let answerer = Arc::new(RtcDirect::new(Role::Answerer, options(), to_controller));
    let target = answerer.clone();
    tokio::spawn(async move {
        while let Some(signal) = from_controller.recv().await {
            target.deliver_signal(signal).await;
        }
    });
    let target = controller.clone();
    tokio::spawn(async move {
        while let Some(signal) = from_answerer.recv().await {
            target.deliver_signal(signal).await;
        }
    });
    (controller, answerer)
}

async fn connected() -> (
    Box<dyn LinkTransport>,
    Box<dyn LinkTransport>,
    String,
    String,
) {
    let (controller, answerer) = pair();
    let (a, b) = tokio::join!(controller.connect(), answerer.connect());
    let (a, a_fp) = a.expect("the controller connects");
    let (b, b_fp) = b.expect("the answerer connects");
    assert_eq!(a_fp.local, b_fp.remote);
    assert_eq!(a_fp.remote, b_fp.local);
    assert!(a_fp.local.starts_with("sha-256 "));
    (a, b, a_fp.local, b_fp.local)
}

#[tokio::test(flavor = "multi_thread")]
async fn two_peers_open_the_channel_and_frames_cross_both_ways() {
    let (mut a, mut b, _, _) = timeout(Duration::from_secs(20), connected()).await.unwrap();

    a.send(vec![1, 2, 3]).await.unwrap();
    b.send(vec![9, 8]).await.unwrap();

    assert_eq!(
        timeout(Duration::from_secs(5), b.recv()).await.unwrap(),
        Some(vec![1, 2, 3])
    );
    assert_eq!(
        timeout(Duration::from_secs(5), a.recv()).await.unwrap(),
        Some(vec![9, 8])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn many_large_frames_arrive_in_order_and_whole() {
    let (mut a, mut b, _, _) = timeout(Duration::from_secs(20), connected()).await.unwrap();
    let frames: Vec<Vec<u8>> = (0u8..64).map(|n| vec![n; 60 * 1024]).collect();

    let sent = frames.clone();
    tokio::spawn(async move {
        for frame in sent {
            a.send(frame).await.unwrap();
        }
        // Keeps the sender alive until everything has been read.
        tokio::time::sleep(Duration::from_secs(30)).await;
    });

    for expected in frames {
        let frame = timeout(Duration::from_secs(10), b.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame, expected);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_one_side_ends_the_other() {
    let (mut a, mut b, _, _) = timeout(Duration::from_secs(20), connected()).await.unwrap();

    a.close().await;

    assert_eq!(
        timeout(Duration::from_secs(20), b.recv()).await.unwrap(),
        None
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_before_an_answer_stops_waiting() {
    let (signals, _kept) = mpsc::channel::<String>(8);
    let controller = Arc::new(RtcDirect::new(Role::Controller, options(), signals));
    let waiting = controller.clone();
    let attempt = tokio::spawn(async move { waiting.connect().await.map(|_| ()) });
    tokio::time::sleep(Duration::from_millis(200)).await;

    controller.cancel().await;

    let result = timeout(Duration::from_secs(2), attempt)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
}
