//! The remote hub, as this crate needs it.

use async_trait::async_trait;
use runova_signalr::client::{HubClient, HubEvent as RawEvent};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInfo {
    pub name: String,
    pub identity_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectResult {
    pub status: String,
    pub session_id: Option<String>,
    pub host: Option<HostInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RelayTicket {
    pub path: String,
    pub ticket: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubEvent {
    Resolved {
        session_id: String,
        accepted: bool,
        reason: Option<String>,
    },
    Signal {
        session_id: String,
        payload: String,
    },
    Ended {
        session_id: String,
        reason: String,
    },
    Presence {
        device_id: i64,
        online: bool,
    },
}

#[async_trait]
pub trait HubPort: Send + Sync {
    async fn request_connect(
        &self,
        remote_id: &str,
        device_id: i64,
    ) -> Result<ConnectResult, String>;
    async fn signal(&self, session_id: &str, payload: &str);
    async fn relay_ticket(&self, session_id: &str) -> Result<RelayTicket, String>;
    async fn end(&self, session_id: &str);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResultDto {
    status: String,
    session_id: Option<String>,
    host: Option<HostDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostDto {
    name: String,
    identity_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedDto {
    session_id: String,
    accepted: bool,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndedDto {
    session_id: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceDto {
    device_id: i64,
    online: bool,
}

/// The event, or `None` for one this app does not use.
pub fn read_event(event: &RawEvent) -> Option<HubEvent> {
    let first = || event.arguments.first().cloned();
    match event.target.as_str() {
        "RequestResolved" => {
            let dto: ResolvedDto = serde_json::from_value(first()?).ok()?;
            Some(HubEvent::Resolved {
                session_id: dto.session_id,
                accepted: dto.accepted,
                reason: dto.reason,
            })
        }
        "Signal" => Some(HubEvent::Signal {
            session_id: event.arguments.first()?.as_str()?.to_owned(),
            payload: event.arguments.get(1)?.as_str()?.to_owned(),
        }),
        "SessionEnded" => {
            let dto: EndedDto = serde_json::from_value(first()?).ok()?;
            Some(HubEvent::Ended {
                session_id: dto.session_id,
                reason: dto.reason,
            })
        }
        "PresenceChanged" => {
            let dto: PresenceDto = serde_json::from_value(first()?).ok()?;
            Some(HubEvent::Presence {
                device_id: dto.device_id,
                online: dto.online,
            })
        }
        _ => None,
    }
}

/// The real hub, over a connected SignalR client.
pub struct RemoteHub(pub HubClient);

#[async_trait]
impl HubPort for RemoteHub {
    async fn request_connect(
        &self,
        remote_id: &str,
        device_id: i64,
    ) -> Result<ConnectResult, String> {
        let request = json!({
            "remoteId": remote_id,
            "mode": "ask",
            "controllerDeviceId": device_id,
            "intent": "manage",
        });
        let answer = self
            .0
            .invoke("RequestConnect", vec![request])
            .await
            .map_err(|e| e.to_string())?;
        let dto: ConnectResultDto = serde_json::from_value(answer).map_err(|e| e.to_string())?;
        Ok(ConnectResult {
            status: dto.status,
            session_id: dto.session_id,
            host: dto.host.map(|host| HostInfo {
                name: host.name,
                identity_key: host.identity_key,
            }),
        })
    }

    async fn signal(&self, session_id: &str, payload: &str) {
        let arguments = vec![Value::from(session_id), Value::from(payload)];
        let _ = self.0.invoke("Signal", arguments).await;
    }

    async fn relay_ticket(&self, session_id: &str) -> Result<RelayTicket, String> {
        let answer = self
            .0
            .invoke("CreateRelayTicket", vec![Value::from(session_id)])
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_value(answer).map_err(|e| e.to_string())
    }

    async fn end(&self, session_id: &str) {
        let _ = self.0.invoke("End", vec![Value::from(session_id)]).await;
    }
}
