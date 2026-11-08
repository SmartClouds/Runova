//! The one thing the core asks of HTTP, behind a trait so tests never need a network.

use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
use thiserror::Error;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("{0}")]
pub struct HttpError(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn post_json(&self, url: &str, body: Value) -> Result<HttpReply, HttpError>;
}

pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| HttpError(e.to_string()))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn post_json(&self, url: &str, body: Value) -> Result<HttpReply, HttpError> {
        let response = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| HttpError(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|e| HttpError(e.to_string()))?;
        Ok(HttpReply { status, body })
    }
}
