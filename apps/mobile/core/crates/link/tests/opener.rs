//! Direct first, then the relay, with the desktop's timing.

use async_trait::async_trait;
use runova_link::opener::{
    DIRECT_TIMEOUT, Direct, LinkKind, OpenError, Relay, RelaySignal, open_link,
};
use runova_link::testing::memory_pair;
use runova_link::transport::{Fingerprints, LinkTransport};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Default)]
struct FakeDirect {
    delay: Option<Duration>,
    fails: bool,
    cancelled: AtomicU32,
}

#[async_trait]
impl Direct for FakeDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        match self.delay {
            None if self.fails => Err("the connection failed".into()),
            None => std::future::pending().await,
            Some(delay) => {
                tokio::time::sleep(delay).await;
                let (a, _b) = memory_pair();
                Ok((
                    Box::new(a),
                    Fingerprints {
                        local: "sha-256 AA".into(),
                        remote: "sha-256 BB".into(),
                    },
                ))
            }
        }
    }

    async fn cancel(&self) {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeRelay {
    calls: AtomicU32,
    fails: bool,
}

#[async_trait]
impl Relay for FakeRelay {
    async fn connect(&self) -> Result<Box<dyn LinkTransport>, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fails {
            return Err("no relay".into());
        }
        let (a, _b) = memory_pair();
        Ok(Box::new(a))
    }
}

#[derive(Default)]
struct RecordingSignal {
    sent: Mutex<Vec<String>>,
}

#[async_trait]
impl RelaySignal for RecordingSignal {
    async fn tell_other_side(&self, payload: &str) {
        self.sent.lock().await.push(payload.to_owned());
    }
}

fn direct_after(seconds: u64) -> FakeDirect {
    FakeDirect {
        delay: Some(Duration::from_secs(seconds)),
        ..FakeDirect::default()
    }
}

#[tokio::test(start_paused = true)]
async fn a_direct_link_in_time_is_used_and_the_relay_is_left_alone() {
    let (direct, relay, signal) = (
        direct_after(2),
        FakeRelay::default(),
        RecordingSignal::default(),
    );

    let link = open_link(&direct, &relay, &signal, false).await.unwrap();

    assert_eq!(link.kind, LinkKind::Direct);
    assert_eq!(link.fingerprints.local, "sha-256 AA");
    assert_eq!(relay.calls.load(Ordering::SeqCst), 0);
    assert!(signal.sent.lock().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn after_eight_seconds_it_moves_to_the_relay_and_tells_the_computer() {
    let (direct, relay, signal) = (
        FakeDirect::default(),
        FakeRelay::default(),
        RecordingSignal::default(),
    );
    let started = tokio::time::Instant::now();

    let link = open_link(&direct, &relay, &signal, false).await.unwrap();

    assert_eq!(started.elapsed(), DIRECT_TIMEOUT);
    assert_eq!(DIRECT_TIMEOUT, Duration::from_secs(8));
    assert_eq!(link.kind, LinkKind::Relay);
    assert_eq!(link.fingerprints.local, "");
    assert_eq!(link.fingerprints.remote, "");
    assert_eq!(
        *signal.sent.lock().await,
        vec!["{\"k\":\"relay\"}".to_owned()]
    );
    assert_eq!(direct.cancelled.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_direct_failure_moves_to_the_relay_at_once() {
    let direct = FakeDirect {
        fails: true,
        ..FakeDirect::default()
    };
    let (relay, signal) = (FakeRelay::default(), RecordingSignal::default());
    let started = tokio::time::Instant::now();

    let link = open_link(&direct, &relay, &signal, false).await.unwrap();

    assert_eq!(started.elapsed(), Duration::ZERO);
    assert_eq!(link.kind, LinkKind::Relay);
}

#[tokio::test(start_paused = true)]
async fn relay_only_skips_the_direct_attempt() {
    let (direct, relay, signal) = (
        direct_after(1),
        FakeRelay::default(),
        RecordingSignal::default(),
    );

    let link = open_link(&direct, &relay, &signal, true).await.unwrap();

    assert_eq!(link.kind, LinkKind::Relay);
    assert_eq!(
        *signal.sent.lock().await,
        vec!["{\"k\":\"relay\"}".to_owned()]
    );
}

#[tokio::test(start_paused = true)]
async fn when_neither_works_it_says_so() {
    let direct = FakeDirect {
        fails: true,
        ..FakeDirect::default()
    };
    let relay = FakeRelay {
        fails: true,
        ..FakeRelay::default()
    };
    let signal = RecordingSignal::default();

    let result = open_link(&direct, &relay, &signal, false).await;

    assert_eq!(
        result.err(),
        Some(OpenError::Unreachable("no relay".into()))
    );
}
