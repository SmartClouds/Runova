//! An in-memory transport, for tests and the fake host.

use crate::transport::{LinkTransport, TransportClosed};
use async_trait::async_trait;
use tokio::sync::mpsc;

const CAPACITY: usize = 1024;

pub struct MemoryTransport {
    outgoing: Option<mpsc::Sender<Vec<u8>>>,
    incoming: mpsc::Receiver<Vec<u8>>,
}

/// Two ends joined together. Dropping or closing one ends the other.
pub fn memory_pair() -> (MemoryTransport, MemoryTransport) {
    let (a_out, b_in) = mpsc::channel(CAPACITY);
    let (b_out, a_in) = mpsc::channel(CAPACITY);
    (
        MemoryTransport {
            outgoing: Some(a_out),
            incoming: a_in,
        },
        MemoryTransport {
            outgoing: Some(b_out),
            incoming: b_in,
        },
    )
}

#[async_trait]
impl LinkTransport for MemoryTransport {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), TransportClosed> {
        let outgoing = self.outgoing.as_ref().ok_or(TransportClosed)?;
        outgoing.send(frame).await.map_err(|_| TransportClosed)
    }

    async fn recv(&mut self) -> Option<Vec<u8>> {
        self.incoming.recv().await
    }

    async fn close(&mut self) {
        self.outgoing = None;
    }
}
