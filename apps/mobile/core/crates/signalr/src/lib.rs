//! A SignalR client for Runova's hubs: the JSON hub protocol over one WebSocket.
//!
//! No maintained Rust client exists, and Runova needs little of the protocol: invoking hub methods,
//! hearing events, and keeping the connection alive.

pub mod client;
pub mod wire;
