//! What the app lock puts on screen (E106). Codes never appear here, only how much has been typed.

use crate::view::BiometricRequestView;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum PasscodeKind {
    #[default]
    Pin4,
    Pin6,
    /// Letters, numbers and symbols, typed on the keyboard.
    Password,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum AutoLock {
    Immediately,
    #[default]
    OneMinute,
    FiveMinutes,
    OneHour,
    FiveHours,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum BiometricKind {
    #[default]
    None,
    Fingerprint,
    Face,
}

/// The keypad or password field, on the lock screen and while setting a passcode.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct PasscodeEntryView {
    pub kind: PasscodeKind,
    /// How many dots to draw. 0 for a password.
    pub length: u8,
    pub filled: u8,
    pub title: String,
    pub error: Option<String>,
    /// Goes up by one on each wrong code, so native code shakes the dots once per change.
    pub shake: u64,
    /// The code is being checked.
    pub busy: bool,
    /// Above 0, no code is taken until this many seconds have passed.
    pub wait_seconds: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct LockScreen {
    /// A passcode is set. Native code hides the app in the app switcher while this is true.
    pub enabled: bool,
    /// Covers everything else until the passcode or biometrics open it.
    pub locked: bool,
    pub entry: PasscodeEntryView,
    /// What the phone calls its check ("Face ID", "Fingerprint"), when it can be used to unlock.
    pub biometric_label: Option<String>,
    pub biometric_kind: BiometricKind,
    /// Native code asks for biometrics only (no phone PIN) and answers with `biometric_result`.
    pub biometric: Option<BiometricRequestView>,
    /// "Forgot passcode?" was tapped, and the sign-out question is on show.
    pub confirm_forgot: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum PasscodeStep {
    /// No passcode: the screen explains it and offers to turn it on.
    #[default]
    Off,
    /// A passcode is set, and it must be entered before its settings show.
    Verify,
    /// Typing a new passcode.
    Choose,
    /// Typing the new passcode again.
    Confirm,
    /// The settings themselves.
    On,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AutoLockChoice {
    pub value: AutoLock,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct PasscodeSettingsScreen {
    pub open: bool,
    pub step: PasscodeStep,
    pub entry: PasscodeEntryView,
    pub auto_lock: AutoLock,
    pub auto_lock_label: String,
    pub auto_lock_choices: Vec<AutoLockChoice>,
    /// What the phone calls its check, or None on a phone without one.
    pub biometric_label: Option<String>,
    pub biometric_kind: BiometricKind,
    pub biometric_on: bool,
}
