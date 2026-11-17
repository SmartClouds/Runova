use super::*;
use std::time::Duration;
use tokio::time::Instant;

fn code(text: &str) -> Code {
    Code::new(text.to_owned())
}

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn type_in(entry: &mut Entry, digits: &str) -> Option<String> {
    let mut last = None;
    for d in digits.chars() {
        last = entry.key(d.to_digit(10).unwrap() as u8);
    }
    last.map(|code| code.to_string())
}

#[test]
fn a_pin_submits_itself_when_full() {
    let mut four = Entry::new(PasscodeKind::Pin4);
    assert_eq!(type_in(&mut four, "123"), None);
    assert_eq!(four.filled(), 3);
    assert_eq!(type_in(&mut four, "4").as_deref(), Some("1234"));
    assert_eq!(
        four.filled(),
        0,
        "the buffer empties once it is handed over"
    );

    let mut six = Entry::new(PasscodeKind::Pin6);
    assert_eq!(type_in(&mut six, "12345"), None);
    assert_eq!(type_in(&mut six, "6").as_deref(), Some("123456"));
}

#[test]
fn backspace_and_bad_keys() {
    let mut entry = Entry::new(PasscodeKind::Pin4);
    type_in(&mut entry, "12");
    entry.backspace();
    assert_eq!(entry.filled(), 1);
    entry.backspace();
    entry.backspace();
    assert_eq!(entry.filled(), 0);
    assert_eq!(entry.key(10), None);
    assert_eq!(entry.filled(), 0, "only 0 to 9 are keys");

    let mut password = Entry::new(PasscodeKind::Password);
    assert_eq!(password.key(1), None);
    assert_eq!(
        password.filled(),
        0,
        "a password is typed on the keyboard, not the keypad"
    );
}

#[test]
fn kinds_know_their_length() {
    assert_eq!(PasscodeKind::Pin4.length(), 4);
    assert_eq!(PasscodeKind::Pin6.length(), 6);
    assert_eq!(PasscodeKind::Password.length(), 0);
}

#[test]
fn setup_asks_twice_and_keeps_the_code_when_both_match() {
    let mut setup = Setup::new(PasscodeKind::Pin4);
    assert_eq!(setup.submit(code("1234")), SetupOutcome::Confirm);
    assert!(setup.confirming());
    assert_eq!(
        setup.submit(code("1234")),
        SetupOutcome::Chosen(code("1234"))
    );
}

#[test]
fn a_mismatch_starts_setup_again() {
    let mut setup = Setup::new(PasscodeKind::Pin6);
    setup.submit(code("123456"));
    assert_eq!(setup.submit(code("654321")), SetupOutcome::Mismatch);
    assert!(!setup.confirming());
    assert_eq!(setup.submit(code("111111")), SetupOutcome::Confirm);
}

#[test]
fn setup_refuses_codes_that_do_not_fit_the_kind() {
    let mut pin = Setup::new(PasscodeKind::Pin4);
    assert_eq!(pin.submit(code("12a4")), SetupOutcome::Invalid);
    assert_eq!(pin.submit(code("123")), SetupOutcome::Invalid);
    let mut password = Setup::new(PasscodeKind::Password);
    assert_eq!(password.submit(code("abc")), SetupOutcome::Invalid);
    assert_eq!(password.submit(code("abcd")), SetupOutcome::Confirm);
}

#[test]
fn the_wait_grows_after_five_wrong_tries() {
    let waits: Vec<u64> = (1..=11).map(|n| wait_after(n).as_secs()).collect();
    assert_eq!(waits, [0, 0, 0, 0, 30, 60, 300, 900, 3600, 3600, 3600]);
}

#[test]
fn tries_hold_back_the_next_one_until_the_wait_is_over() {
    let start = Instant::now();
    let mut tries = Tries::default();
    for _ in 0..4 {
        tries.failed(start);
    }
    assert_eq!(tries.remaining(start), Duration::ZERO);
    tries.failed(start);
    assert_eq!(tries.remaining(start), secs(30));
    assert_eq!(tries.remaining(start + secs(10)), secs(20));
    assert_eq!(tries.remaining(start + secs(31)), Duration::ZERO);

    tries.failed(start + secs(31));
    assert_eq!(tries.remaining(start + secs(31)), secs(60));

    tries.succeeded();
    assert_eq!(tries.failures, 0);
    assert_eq!(tries.remaining(start + secs(31)), Duration::ZERO);
}

#[test]
fn a_saved_wait_carries_over_a_restart_but_never_past_an_hour() {
    let now = Instant::now();
    let mut tries = Tries::default();
    for _ in 0..5 {
        tries.failed(now);
    }
    let stored = tries.to_stored(now, 1_000_000);
    assert_eq!(stored.failures, 5);
    assert_eq!(stored.retry_at_ms, 1_030_000);

    let later = Instant::now();
    let back = Tries::from_stored(&stored, later, 1_010_000);
    assert_eq!(back.failures, 5);
    assert_eq!(back.remaining(later), secs(20));

    // A clock moved far back must not lock the phone for days.
    let skewed = StoredTries {
        failures: 9,
        retry_at_ms: u64::MAX,
    };
    assert_eq!(
        Tries::from_stored(&skewed, later, 0).remaining(later),
        secs(3600)
    );
}

#[test]
fn wait_labels_read_like_a_clock() {
    assert_eq!(wait_label(28), "Try again in 0:28");
    assert_eq!(wait_label(60), "Try again in 1:00");
    assert_eq!(wait_label(3599), "Try again in 59:59");
    assert_eq!(wait_label(3600), "Try again in 1:00:00");
}

#[test]
fn auto_lock_times() {
    let cases = [
        (AutoLock::Immediately, 0),
        (AutoLock::OneMinute, 60),
        (AutoLock::FiveMinutes, 300),
        (AutoLock::OneHour, 3600),
        (AutoLock::FiveHours, 18000),
    ];
    for (choice, seconds) in cases {
        assert_eq!(choice.seconds(), seconds);
        assert!(locks_after(choice, secs(seconds)));
        if seconds > 0 {
            assert!(!locks_after(choice, secs(seconds - 1)));
        }
    }
    assert!(locks_after(AutoLock::Immediately, Duration::ZERO));
    assert_eq!(AutoLock::default(), AutoLock::OneMinute);
    assert_eq!(AutoLock::OneHour.label(), "After 1 hour");
    assert_eq!(AutoLock::Immediately.label(), "Right away");
}

fn settings(biometric: bool, enrollment: Option<&str>) -> LockSettings {
    LockSettings {
        kind: PasscodeKind::Pin4,
        hash: "scrypt$...".to_owned(),
        auto_lock: AutoLock::OneMinute,
        biometric,
        biometric_enrollment: enrollment.map(str::to_owned),
    }
}

fn capability(kind: BiometricKind, enrollment: Option<&str>) -> Capability {
    Capability {
        kind,
        name: "Face ID".to_owned(),
        enrollment: enrollment.map(str::to_owned),
    }
}

#[test]
fn biometrics_are_used_only_while_on_and_unchanged() {
    let face = capability(BiometricKind::Face, Some("e1"));
    assert_eq!(
        biometric_use(&settings(true, Some("e1")), &face),
        BiometricUse::Usable
    );
    assert_eq!(
        biometric_use(&settings(false, Some("e1")), &face),
        BiometricUse::Off
    );
    assert_eq!(
        biometric_use(
            &settings(true, Some("e1")),
            &capability(BiometricKind::None, None)
        ),
        BiometricUse::Off
    );
    assert_eq!(
        biometric_use(
            &settings(true, Some("e1")),
            &capability(BiometricKind::Face, Some("e2"))
        ),
        BiometricUse::Changed,
        "a face or finger added since it was turned on"
    );
    assert_eq!(
        biometric_use(
            &settings(true, None),
            &capability(BiometricKind::Fingerprint, None)
        ),
        BiometricUse::Usable,
        "a phone that can't tell enrollments apart"
    );
}

#[test]
fn settings_round_trip_through_the_store() {
    let saved = settings(true, Some("e1"));
    let json = saved.to_json();
    assert!(json.contains("\"pin4\""), "{json}");
    assert_eq!(LockSettings::parse(&json), Some(saved));
    assert_eq!(LockSettings::parse("not json"), None);
}
