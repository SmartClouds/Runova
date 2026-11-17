//! The app lock (E106): a passcode or password, biometrics, auto-lock and growing waits after
//! wrong codes. This file holds the rules and nothing that does I/O, so they are tested on their
//! own. `runner.rs` connects them to the engine.

mod runner;

pub(crate) use runner::LockState;
#[cfg(test)]
mod tests;

pub use crate::app_lock_view::{AutoLock, BiometricKind, PasscodeKind};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::Instant;
use zeroize::Zeroizing;

/// Where the passcode hash and its settings are kept.
pub(crate) const SETTINGS_KEY: &str = "app-lock";
/// Wrong tries and the end of the current wait, kept apart so a wrong code never rewrites the hash.
pub(crate) const TRIES_KEY: &str = "app-lock-tries";

const FREE_TRIES: u32 = 4;
const MAX_WAIT: Duration = Duration::from_secs(3600);
const MIN_PASSWORD: usize = 4;

pub(crate) type Code = Zeroizing<String>;

impl PasscodeKind {
    /// The number of digits, or 0 for a password.
    pub fn length(self) -> u8 {
        match self {
            PasscodeKind::Pin4 => 4,
            PasscodeKind::Pin6 => 6,
            PasscodeKind::Password => 0,
        }
    }

    fn fits(self, code: &str) -> bool {
        match self {
            PasscodeKind::Password => code.chars().count() >= MIN_PASSWORD,
            pin => {
                code.len() == usize::from(pin.length()) && code.chars().all(|c| c.is_ascii_digit())
            }
        }
    }
}

impl AutoLock {
    pub const ALL: [AutoLock; 5] = [
        AutoLock::Immediately,
        AutoLock::OneMinute,
        AutoLock::FiveMinutes,
        AutoLock::OneHour,
        AutoLock::FiveHours,
    ];

    pub fn seconds(self) -> u64 {
        match self {
            AutoLock::Immediately => 0,
            AutoLock::OneMinute => 60,
            AutoLock::FiveMinutes => 300,
            AutoLock::OneHour => 3600,
            AutoLock::FiveHours => 18_000,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AutoLock::Immediately => "Right away",
            AutoLock::OneMinute => "After 1 minute",
            AutoLock::FiveMinutes => "After 5 minutes",
            AutoLock::OneHour => "After 1 hour",
            AutoLock::FiveHours => "After 5 hours",
        }
    }
}

/// Whether the app should be locked when it comes back after being away this long.
pub(crate) fn locks_after(choice: AutoLock, away: Duration) -> bool {
    away >= Duration::from_secs(choice.seconds())
}

/// The digits typed so far on the keypad.
#[derive(Default)]
pub(crate) struct Entry {
    pub(crate) kind: PasscodeKind,
    digits: Code,
}

impl Entry {
    pub(crate) fn new(kind: PasscodeKind) -> Self {
        Self {
            kind,
            digits: Code::default(),
        }
    }

    /// Adds a digit. Once the code is complete it is handed back and the keypad starts empty.
    pub(crate) fn key(&mut self, digit: u8) -> Option<Code> {
        let length = usize::from(self.kind.length());
        if digit > 9 || length == 0 {
            return None;
        }
        self.digits.push(char::from(b'0' + digit));
        if self.digits.len() < length {
            return None;
        }
        Some(std::mem::take(&mut self.digits))
    }

    pub(crate) fn backspace(&mut self) {
        self.digits.pop();
    }

    pub(crate) fn clear(&mut self) {
        self.digits = Code::default();
    }

    pub(crate) fn filled(&self) -> u8 {
        u8::try_from(self.digits.len()).unwrap_or(u8::MAX)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SetupOutcome {
    /// Asks for the same code again.
    Confirm,
    /// The second code was different, so setup starts over.
    Mismatch,
    /// Too short, or not digits for a PIN.
    Invalid,
    /// Both codes matched. This is the new passcode.
    Chosen(Code),
}

/// Choosing a new passcode: type it, then type it again.
#[derive(Default)]
pub(crate) struct Setup {
    pub(crate) kind: PasscodeKind,
    first: Option<Code>,
}

impl Setup {
    pub(crate) fn new(kind: PasscodeKind) -> Self {
        Self { kind, first: None }
    }

    #[cfg(test)]
    pub(crate) fn confirming(&self) -> bool {
        self.first.is_some()
    }

    pub(crate) fn submit(&mut self, code: Code) -> SetupOutcome {
        match self.first.take() {
            None if !self.kind.fits(&code) => SetupOutcome::Invalid,
            None => {
                self.first = Some(code);
                SetupOutcome::Confirm
            }
            Some(first) if *first == *code => SetupOutcome::Chosen(code),
            Some(_) => SetupOutcome::Mismatch,
        }
    }
}

/// How long to hold back the next try after this many wrong ones in a row.
pub(crate) fn wait_after(failures: u32) -> Duration {
    let seconds = match failures.saturating_sub(FREE_TRIES) {
        0 => 0,
        1 => 30,
        2 => 60,
        3 => 300,
        4 => 900,
        _ => 3600,
    };
    Duration::from_secs(seconds)
}

pub(crate) fn wait_label(seconds: u32) -> String {
    let (hours, minutes, secs) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("Try again in {hours}:{minutes:02}:{secs:02}")
    } else {
        format!("Try again in {minutes}:{secs:02}")
    }
}

/// Wrong codes in a row, and when the next one may be tried.
#[derive(Debug, Default)]
pub(crate) struct Tries {
    pub(crate) failures: u32,
    retry_at: Option<Instant>,
}

/// `Tries` on the wall clock, so a restart does not end the wait.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoredTries {
    pub(crate) failures: u32,
    pub(crate) retry_at_ms: u64,
}

impl Tries {
    pub(crate) fn remaining(&self, now: Instant) -> Duration {
        self.retry_at
            .map_or(Duration::ZERO, |at| at.saturating_duration_since(now))
    }

    pub(crate) fn failed(&mut self, now: Instant) {
        self.failures = self.failures.saturating_add(1);
        let wait = wait_after(self.failures);
        self.retry_at = (!wait.is_zero()).then(|| now + wait);
    }

    pub(crate) fn succeeded(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn to_stored(&self, now: Instant, wall_ms: u64) -> StoredTries {
        let left = u64::try_from(self.remaining(now).as_millis()).unwrap_or(u64::MAX);
        StoredTries {
            failures: self.failures,
            retry_at_ms: wall_ms.saturating_add(left),
        }
    }

    pub(crate) fn from_stored(stored: &StoredTries, now: Instant, wall_ms: u64) -> Self {
        let left = Duration::from_millis(stored.retry_at_ms.saturating_sub(wall_ms)).min(MAX_WAIT);
        Self {
            failures: stored.failures,
            retry_at: (!left.is_zero()).then(|| now + left),
        }
    }
}

/// The passcode and how the lock behaves, as kept in the secure store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LockSettings {
    pub(crate) kind: PasscodeKind,
    /// From `runova_crypto::passcode::hash_passcode`. Never the code itself.
    pub(crate) hash: String,
    #[serde(default)]
    pub(crate) auto_lock: AutoLock,
    #[serde(default)]
    pub(crate) biometric: bool,
    /// What the phone said about its enrolled faces or fingers when biometrics were turned on.
    #[serde(default)]
    pub(crate) biometric_enrollment: Option<String>,
}

impl LockSettings {
    pub(crate) fn parse(json: &str) -> Option<Self> {
        serde_json::from_str(json).ok()
    }

    pub(crate) fn to_json(&self) -> String {
        serde_json::to_string(self).expect("lock settings serialize")
    }
}

/// What native code said the phone can do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Capability {
    pub(crate) kind: BiometricKind,
    pub(crate) name: String,
    pub(crate) enrollment: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BiometricUse {
    Off,
    Usable,
    /// A face or finger was added since biometrics were turned on, so only the passcode opens it.
    Changed,
}

pub(crate) fn biometric_use(settings: &LockSettings, capability: &Capability) -> BiometricUse {
    if !settings.biometric || capability.kind == BiometricKind::None {
        BiometricUse::Off
    } else if settings.biometric_enrollment != capability.enrollment {
        BiometricUse::Changed
    } else {
        BiometricUse::Usable
    }
}
