//! Signing in by scanning a QR code that a signed-in desktop app or browser shows. The phone claims
//! the code, shows the digits both screens share, and waits for the other side to approve it.

use crate::engine::{Done, Engine, Runner, Task};
use crate::secure::device_id;
use crate::view::{AuthState, QrSignInView};
use runova_api::auth::{AuthError, DeviceInfo, QrPoll, Session, read_qr_code};
use runova_crypto::handshake::os_random;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

const POLL_EVERY: Duration = Duration::from_secs(2);
/// A little over what the server gives a claim, so its answer normally ends the wait first.
const GIVE_UP_AFTER: Duration = Duration::from_secs(150);

const NOT_OURS: &str = "That isn't a Runova sign-in code.";
const NO_LONGER_VALID: &str = "This QR code is no longer valid. Show a new one and scan it again.";
const DECLINED: &str = "Sign-in was declined on the other screen.";
const FAILED: &str = "Couldn't sign in. Try again.";

enum Stop {
    Refused,
    Declined,
    Failed,
}

impl Stop {
    fn message(&self) -> &'static str {
        match self {
            Stop::Refused => NO_LONGER_VALID,
            Stop::Declined => DECLINED,
            Stop::Failed => FAILED,
        }
    }
}

fn stop_for(error: AuthError) -> Stop {
    match error {
        AuthError::SignedOut => Stop::Refused,
        _ => Stop::Failed,
    }
}

async fn wait_for_approval(session: &Session, code: &str, verifier: &str) -> Result<String, Stop> {
    let give_up = Instant::now() + GIVE_UP_AFTER;
    loop {
        match session.poll_qr(code, verifier).await {
            Ok(QrPoll::Approved(sign_in_code)) => return Ok(sign_in_code),
            Ok(QrPoll::Declined) => return Err(Stop::Declined),
            Err(AuthError::SignedOut) => return Err(Stop::Refused),
            // A dropped request is not an answer, so keep asking.
            Ok(QrPoll::Waiting) | Err(_) => {}
        }
        if Instant::now() >= give_up {
            return Err(Stop::Refused);
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

impl Runner {
    fn scan_sign_in(&mut self, text: String) {
        self.stop_qr();
        self.view.error = None;
        let Some(code) = read_qr_code(&text) else {
            self.view.error = Some(NOT_OURS.to_owned());
            return;
        };
        self.view.qr_sign_in = Some(QrSignInView { match_code: None });
        let generation = self.qr_generation;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        let session: Arc<Session> = self.deps.session.clone();
        let device = DeviceInfo {
            device_id: device_id(self.deps.secure.as_ref()),
            name: "Runova app".to_owned(),
            platform: self.deps.platform.clone(),
            app_version: self.deps.app_version.clone(),
        };
        self.qr_task = Some(tokio::spawn(async move {
            let send = |task: Task| {
                let _ = done.send(Done::Run { attempt, task });
            };
            let outcome = async {
                let claim = session
                    .claim_qr(&code, &device, &mut os_random)
                    .await
                    .map_err(stop_for)?;
                let match_code = claim.match_code.clone();
                send(Box::new(move |runner: &mut Runner| {
                    if runner.qr_generation == generation {
                        runner.view.qr_sign_in = Some(QrSignInView {
                            match_code: Some(match_code),
                        });
                    }
                }));
                let sign_in_code = wait_for_approval(&session, &code, &claim.verifier).await?;
                session
                    .complete_sign_in(&sign_in_code, &claim.verifier)
                    .await
                    .map_err(|_| Stop::Failed)
            }
            .await;
            send(Box::new(move |runner: &mut Runner| {
                if runner.qr_generation != generation {
                    return;
                }
                runner.view.qr_sign_in = None;
                runner.qr_task = None;
                match outcome {
                    Ok(()) => {
                        runner.view.auth = AuthState::SignedIn;
                        runner.boot();
                    }
                    Err(stop) => runner.view.error = Some(stop.message().to_owned()),
                }
            }));
        }));
    }

    /// Makes anything the old attempt still has on its way count for nothing.
    fn stop_qr(&mut self) {
        self.qr_generation += 1;
        self.view.qr_sign_in = None;
        if let Some(task) = self.qr_task.take() {
            task.abort();
        }
    }
}

#[uniffi::export]
impl Engine {
    /// The text of a QR code the camera read.
    pub fn scan_sign_in(&self, text: String) {
        self.run(move |runner| runner.scan_sign_in(text));
    }

    pub fn cancel_qr_sign_in(&self) {
        self.run(Runner::stop_qr);
    }
}
