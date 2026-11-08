//! The browser half of signing in.

use runova_api::auth::{AuthError, DeviceInfo, PHONE_REDIRECT, begin_sign_in, read_callback};

fn device() -> DeviceInfo {
    DeviceInfo {
        device_id: "4b2c0c0e-1111-4222-8333-944444444444".into(),
        name: "Sam's phone".into(),
        platform: "ios".into(),
        app_version: "1.0.0".into(),
    }
}

/// A fixed "random" source, so the challenge is known (RFC 7636 appendix B).
fn rfc_bytes(length: usize) -> Vec<u8> {
    if length == 32 {
        vec![
            116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212,
            37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
        ]
    } else {
        vec![7; length]
    }
}

#[test]
fn the_challenge_is_the_s256_of_the_verifier() {
    let request = begin_sign_in("https://runovahq.com", &device(), &mut rfc_bytes);

    assert_eq!(
        request.verifier,
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    );
    assert!(
        request
            .url
            .contains("code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    );
    assert!(request.url.contains("code_challenge_method=S256"));
}

#[test]
fn the_link_names_the_phone_client_and_its_redirect_escaped() {
    let request = begin_sign_in("https://runovahq.com/", &device(), &mut rfc_bytes);

    assert!(
        request
            .url
            .starts_with("https://runovahq.com/account/authorize?")
    );
    assert!(request.url.contains("client_id=runova-mobile"));
    assert!(
        request
            .url
            .contains("redirect_uri=com.runovahq.app%3A%2Fauth%2Fcallback")
    );
    assert!(request.url.contains("response_type=code"));
    assert!(request.url.contains("platform=ios"));
    assert!(request.url.contains("device_name=Sam%27s%20phone"));
    assert!(request.url.contains(&format!("state={}", request.state)));
}

#[test]
fn state_is_long_enough_for_the_server() {
    let request = begin_sign_in("https://runovahq.com", &device(), &mut rfc_bytes);

    assert!(request.state.len() >= 8 && request.state.len() <= 200);
}

#[test]
fn a_good_callback_gives_the_code() {
    let url = format!("{PHONE_REDIRECT}?code=the-code&state=s-12345678");

    assert_eq!(read_callback(&url, "s-12345678"), Ok("the-code".to_owned()));
}

#[test]
fn a_callback_with_another_state_is_refused() {
    let url = format!("{PHONE_REDIRECT}?code=the-code&state=someone-else");

    assert_eq!(
        read_callback(&url, "s-12345678"),
        Err(AuthError::StateMismatch)
    );
}

#[test]
fn saying_no_in_the_browser_is_its_own_answer() {
    let url = format!("{PHONE_REDIRECT}?error=access_denied&state=s-12345678");

    assert_eq!(read_callback(&url, "s-12345678"), Err(AuthError::Declined));
}

#[test]
fn a_link_from_elsewhere_is_refused() {
    assert_eq!(
        read_callback(
            "https://evil.example/?code=x&state=s-12345678",
            "s-12345678"
        ),
        Err(AuthError::BadCallback)
    );
}
