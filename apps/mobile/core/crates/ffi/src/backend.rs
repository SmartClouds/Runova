//! What the app asks the website directly.

use async_trait::async_trait;
use runova_api::auth::{AuthError, Session};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum BackendError {
    #[error("signed out")]
    SignedOut,
    #[error("{0}")]
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneRegistration {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub identity_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemEntry {
    pub id: i64,
    pub remote_id: String,
    pub name: String,
    pub platform: String,
    pub kind: String,
    pub online: bool,
    pub own: bool,
}

#[async_trait]
pub trait Backend: Send + Sync {
    async fn register_phone(&self, phone: PhoneRegistration) -> Result<i64, BackendError>;
    async fn systems(&self) -> Result<Vec<SystemEntry>, BackendError>;

    /// Any read from the website's API, for screens that talk to it directly.
    async fn get_json(&self, _path: &str) -> Result<Value, BackendError> {
        Err(BackendError::Failed("Not available.".to_owned()))
    }

    /// Any change. `method` is an HTTP verb and an empty answer reads as null.
    async fn send_json(
        &self,
        _method: &str,
        _path: &str,
        _body: Value,
    ) -> Result<Value, BackendError> {
        Err(BackendError::Failed("Not available.".to_owned()))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryDto {
    id: i64,
    remote_id: String,
    name: String,
    platform: String,
    kind: String,
    online: bool,
}

#[derive(Deserialize)]
struct DirectoryDto {
    mine: Vec<EntryDto>,
    teammates: Vec<EntryDto>,
}

#[derive(Deserialize)]
struct RegisteredDto {
    id: i64,
}

pub struct LiveBackend {
    site: String,
    session: Arc<Session>,
    client: reqwest::Client,
}

fn failed(error: impl ToString) -> BackendError {
    BackendError::Failed(error.to_string())
}

impl LiveBackend {
    pub fn new(site: String, session: Arc<Session>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            site: site.trim_end_matches('/').to_owned(),
            session,
            client,
        })
    }

    async fn token(&self) -> Result<String, BackendError> {
        self.session
            .access_token()
            .await
            .map_err(|error| match error {
                AuthError::SignedOut => BackendError::SignedOut,
                other => failed(other),
            })
    }

    async fn read(&self, response: reqwest::Response) -> Result<Value, BackendError> {
        match response.status().as_u16() {
            401 => Err(BackendError::SignedOut),
            204 => Ok(Value::Null),
            200..=299 => response.json().await.map_err(failed),
            status => Err(failed(format!("Runova answered {status}."))),
        }
    }
}

#[async_trait]
impl Backend for LiveBackend {
    async fn register_phone(&self, phone: PhoneRegistration) -> Result<i64, BackendError> {
        let response = self
            .client
            .post(format!("{}/api/v1/remote-devices", self.site))
            .bearer_auth(self.token().await?)
            .json(&json!({
                "deviceId": phone.device_id,
                "name": phone.name,
                "platform": phone.platform,
                "identityKey": phone.identity_key,
            }))
            .send()
            .await
            .map_err(failed)?;
        let dto: RegisteredDto =
            serde_json::from_value(self.read(response).await?).map_err(failed)?;
        Ok(dto.id)
    }

    async fn get_json(&self, path: &str) -> Result<Value, BackendError> {
        let response = self
            .client
            .get(format!("{}{path}", self.site))
            .bearer_auth(self.token().await?)
            .send()
            .await
            .map_err(failed)?;
        self.read(response).await
    }

    async fn send_json(
        &self,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, BackendError> {
        let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(failed)?;
        let response = self
            .client
            .request(verb, format!("{}{path}", self.site))
            .bearer_auth(self.token().await?)
            // The server refuses a change with no version unless it is told any version will do.
            .header("if-match", "*")
            .json(&body)
            .header(
                reqwest::header::CONTENT_TYPE,
                if method == "PATCH" {
                    "application/merge-patch+json"
                } else {
                    "application/json"
                },
            )
            .send()
            .await
            .map_err(failed)?;
        self.read(response).await
    }

    async fn systems(&self) -> Result<Vec<SystemEntry>, BackendError> {
        let response = self
            .client
            .get(format!("{}/api/v1/reachable-devices", self.site))
            .bearer_auth(self.token().await?)
            .send()
            .await
            .map_err(failed)?;
        let dto: DirectoryDto =
            serde_json::from_value(self.read(response).await?).map_err(failed)?;
        let entry = |own: bool| {
            move |e: EntryDto| SystemEntry {
                id: e.id,
                remote_id: e.remote_id,
                name: e.name,
                platform: e.platform,
                kind: e.kind,
                online: e.online,
                own,
            }
        };
        let mut systems: Vec<_> = dto.mine.into_iter().map(entry(true)).collect();
        systems.extend(dto.teammates.into_iter().map(entry(false)));
        Ok(systems)
    }
}
