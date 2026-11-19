//! Signing in with a passkey (E115). The core asks the server for a challenge and puts it in the
//! view; the app shows the platform's passkey prompt for it (Credential Manager on Android,
//! AuthenticationServices on iOS) and hands back the answer, which the core trades for tokens. A
//! passkey checks the fingerprint, face or PIN itself, so no two-factor code follows.

use crate::engine::{Done, Engine, Runner, Task};
use crate::secure::device_id;
use crate::view::{AuthState, PasskeySignInView};
use runova_api::auth::{AuthError, DeviceInfo, Session};
use std::sync::Arc;

const NO_CHALLENGE: &str = "Couldn't start a passkey sign-in. Check the connection and try again.";
const REFUSED: &str = "That passkey wasn't accepted. Try again, or sign in another way.";
const FAILED: &str = "Couldn't sign in. Try again.";
const NO_PASSKEY: &str = "This phone has no passkey for Runova. Add one on the website's Security page, or sign in another way.";

impl Runner {
    fn begin_passkey_sign_in(&mut self) {
        self.stop_passkey();
        self.view.error = None;
        self.view.passkey_sign_in = Some(PasskeySignInView {
            challenge_id: String::new(),
            options_json: None,
        });
        let generation = self.passkey_generation;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        let session: Arc<Session> = self.deps.session.clone();
        self.passkey_task = Some(tokio::spawn(async move {
            let challenge = session.begin_passkey_sign_in().await;
            let task: Task = Box::new(move |runner: &mut Runner| {
                if runner.passkey_generation != generation {
                    return;
                }
                runner.passkey_task = None;
                match challenge {
                    Ok(challenge) => {
                        runner.view.passkey_sign_in = Some(PasskeySignInView {
                            challenge_id: challenge.id,
                            options_json: Some(challenge.options_json),
                        });
                    }
                    Err(_) => {
                        runner.view.passkey_sign_in = None;
                        runner.view.error = Some(NO_CHALLENGE.to_owned());
                    }
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        }));
    }

    fn finish_passkey_sign_in(&mut self, challenge_id: String, credential_json: String) {
        let current = self
            .view
            .passkey_sign_in
            .as_ref()
            .is_some_and(|p| p.options_json.is_some() && p.challenge_id == challenge_id);
        if !current {
            // An answer to a prompt this phone has moved on from.
            self.stop_passkey();
            return;
        }
        self.stop_passkey();
        let generation = self.passkey_generation;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        let session: Arc<Session> = self.deps.session.clone();
        let device = DeviceInfo {
            device_id: device_id(self.deps.secure.as_ref()),
            name: "Runova app".to_owned(),
            platform: self.deps.platform.clone(),
            app_version: self.deps.app_version.clone(),
        };
        self.passkey_task = Some(tokio::spawn(async move {
            let outcome = session
                .finish_passkey_sign_in(&challenge_id, &credential_json, &device)
                .await;
            let task: Task = Box::new(move |runner: &mut Runner| {
                if runner.passkey_generation != generation {
                    return;
                }
                runner.passkey_task = None;
                match outcome {
                    Ok(()) => {
                        runner.view.auth = AuthState::SignedIn;
                        runner.boot();
                    }
                    Err(AuthError::PasskeyRefused) => {
                        runner.view.error = Some(REFUSED.to_owned());
                    }
                    Err(_) => runner.view.error = Some(FAILED.to_owned()),
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        }));
    }

    fn cancel_passkey_sign_in(&mut self, no_passkey: bool) {
        self.stop_passkey();
        if no_passkey {
            self.view.error = Some(NO_PASSKEY.to_owned());
        }
    }

    /// Makes anything the old attempt still has on its way count for nothing.
    fn stop_passkey(&mut self) {
        self.passkey_generation += 1;
        self.view.passkey_sign_in = None;
        if let Some(task) = self.passkey_task.take() {
            task.abort();
        }
    }
}

#[uniffi::export]
impl Engine {
    /// Asks for a passkey challenge. Once `passkey_sign_in.options_json` is in the view, show the
    /// platform's prompt for it.
    pub fn begin_passkey_sign_in(&self) {
        self.run(Runner::begin_passkey_sign_in);
    }

    /// The prompt's answer, as the WebAuthn JSON the platform returns.
    pub fn finish_passkey_sign_in(&self, challenge_id: String, credential_json: String) {
        self.run(move |runner| runner.finish_passkey_sign_in(challenge_id, credential_json));
    }

    /// The prompt closed without an answer. `no_passkey` when the platform had no passkey for
    /// Runova to offer, which the app then explains.
    pub fn cancel_passkey_sign_in(&self, no_passkey: bool) {
        self.run(move |runner| runner.cancel_passkey_sign_in(no_passkey));
    }
}
