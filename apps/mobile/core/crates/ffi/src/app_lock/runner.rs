//! The app lock inside the engine: the secure store, lifecycle, biometrics and the intents native
//! code sends. Checking a code runs scrypt, so it happens off the engine's own task.

use super::{
    AutoLock, BiometricKind, BiometricUse, Capability, Code, Entry, LockSettings, PasscodeKind,
    SETTINGS_KEY, Setup, SetupOutcome, StoredTries, TRIES_KEY, Tries, biometric_use, locks_after,
    wait_label,
};
use crate::app_lock_view::{
    AutoLockChoice, LockScreen, PasscodeEntryView, PasscodeSettingsScreen, PasscodeStep,
};
use crate::engine::{Done, Engine, Runner};
use crate::view::BiometricRequestView;
use runova_crypto::handshake::os_random;
use runova_crypto::passcode::{hash_passcode, verify_passcode};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;

const WRONG_CODE: &str = "Wrong passcode. Try again.";
const WRONG_PASSWORD: &str = "Wrong password. Try again.";
const MISMATCH: &str = "Those didn't match. Try again.";
const TOO_SHORT: &str = "Use at least 4 characters.";

/// Everything the lock keeps between intents. The views are rebuilt from it by `show_lock`.
#[derive(Default)]
pub(crate) struct LockState {
    settings: Option<LockSettings>,
    tries: Tries,
    capability: Capability,
    locked: bool,
    /// When the app left the screen, for auto-lock.
    away_since: Option<Instant>,
    /// Biometrics were already offered for this time on the lock screen.
    offered: bool,
    entry: Entry,
    error: Option<String>,
    shake: u64,
    busy: bool,
    request: Option<BiometricRequestView>,
    confirm_forgot: bool,
    ticking: bool,
    settings_open: bool,
    step: PasscodeStep,
    setup: Option<Setup>,
    settings_entry: Entry,
    settings_error: Option<String>,
    settings_shake: u64,
}

/// What a checked code was for.
#[derive(Clone, Copy)]
enum Check {
    Unlock,
    Settings,
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn ceil_seconds(wait: Duration) -> u32 {
    let whole = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
    u32::try_from(whole).unwrap_or(u32::MAX)
}

fn wrong(kind: PasscodeKind) -> &'static str {
    if kind == PasscodeKind::Password {
        WRONG_PASSWORD
    } else {
        WRONG_CODE
    }
}

fn noun(kind: PasscodeKind) -> &'static str {
    if kind == PasscodeKind::Password {
        "password"
    } else {
        "passcode"
    }
}

impl Runner {
    /// Reads the lock before the first view goes out, so a cold start never shows what it guards.
    pub(crate) fn load_app_lock(&mut self) {
        let secure = &self.deps.secure;
        let settings = secure
            .get(SETTINGS_KEY.to_owned())
            .and_then(|json| LockSettings::parse(&json));
        let tries = secure
            .get(TRIES_KEY.to_owned())
            .and_then(|json| serde_json::from_str::<StoredTries>(&json).ok())
            .map(|stored| Tries::from_stored(&stored, Instant::now(), wall_ms()))
            .unwrap_or_default();
        let lock = &mut self.app_lock;
        lock.tries = tries;
        if let Some(settings) = &settings {
            lock.locked = true;
            lock.entry = Entry::new(settings.kind);
        }
        lock.settings = settings;
        self.tick_wait();
        self.show_lock();
    }

    pub(crate) fn app_lock_backgrounded(&mut self) {
        let lock = &mut self.app_lock;
        lock.away_since = Some(Instant::now());
        lock.offered = false;
        lock.request = None;
        let immediately = lock
            .settings
            .as_ref()
            .is_some_and(|s| s.auto_lock == AutoLock::Immediately);
        if immediately {
            self.lock();
        }
        self.show_lock();
    }

    pub(crate) fn app_lock_foregrounded(&mut self) {
        let away = self.app_lock.away_since.take().map(|at| at.elapsed());
        let due = match (&self.app_lock.settings, away) {
            (Some(settings), Some(away)) => locks_after(settings.auto_lock, away),
            _ => false,
        };
        if due {
            self.lock();
        }
        self.offer_biometric();
        self.show_lock();
    }

    fn lock(&mut self) {
        let Some(kind) = self.app_lock.settings.as_ref().map(|s| s.kind) else {
            return;
        };
        let lock = &mut self.app_lock;
        lock.locked = true;
        lock.entry = Entry::new(kind);
        lock.error = None;
        lock.request = None;
        lock.confirm_forgot = false;
        lock.settings_open = false;
        lock.setup = None;
        // Nothing the lock covers may ask for the phone's check behind it.
        self.forget_secret();
        self.view.vault.biometric = None;
        self.pending_reveal = None;
        self.drop_cloudflare_check();
    }

    fn unlock(&mut self) {
        let lock = &mut self.app_lock;
        lock.locked = false;
        lock.error = None;
        lock.request = None;
        lock.confirm_forgot = false;
        lock.entry.clear();
        lock.tries.succeeded();
        self.save_tries();
    }

    /// Puts up the phone's check on the lock screen, once each time it comes up.
    fn offer_biometric(&mut self) {
        let lock = &mut self.app_lock;
        if !lock.locked || lock.offered || lock.confirm_forgot {
            return;
        }
        let Some(settings) = lock.settings.as_mut() else {
            return;
        };
        match biometric_use(settings, &lock.capability) {
            BiometricUse::Off => {}
            BiometricUse::Usable => {
                lock.offered = true;
                self.biometric_serial = self.biometric_serial.wrapping_add(1);
                lock.request = Some(BiometricRequestView {
                    id: self.biometric_serial,
                    reason: "Unlock Runova".to_owned(),
                });
            }
            BiometricUse::Changed => {
                settings.biometric = false;
                settings.biometric_enrollment = None;
                lock.error = Some(format!(
                    "{} changed on this phone. Enter your {} to turn it back on.",
                    lock.capability.name,
                    noun(settings.kind)
                ));
                self.save_settings();
            }
        }
    }

    /// True when `id` was the lock's own check.
    pub(crate) fn app_lock_biometric_result(&mut self, id: u64, confirmed: bool) -> bool {
        if self.app_lock.request.as_ref().map(|r| r.id) != Some(id) {
            return false;
        }
        self.app_lock.request = None;
        if confirmed && self.app_lock.locked {
            self.unlock();
        }
        self.show_lock();
        true
    }

    /// The whole lock was removed, by the user or because the phone signed out.
    pub(crate) fn remove_app_lock(&mut self) {
        self.deps.secure.remove(SETTINGS_KEY.to_owned());
        self.deps.secure.remove(TRIES_KEY.to_owned());
        let capability = std::mem::take(&mut self.app_lock.capability);
        self.app_lock = LockState {
            capability,
            ..LockState::default()
        };
        self.show_lock();
    }

    fn save_settings(&self) {
        if let Some(settings) = &self.app_lock.settings {
            self.deps
                .secure
                .set(SETTINGS_KEY.to_owned(), settings.to_json());
        }
    }

    fn save_tries(&self) {
        let tries = &self.app_lock.tries;
        if tries.failures == 0 {
            self.deps.secure.remove(TRIES_KEY.to_owned());
        } else {
            let stored = tries.to_stored(Instant::now(), wall_ms());
            let json = serde_json::to_string(&stored).expect("tries serialize");
            self.deps.secure.set(TRIES_KEY.to_owned(), json);
        }
    }

    fn waiting(&self) -> bool {
        !self.app_lock.tries.remaining(Instant::now()).is_zero()
    }

    /// Keeps the countdown on screen moving, one tick a second until the wait is over.
    fn tick_wait(&mut self) {
        let left = self.app_lock.tries.remaining(Instant::now());
        if left.is_zero() || self.app_lock.ticking {
            return;
        }
        self.app_lock.ticking = true;
        // Ticks land on whole seconds of the wait, so the label never skips one.
        let part = left - Duration::from_secs(left.as_secs());
        let step = if part.is_zero() {
            Duration::from_secs(1)
        } else {
            part
        };
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(step).await;
            let _ = done.send(Done::Local(Box::new(|runner: &mut Runner| {
                runner.app_lock.ticking = false;
                runner.tick_wait();
                runner.show_lock();
            })));
        });
    }

    /// Checks `code` against the saved hash off the engine's task, then comes back with the answer.
    fn check_code(&mut self, code: Code, check: Check) {
        let Some(hash) = self.app_lock.settings.as_ref().map(|s| s.hash.clone()) else {
            return;
        };
        if self.waiting() || self.app_lock.busy {
            return;
        }
        self.app_lock.busy = true;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let right = tokio::task::spawn_blocking(move || verify_passcode(&code, &hash))
                .await
                .unwrap_or(false);
            let _ = done.send(Done::Local(Box::new(move |runner: &mut Runner| {
                runner.code_checked(right, check);
            })));
        });
    }

    fn code_checked(&mut self, right: bool, check: Check) {
        self.app_lock.busy = false;
        let kind = self.app_lock.settings.as_ref().map(|s| s.kind);
        match (right, check) {
            (true, Check::Unlock) => self.unlock(),
            (true, Check::Settings) => {
                let lock = &mut self.app_lock;
                lock.tries.succeeded();
                lock.step = PasscodeStep::On;
                lock.settings_error = None;
                self.save_tries();
            }
            (false, check) => {
                let lock = &mut self.app_lock;
                lock.tries.failed(Instant::now());
                let message = Some(wrong(kind.unwrap_or_default()).to_owned());
                match check {
                    Check::Unlock => {
                        lock.error = message;
                        lock.shake += 1;
                    }
                    Check::Settings => {
                        lock.settings_error = message;
                        lock.settings_shake += 1;
                    }
                }
                self.save_tries();
                self.tick_wait();
            }
        }
        self.show_lock();
    }

    fn lock_key(&mut self, digit: u8) {
        if !self.app_lock.locked || self.app_lock.busy || self.waiting() {
            return;
        }
        self.app_lock.error = None;
        if let Some(code) = self.app_lock.entry.key(digit) {
            self.check_code(code, Check::Unlock);
        }
        self.show_lock();
    }

    fn lock_submit(&mut self, text: String) {
        if !self.app_lock.locked || text.is_empty() {
            return;
        }
        self.app_lock.error = None;
        self.check_code(Code::new(text), Check::Unlock);
        self.show_lock();
    }

    fn passcode_open(&mut self) {
        let lock = &mut self.app_lock;
        lock.settings_open = true;
        lock.settings_error = None;
        lock.setup = None;
        match &lock.settings {
            Some(settings) => {
                lock.step = PasscodeStep::Verify;
                lock.settings_entry = Entry::new(settings.kind);
            }
            None => lock.step = PasscodeStep::Off,
        }
        self.show_lock();
    }

    fn passcode_close(&mut self) {
        let lock = &mut self.app_lock;
        lock.settings_open = false;
        lock.setup = None;
        lock.settings_entry.clear();
        lock.settings_error = None;
        self.show_lock();
    }

    fn passcode_start(&mut self, kind: PasscodeKind) {
        let lock = &mut self.app_lock;
        if !lock.settings_open
            || !matches!(
                lock.step,
                PasscodeStep::Off | PasscodeStep::On | PasscodeStep::Choose
            )
        {
            return;
        }
        lock.setup = Some(Setup::new(kind));
        lock.settings_entry = Entry::new(kind);
        lock.settings_error = None;
        lock.step = PasscodeStep::Choose;
        self.show_lock();
    }

    fn passcode_entered(&mut self, code: Code) {
        if self.app_lock.step == PasscodeStep::Verify {
            self.check_code(code, Check::Settings);
            return;
        }
        let Some(setup) = self.app_lock.setup.as_mut() else {
            return;
        };
        let kind = setup.kind;
        let outcome = setup.submit(code);
        let lock = &mut self.app_lock;
        match outcome {
            SetupOutcome::Confirm => {
                lock.step = PasscodeStep::Confirm;
                lock.settings_error = None;
            }
            SetupOutcome::Invalid => {
                lock.settings_error = Some(TOO_SHORT.to_owned());
                lock.settings_shake += 1;
            }
            SetupOutcome::Mismatch => {
                lock.step = PasscodeStep::Choose;
                lock.settings_error = Some(MISMATCH.to_owned());
                lock.settings_shake += 1;
            }
            SetupOutcome::Chosen(code) => {
                lock.busy = true;
                let done = self.done_tx.clone();
                tokio::spawn(async move {
                    let hash = tokio::task::spawn_blocking(move || {
                        let salt: [u8; 16] = os_random(16).try_into().expect("16 bytes");
                        hash_passcode(&code, &salt)
                    })
                    .await;
                    let _ = done.send(Done::Local(Box::new(move |runner: &mut Runner| {
                        runner.app_lock.busy = false;
                        if let Ok(hash) = hash {
                            runner.passcode_chosen(kind, hash);
                        }
                        runner.show_lock();
                    })));
                });
            }
        }
    }

    fn passcode_chosen(&mut self, kind: PasscodeKind, hash: String) {
        let lock = &mut self.app_lock;
        let changed = lock.settings.is_some();
        let settings = match lock.settings.take() {
            Some(old) => LockSettings { kind, hash, ..old },
            None => LockSettings {
                kind,
                hash,
                auto_lock: AutoLock::default(),
                biometric: false,
                biometric_enrollment: None,
            },
        };
        lock.settings = Some(settings);
        lock.setup = None;
        lock.step = PasscodeStep::On;
        lock.settings_error = None;
        lock.tries.succeeded();
        self.save_settings();
        self.save_tries();
        self.view.notice = Some(if changed {
            "Passcode changed.".to_owned()
        } else {
            "Passcode on.".to_owned()
        });
    }

    fn settings_ready(&self) -> bool {
        self.app_lock.settings_open && self.app_lock.step == PasscodeStep::On
    }

    /// Rebuilds both lock views from the state.
    pub(crate) fn show_lock(&mut self) {
        let lock = &self.app_lock;
        let wait = ceil_seconds(lock.tries.remaining(Instant::now()));
        let settings = lock.settings.as_ref();
        let kind = settings.map(|s| s.kind).unwrap_or_default();
        let usable =
            settings.is_some_and(|s| biometric_use(s, &lock.capability) == BiometricUse::Usable);
        let has_biometrics = lock.capability.kind != BiometricKind::None;
        let name = has_biometrics.then(|| lock.capability.name.clone());

        let waiting_error = (wait > 0).then(|| wait_label(wait));
        self.view.lock = LockScreen {
            enabled: settings.is_some(),
            locked: lock.locked,
            entry: PasscodeEntryView {
                kind,
                length: kind.length(),
                filled: lock.entry.filled(),
                title: format!("Enter your {}", noun(kind)),
                error: waiting_error.clone().or_else(|| lock.error.clone()),
                shake: lock.shake,
                busy: lock.busy && lock.locked,
                wait_seconds: wait,
            },
            biometric_label: if usable { name.clone() } else { None },
            biometric_kind: if usable {
                lock.capability.kind
            } else {
                BiometricKind::None
            },
            biometric: lock.request.clone(),
            confirm_forgot: lock.confirm_forgot,
        };

        let entry_kind = match (&lock.setup, lock.step) {
            (Some(setup), _) => setup.kind,
            _ => kind,
        };
        let title = match lock.step {
            PasscodeStep::Verify => format!("Enter your {}", noun(entry_kind)),
            PasscodeStep::Choose => format!("Choose a {}", noun(entry_kind)),
            PasscodeStep::Confirm => format!("Enter your new {} again", noun(entry_kind)),
            PasscodeStep::Off | PasscodeStep::On => String::new(),
        };
        let auto_lock = settings.map(|s| s.auto_lock).unwrap_or_default();
        let verifying = lock.step == PasscodeStep::Verify;
        self.view.passcode = PasscodeSettingsScreen {
            open: lock.settings_open,
            step: lock.step,
            entry: PasscodeEntryView {
                kind: entry_kind,
                length: entry_kind.length(),
                filled: lock.settings_entry.filled(),
                title,
                error: if verifying {
                    waiting_error.or_else(|| lock.settings_error.clone())
                } else {
                    lock.settings_error.clone()
                },
                shake: lock.settings_shake,
                busy: lock.busy && !lock.locked,
                wait_seconds: if verifying { wait } else { 0 },
            },
            auto_lock,
            auto_lock_label: auto_lock.label().to_owned(),
            auto_lock_choices: AutoLock::ALL
                .iter()
                .map(|&value| AutoLockChoice {
                    value,
                    label: value.label().to_owned(),
                })
                .collect(),
            biometric_label: name,
            biometric_kind: lock.capability.kind,
            biometric_on: usable,
        };
    }
}

#[uniffi::export]
impl Engine {
    /// What the phone can check, sent at start and each time the app comes back, before
    /// `lifecycle(Foregrounded)`. `enrollment` changes when a face or finger is added.
    pub fn set_biometric_capability(
        &self,
        kind: BiometricKind,
        name: String,
        enrollment: Option<String>,
    ) {
        self.run(move |r| {
            r.app_lock.capability = Capability {
                kind,
                name,
                enrollment,
            };
            r.offer_biometric();
            r.show_lock();
        });
    }

    /// A digit from the lock screen's keypad. The code is checked once it is complete.
    pub fn lock_key(&self, digit: u8) {
        self.run(move |r| r.lock_key(digit));
    }

    pub fn lock_backspace(&self) {
        self.run(|r| {
            r.app_lock.entry.backspace();
            r.show_lock();
        });
    }

    /// A password typed on the lock screen.
    pub fn lock_submit(&self, text: String) {
        self.run(move |r| r.lock_submit(text));
    }

    /// The biometric button on the lock screen.
    pub fn lock_use_biometric(&self) {
        self.run(|r| {
            r.app_lock.offered = false;
            r.offer_biometric();
            r.show_lock();
        });
    }

    pub fn lock_forgot(&self) {
        self.run(|r| {
            if r.app_lock.locked {
                r.app_lock.confirm_forgot = true;
                r.app_lock.request = None;
                r.show_lock();
            }
        });
    }

    /// Yes signs this phone out and removes the lock. No goes back to the keypad.
    pub fn lock_forgot_confirm(&self, sign_out: bool) {
        self.run(move |r| {
            if !r.app_lock.confirm_forgot {
                return;
            }
            r.app_lock.confirm_forgot = false;
            if sign_out {
                r.remove_app_lock();
            }
            r.show_lock();
        });
        if sign_out {
            self.sign_out();
        }
    }

    pub fn lock_now(&self) {
        self.run(|r| {
            r.lock();
            r.app_lock.offered = true;
            r.show_lock();
        });
    }

    /// The Passcode lock screen in settings. With a passcode set, it asks for it first.
    pub fn passcode_open(&self) {
        self.run(Runner::passcode_open);
    }

    pub fn passcode_close(&self) {
        self.run(Runner::passcode_close);
    }

    /// Starts choosing a new passcode of `kind`, to turn the lock on or change the code.
    pub fn passcode_start(&self, kind: PasscodeKind) {
        self.run(move |r| r.passcode_start(kind));
    }

    pub fn passcode_key(&self, digit: u8) {
        self.run(move |r| {
            if !r.app_lock.settings_open || r.app_lock.busy {
                return;
            }
            if r.app_lock.step == PasscodeStep::Verify && r.waiting() {
                return;
            }
            r.app_lock.settings_error = None;
            if let Some(code) = r.app_lock.settings_entry.key(digit) {
                r.passcode_entered(code);
            }
            r.show_lock();
        });
    }

    pub fn passcode_backspace(&self) {
        self.run(|r| {
            r.app_lock.settings_entry.backspace();
            r.show_lock();
        });
    }

    pub fn passcode_submit(&self, text: String) {
        self.run(move |r| {
            if !r.app_lock.settings_open || r.app_lock.busy || text.is_empty() {
                return;
            }
            r.app_lock.settings_error = None;
            r.passcode_entered(Code::new(text));
            r.show_lock();
        });
    }

    pub fn passcode_off(&self) {
        self.run(|r| {
            if !r.settings_ready() {
                return;
            }
            r.remove_app_lock();
            r.app_lock.settings_open = true;
            r.view.notice = Some("Passcode off.".to_owned());
            r.show_lock();
        });
    }

    pub fn set_auto_lock(&self, choice: AutoLock) {
        self.run(move |r| {
            if !r.settings_ready() {
                return;
            }
            if let Some(settings) = r.app_lock.settings.as_mut() {
                settings.auto_lock = choice;
            }
            r.save_settings();
            r.show_lock();
        });
    }

    pub fn set_biometric_unlock(&self, on: bool) {
        self.run(move |r| {
            let capability = r.app_lock.capability.clone();
            if !r.settings_ready() || (on && capability.kind == BiometricKind::None) {
                return;
            }
            if let Some(settings) = r.app_lock.settings.as_mut() {
                settings.biometric = on;
                settings.biometric_enrollment = if on { capability.enrollment } else { None };
            }
            r.app_lock.error = None;
            r.save_settings();
            r.show_lock();
        });
    }
}
