mod common;

use common::{World, connected, signed_in};
use runova_ffi::secure::SecureStore;
use runova_ffi::view::Section;
use serde_json::{Value, json};

const ME: &str = "/api/v1/accounts/me";
const SESSIONS: &str = "/api/v1/sessions";
const TEAMS: &str = "/api/v1/teams";
const INVITATIONS: &str = "/api/v1/invitations";
const ACTIVITIES: &str = "/api/v1/activities?page=1&pageSize=20";

fn answer_all(world: &World) {
    world.backend.answer(
        ME,
        json!({"id": 1, "email": "sam@example.com", "displayName": "Sam", "twoFactorEnabled": true}),
    );
    world.backend.answer(
        SESSIONS,
        json!({"items": [
            {"id": 4, "kind": "mobile", "deviceName": "Pixel", "platform": "android", "ip": "1.1.1.1", "current": true},
            {"id": 9, "kind": "desktop", "deviceName": "Sam's desk", "platform": "windows", "ip": null, "current": false},
        ]}),
    );
    world.backend.answer(
        TEAMS,
        json!({"items": [
            {"id": 3, "name": "Acme", "role": "Owner", "memberCount": 2},
            {"id": 8, "name": "Guests", "role": "Member", "memberCount": 5},
        ]}),
    );
    world.backend.answer(
        INVITATIONS,
        json!({"items": [{"id": 7, "teamId": 12, "teamName": "Beta", "role": "Member", "invitedBy": "Lee", "expiresAt": "x"}]}),
    );
    world.backend.answer(
        ACTIVITIES,
        json!({"items": [{"id": 1, "action": "signed-in", "ip": "1.1.1.1", "device": "Pixel", "at": "2026-01-02T03:04:05Z"}]}),
    );
}

async fn on_account() -> World {
    let world = signed_in().await;
    answer_all(&world);
    world.engine.open_section(Some(Section::Account));
    world
        .until(
            |v| {
                v.account.profile.is_some()
                    && !v.account.sessions.is_empty()
                    && !v.account.teams.is_empty()
                    && !v.account.invitations.is_empty()
                    && !v.account.activity.is_empty()
            },
            "the account",
        )
        .await;
    world
}

async fn on_team() -> World {
    let world = on_account().await;
    world.backend.answer(
        "/api/v1/teams/3/members",
        json!({"items": [
            {"userId": 1, "email": "sam@example.com", "displayName": "Sam", "role": "Owner"},
            {"userId": 2, "email": "lee@example.com", "displayName": "Lee", "role": "Member"},
        ]}),
    );
    world.backend.answer(
        "/api/v1/teams/3/invitations",
        json!({"items": [{"id": 5, "email": "new@example.com", "role": "Member"}]}),
    );
    world.engine.account_open_team(3);
    world
        .until(
            |v| {
                v.account
                    .team
                    .as_ref()
                    .is_some_and(|t| !t.members.is_empty())
            },
            "the team",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_account_needs_no_computer() {
    let world = on_account().await;

    let view = world.latest().unwrap();

    assert!(view.connection.is_none());
    let profile = view.account.profile.unwrap();
    assert_eq!(profile.email, "sam@example.com");
    assert_eq!(profile.name, "Sam");
    assert!(profile.two_factor);
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_mark_this_phone_and_say_what_they_are() {
    let world = on_account().await;

    let sessions = world.latest().unwrap().account.sessions;

    assert!(sessions[0].current);
    assert_eq!(sessions[0].title, "Pixel");
    assert_eq!(sessions[1].detail, "Runova desktop app, windows");
    assert!(!sessions[1].current);
}

#[tokio::test(flavor = "multi_thread")]
async fn ending_a_session_asks_then_really_ends_it() {
    let world = on_account().await;
    world.backend.answer("/api/v1/sessions/9", Value::Null);

    world.engine.account_end_session(9);
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.backend.sent().is_empty());

    world.engine.confirm();
    world
        .until(|_| !world.backend.sent().is_empty(), "sent")
        .await;

    assert_eq!(
        world.backend.sent()[0],
        (
            "DELETE".to_owned(),
            "/api/v1/sessions/9".to_owned(),
            json!({})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ending_all_others_needs_the_password_or_code() {
    let world = on_account().await;
    world.backend.answer(SESSIONS, json!({"items": []}));

    world.engine.account_end_other_sessions();
    world
        .until(|v| v.account.step_up.is_some(), "the form")
        .await;
    assert!(world.backend.sent().is_empty());

    world
        .engine
        .account_submit_step_up(Some("hunter2".into()), None);
    world
        .until(|_| !world.backend.sent().is_empty(), "sent")
        .await;

    assert_eq!(
        world.backend.sent()[0],
        (
            "DELETE".to_owned(),
            SESSIONS.to_owned(),
            json!({"password": "hunter2"})
        )
    );
    world.until(|v| v.account.step_up.is_none(), "closed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_step_up_stays_open_and_says_so() {
    let world = on_account().await;

    world.engine.account_end_other_sessions();
    world
        .until(|v| v.account.step_up.is_some(), "the form")
        .await;
    // The fake has nothing at this path once removed, so the change is refused.
    world.backend.refuse(SESSIONS);
    world
        .engine
        .account_submit_step_up(None, Some("000000".into()));
    let view = world
        .until(
            |v| {
                v.account
                    .step_up
                    .as_ref()
                    .is_some_and(|s| s.error.is_some())
            },
            "the message",
        )
        .await;

    assert_eq!(
        view.account.step_up.unwrap().error.as_deref(),
        Some("That password or code isn't right.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_name_can_be_changed() {
    let world = on_account().await;

    world.engine.account_set_name("Samira".into());
    world
        .until(|_| !world.backend.sent().is_empty(), "sent")
        .await;

    assert_eq!(
        world.backend.sent()[0],
        (
            "PATCH".to_owned(),
            ME.to_owned(),
            json!({"displayName": "Samira"})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_team_shows_more_to_those_who_can_manage_it() {
    let world = on_team().await;

    let team = world.latest().unwrap().account.team.unwrap();

    assert!(team.can_manage);
    assert_eq!(team.members.len(), 2);
    assert_eq!(team.invitations[0].email, "new@example.com");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ordinary_member_does_not_ask_for_invitations() {
    let world = on_account().await;
    world.backend.answer(
        "/api/v1/teams/8/members",
        json!({"items": [{"userId": 1, "email": "e", "displayName": "Sam", "role": "Member"}]}),
    );

    world.engine.account_open_team(8);
    let view = world
        .until(
            |v| {
                v.account
                    .team
                    .as_ref()
                    .is_some_and(|t| !t.members.is_empty())
            },
            "the team",
        )
        .await;

    assert!(!view.account.team.unwrap().can_manage);
    assert!(view.error.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn inviting_and_taking_back_an_invitation() {
    let world = on_team().await;

    world
        .engine
        .account_invite("kim@example.com".into(), "Member".into());
    world
        .until(|_| !world.backend.sent().is_empty(), "invited")
        .await;
    assert_eq!(
        world.backend.sent()[0],
        (
            "POST".to_owned(),
            "/api/v1/teams/3/invitations".to_owned(),
            json!({"email": "kim@example.com", "role": "Member"})
        )
    );

    world.engine.account_cancel_invitation(5);
    world
        .until(|_| world.backend.sent().len() >= 2, "cancelled")
        .await;
    assert_eq!(
        world.backend.sent()[1],
        (
            "DELETE".to_owned(),
            "/api/v1/teams/3/invitations/5".to_owned(),
            json!({})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_member_needs_step_up() {
    let world = on_team().await;
    world
        .backend
        .answer("/api/v1/teams/3/members/2", Value::Null);

    world.engine.account_remove_member(2);
    world
        .until(|v| v.account.step_up.is_some(), "the form")
        .await;
    world.engine.account_submit_step_up(Some("pw".into()), None);
    world
        .until(|_| !world.backend.sent().is_empty(), "sent")
        .await;

    assert_eq!(
        world.backend.sent()[0],
        (
            "DELETE".to_owned(),
            "/api/v1/teams/3/members/2".to_owned(),
            json!({"password": "pw"})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_invitation_to_me_can_be_accepted_or_declined() {
    let world = on_account().await;
    world
        .backend
        .answer("/api/v1/invitations/7/acceptances", json!({}));
    world.backend.answer("/api/v1/invitations/7", Value::Null);

    world.engine.account_accept_invitation(7);
    world
        .until(|_| !world.backend.sent().is_empty(), "accepted")
        .await;
    world.engine.account_decline_invitation(7);
    world
        .until(|_| world.backend.sent().len() >= 2, "declined")
        .await;

    assert_eq!(world.backend.sent()[0].0, "POST");
    assert_eq!(world.backend.sent()[1].0, "DELETE");
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_ends_the_session_and_leaves_nothing_on_the_phone() {
    let world = on_account().await;
    world
        .backend
        .answer("/api/v1/sessions/current", Value::Null);

    world.engine.sign_out();
    let view = world
        .until(
            |v| v.auth == runova_ffi::view::AuthState::SignedOut,
            "signed out",
        )
        .await;

    assert_eq!(
        world.backend.sent()[0],
        (
            "DELETE".to_owned(),
            "/api/v1/sessions/current".to_owned(),
            json!({})
        )
    );
    assert_eq!(world.store.get("tokens".into()), None);
    assert_eq!(world.store.get("identity-seed".into()), None);
    assert_eq!(world.store.get("device-id".into()), None);
    assert!(view.account.profile.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_can_be_forgotten_by_the_computer_it_is_on() {
    let world = connected().await;
    world
        .computer
        .answer("phone.forget", json!({"ok": true, "message": "Forgotten."}));

    world.engine.forget_this_phone();
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("phone.forget").is_empty(),
            "sent",
        )
        .await;
    world.until(|v| v.connection.is_none(), "left").await;
}
