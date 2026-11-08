//! What native code sees of the Rust core, and the only crate UniFFI generates bindings for.

use runova_api::auth::{AuthError, DeviceInfo, begin_sign_in, read_callback};
use runova_crypto::handshake::os_random;
use thiserror::Error;

pub mod account;
pub mod backend;
pub mod core;
pub mod deploy;
pub mod engine;
pub mod git;
pub(crate) mod labels;
pub mod notifications;
pub mod ops;
pub mod palette;
pub mod secure;
pub mod status;
pub(crate) mod terminals;
pub mod vault;
pub mod view;

uniffi::setup_scaffolding!();

#[derive(Debug, Error, Clone, PartialEq, Eq, uniffi::Error)]
pub enum CoreError {
    #[error("sign-in was declined in the browser")]
    SignInDeclined,
    #[error("that sign-in link is not valid")]
    SignInInvalid,
    #[error("the app core could not start")]
    StartFailed,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct DeviceDetails {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SignInLink {
    pub url: String,
    pub verifier: String,
    pub state: String,
}

#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// The link to open in the system browser, and what to keep until it comes back.
#[uniffi::export]
pub fn begin_phone_sign_in(site: String, device: DeviceDetails) -> SignInLink {
    let info = DeviceInfo {
        device_id: device.device_id,
        name: device.name,
        platform: device.platform,
        app_version: device.app_version,
    };
    let request = begin_sign_in(&site, &info, &mut os_random);
    SignInLink {
        url: request.url,
        verifier: request.verifier,
        state: request.state,
    }
}

/// The code from the link the browser came back with.
#[uniffi::export]
pub fn finish_browser_callback(url: String, expected_state: String) -> Result<String, CoreError> {
    read_callback(&url, &expected_state).map_err(|error| match error {
        AuthError::Declined => CoreError::SignInDeclined,
        _ => CoreError::SignInInvalid,
    })
}
