//! The object native code holds. It owns the small runtime everything runs on.

use crate::backend::LiveBackend;
use crate::engine::{AppLifecycle, Dependencies, Engine, HubConnector};
use crate::secure::{SecureStore, SecureTokens};
use crate::view::ViewListener;
use crate::{CoreError, SignInLink};
use async_trait::async_trait;
use runova_api::auth::Session;
use runova_api::http::ReqwestTransport;
use runova_session::hub::{HubEvent, HubPort, RemoteHub, read_event};
use runova_session::live::LiveTransports;
use runova_signalr::client::{HubClient, HubOptions, hub_url};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

const HUB_EVENTS: usize = 256;
/// Two workers: enough for a phone, and small on memory.
const WORKERS: usize = 2;

#[derive(Debug, Clone, uniffi::Record)]
pub struct CoreConfig {
    pub site: String,
    pub platform: String,
    pub app_version: String,
}

struct LiveHub {
    site: String,
}

#[async_trait]
impl HubConnector for LiveHub {
    async fn connect(
        &self,
        token: String,
    ) -> Result<(Arc<dyn HubPort>, mpsc::Receiver<HubEvent>), String> {
        let url = hub_url(&self.site, "/hubs/remote");
        let (client, mut raw) = HubClient::connect(&url, &token, HubOptions::default())
            .await
            .map_err(|e| e.to_string())?;
        let (events, queue) = mpsc::channel(HUB_EVENTS);
        tokio::spawn(async move {
            while let Some(event) = raw.recv().await {
                if let Some(event) = read_event(&event)
                    && events.send(event).await.is_err()
                {
                    break;
                }
            }
        });
        Ok((Arc::new(RemoteHub(client)), queue))
    }
}

#[derive(uniffi::Object)]
pub struct RunovaCore {
    runtime: Runtime,
    engine: Engine,
}

#[uniffi::export]
impl RunovaCore {
    #[uniffi::constructor]
    pub fn new(
        config: CoreConfig,
        secure: Arc<dyn SecureStore>,
        listener: Arc<dyn ViewListener>,
    ) -> Result<Arc<Self>, CoreError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(WORKERS)
            .enable_all()
            .build()
            .map_err(|_| CoreError::StartFailed)?;
        let http = ReqwestTransport::new().map_err(|_| CoreError::StartFailed)?;
        let session = Arc::new(Session::new(
            &config.site,
            Arc::new(http),
            Arc::new(SecureTokens(secure.clone())),
            Box::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs())
            }),
        ));
        let backend = LiveBackend::new(config.site.clone(), session.clone())
            .map_err(|_| CoreError::StartFailed)?;
        let engine = {
            let _inside = runtime.enter();
            Engine::start(Dependencies {
                site: config.site.clone(),
                platform: config.platform,
                app_version: config.app_version,
                secure,
                listener,
                session,
                backend: Arc::new(backend),
                hub: Arc::new(LiveHub {
                    site: config.site.clone(),
                }),
                transports: Arc::new(LiveTransports { site: config.site }),
            })
        };
        Ok(Arc::new(Self { runtime, engine }))
    }

    pub fn begin_sign_in(&self, device_name: String) -> SignInLink {
        let _inside = self.runtime.enter();
        let request = self.engine.begin_sign_in(device_name);
        SignInLink {
            url: request.url,
            verifier: request.verifier,
            state: request.state,
        }
    }

    pub fn finish_sign_in(&self, url: String) {
        self.engine.finish_sign_in(url);
    }

    pub fn refresh(&self) {
        self.engine.refresh();
    }

    pub fn connect(&self, system_id: i64) {
        self.engine.connect(system_id);
    }

    pub fn disconnect(&self) {
        self.engine.disconnect();
    }

    pub fn lifecycle(&self, change: AppLifecycle) {
        self.engine.lifecycle(change);
    }

    pub fn sign_out(&self) {
        self.engine.sign_out();
    }
}
