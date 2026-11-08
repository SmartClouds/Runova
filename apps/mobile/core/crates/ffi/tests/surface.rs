//! The surface native code calls, in plain Rust.

use runova_ffi::{
    CoreError, DeviceDetails, begin_phone_sign_in, core_version, finish_browser_callback,
};

fn device() -> DeviceDetails {
    DeviceDetails {
        device_id: "4b2c0c0e-1111-4222-8333-944444444444".into(),
        name: "Runova app".into(),
        platform: "android".into(),
        app_version: "1.0.0".into(),
    }
}

#[test]
fn the_core_reports_its_version() {
    assert_eq!(core_version(), env!("CARGO_PKG_VERSION"));
}

#[test]
fn a_sign_in_link_comes_back_as_a_typed_record() {
    let link = begin_phone_sign_in("https://runovahq.com".into(), device());

    assert!(link.url.contains("client_id=runova-mobile"));
    assert_eq!(link.verifier.len(), 43);
    assert!(link.state.len() >= 8);
}

#[test]
fn two_sign_ins_never_share_a_verifier_or_state() {
    let one = begin_phone_sign_in("https://runovahq.com".into(), device());
    let two = begin_phone_sign_in("https://runovahq.com".into(), device());

    assert_ne!(one.verifier, two.verifier);
    assert_ne!(one.state, two.state);
}

#[test]
fn the_browsers_answer_gives_the_code() {
    let url = "com.runovahq.app:/auth/callback?code=abc&state=s-12345678".to_owned();

    assert_eq!(
        finish_browser_callback(url, "s-12345678".into()),
        Ok("abc".to_owned())
    );
}

#[test]
fn errors_reach_native_code_as_typed_cases() {
    let declined =
        "com.runovahq.app:/auth/callback?error=access_denied&state=s-12345678".to_owned();
    let forged = "com.runovahq.app:/auth/callback?code=abc&state=other".to_owned();

    assert_eq!(
        finish_browser_callback(declined, "s-12345678".into()),
        Err(CoreError::SignInDeclined)
    );
    assert_eq!(
        finish_browser_callback(forged, "s-12345678".into()),
        Err(CoreError::SignInInvalid)
    );
}
