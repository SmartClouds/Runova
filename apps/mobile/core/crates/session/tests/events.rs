use runova_session::hub::{HubEvent, read_event};
use runova_signalr::client::HubEvent as Raw;
use serde_json::{Value, json};

fn raw(target: &str, arguments: Vec<Value>) -> Raw {
    Raw {
        target: target.to_owned(),
        arguments,
    }
}

#[test]
fn an_answer_to_a_request_is_read() {
    let event = raw(
        "RequestResolved",
        vec![json!({"sessionId": "s1", "accepted": false, "reason": "declined"})],
    );

    assert_eq!(
        read_event(&event),
        Some(HubEvent::Resolved {
            session_id: "s1".into(),
            accepted: false,
            reason: Some("declined".into()),
        })
    );
}

#[test]
fn a_signal_carries_its_session_and_payload() {
    let event = raw("Signal", vec![json!("s1"), json!("{}")]);

    assert_eq!(
        read_event(&event),
        Some(HubEvent::Signal {
            session_id: "s1".into(),
            payload: "{}".into(),
        })
    );
}

#[test]
fn an_ended_session_says_why() {
    let event = raw(
        "SessionEnded",
        vec![json!({"sessionId": "s1", "reason": "host-left"})],
    );

    assert_eq!(
        read_event(&event),
        Some(HubEvent::Ended {
            session_id: "s1".into(),
            reason: "host-left".into(),
        })
    );
}

#[test]
fn presence_names_the_device() {
    let event = raw(
        "PresenceChanged",
        vec![json!({"deviceId": 7, "online": true})],
    );

    assert_eq!(
        read_event(&event),
        Some(HubEvent::Presence {
            device_id: 7,
            online: true,
        })
    );
}

#[test]
fn events_this_app_does_not_use_are_skipped() {
    assert_eq!(read_event(&raw("SomethingNew", vec![json!(1)])), None);
}

#[test]
fn a_malformed_event_is_skipped_and_does_no_harm() {
    assert_eq!(read_event(&raw("Signal", vec![json!(1)])), None);
    assert_eq!(read_event(&raw("RequestResolved", vec![])), None);
    assert_eq!(read_event(&raw("SessionEnded", vec![json!("x")])), None);
    assert_eq!(read_event(&raw("PresenceChanged", vec![json!({})])), None);
}
