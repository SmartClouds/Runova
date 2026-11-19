//! Signing in with the system's own Google or Apple sheet (E117): Google through Credential
//! Manager on Android, Sign in with Apple on iOS. The core asks the server for a nonce and puts it
//! in the view; the app shows the sheet for it once and hands back the ID token, which the core
//! trades for tokens. An account with two-step sign-in is sent on to the browser sign-in for that
//! provider, which asks for the code.

use crate::engine::{Done, Engine, Runner, Task};
use crate::secure::device_id;
use crate::view::{AuthState, ProviderSignInView};
use runova_api::auth::{AuthError, DeviceInfo, Session};
use std::sync::Arc;

/// The provider's name for people.
fn label(provider: &str) -> &str {
    match provider {
        "google" => "Google",
        "apple" => "Apple",
        "microsoft" => "Microsoft",
        other => other,
    }
}

fn message(provider: &str, error: &AuthError) -> String {
    let name = label(provider);
    match error {
        AuthError::ProviderOff => format!("Signing in with {name} isn't available right now."),
        AuthError::ProviderRefused => {
            format!("{name} sign-in wasn't accepted. Try again, or sign in another way.")
        }
        AuthError::LinkNeeded => format!(
            "An account with this email already exists. Sign in with its password, then link {name} under Security on the website."
        ),
        AuthError::EmailUnverified => {
            format!("{name} hasn't confirmed this email address, so Runova can't use it.")
        }
        AuthError::ContinueInBrowser => {
            "Two-step sign-in is on for this account. Finish signing in in the browser.".to_owned()
        }
        _ => "Couldn't sign in. Try again.".to_owned(),
    }
}

impl Runner {
    fn begin_provider_sign_in(&mut self, provider: String) {
        self.stop_provider_sign_in();
        self.view.error = None;
        self.view.continue_in_browser = None;
        self.view.provider_sign_in = Some(ProviderSignInView {
            provider: provider.clone(),
            nonce: None,
            client_id: None,
        });
        let generation = self.provider_generation;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        let session: Arc<Session> = self.deps.session.clone();
        self.provider_task = Some(tokio::spawn(async move {
            let nonce = session.begin_provider_sign_in(&provider).await;
            let task: Task = Box::new(move |runner: &mut Runner| {
                if runner.provider_generation != generation {
                    return;
                }
                runner.provider_task = None;
                match nonce {
                    Ok(nonce) => {
                        runner.view.provider_sign_in = Some(ProviderSignInView {
                            provider: nonce.provider,
                            nonce: Some(nonce.nonce),
                            client_id: nonce.client_id,
                        });
                    }
                    Err(error) => {
                        runner.view.provider_sign_in = None;
                        runner.view.error = Some(match error {
                            AuthError::ProviderOff => message(&provider, &error),
                            _ => format!(
                                "Couldn't start signing in with {}. Check the connection and try again.",
                                label(&provider)
                            ),
                        });
                    }
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        }));
    }

    fn finish_provider_sign_in(
        &mut self,
        nonce: String,
        id_token: String,
        authorization_code: Option<String>,
        name: Option<String>,
    ) {
        let provider = match self.view.provider_sign_in.as_ref() {
            Some(sheet) if sheet.nonce.as_deref() == Some(nonce.as_str()) => sheet.provider.clone(),
            _ => {
                // A token from a sheet this phone has moved on from.
                self.stop_provider_sign_in();
                return;
            }
        };
        self.stop_provider_sign_in();
        let generation = self.provider_generation;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        let session: Arc<Session> = self.deps.session.clone();
        let device = DeviceInfo {
            device_id: device_id(self.deps.secure.as_ref()),
            name: "Runova app".to_owned(),
            platform: self.deps.platform.clone(),
            app_version: self.deps.app_version.clone(),
        };
        self.provider_task = Some(tokio::spawn(async move {
            let outcome = session
                .finish_provider_sign_in(
                    &provider,
                    &nonce,
                    &id_token,
                    authorization_code.as_deref(),
                    name.as_deref(),
                    &device,
                )
                .await;
            let task: Task = Box::new(move |runner: &mut Runner| {
                if runner.provider_generation != generation {
                    return;
                }
                runner.provider_task = None;
                match outcome {
                    Ok(()) => {
                        runner.view.auth = AuthState::SignedIn;
                        runner.boot();
                    }
                    Err(error) => {
                        if error == AuthError::ContinueInBrowser {
                            runner.view.continue_in_browser = Some(provider.clone());
                        }
                        runner.view.error = Some(message(&provider, &error));
                    }
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        }));
    }

    /// Makes anything the old attempt still has on its way count for nothing.
    fn stop_provider_sign_in(&mut self) {
        self.provider_generation += 1;
        self.view.provider_sign_in = None;
        if let Some(task) = self.provider_task.take() {
            task.abort();
        }
    }
}

#[uniffi::export]
impl Engine {
    /// Asks for a nonce for `provider` (`google` or `apple`). Once `provider_sign_in.nonce` is in
    /// the view, show that provider's sheet for it, once per nonce.
    pub fn begin_provider_sign_in(&self, provider: String) {
        self.run(move |runner| runner.begin_provider_sign_in(provider));
    }

    /// The sheet's answer: the ID token, and from Apple the authorization code and, the first time
    /// only, the person's name.
    pub fn finish_provider_sign_in(
        &self,
        nonce: String,
        id_token: String,
        authorization_code: Option<String>,
        name: Option<String>,
    ) {
        self.run(move |runner| {
            runner.finish_provider_sign_in(nonce, id_token, authorization_code, name)
        });
    }

    /// The sheet closed without an answer.
    pub fn cancel_provider_sign_in(&self) {
        self.run(Runner::stop_provider_sign_in);
    }
}
