mod common;

use common::{World, connected, signed_in};
use runova_ffi::view::{ErrorLevel, ErrorStatus, Section};
use serde_json::{Value, json};

fn issue(status: &str) -> Value {
    json!({
        "connectionId": "c1", "id": "42", "shortId": "WEB-3F", "title": "TypeError: boom",
        "culprit": "checkout/index", "level": "fatal", "status": status, "count": 12,
        "userCount": 1, "isNew": true, "projectId": "p1", "remoteProject": "web",
        "lastSeenAgoMs": 7_200_000,
    })
}

fn list() -> Value {
    json!({"linked": true, "truncated": false, "problems": [], "issues": [issue("unresolved")]})
}

fn detail(status: &str, can_change: bool) -> Value {
    json!({
        "issue": issue(status),
        "canChange": can_change,
        "event": {
            "message": null,
            "environment": "production",
            "release": "1.4.2",
            "request": "POST https://x.test/pay",
            "exceptions": [{
                "type": "TypeError", "value": "boom", "handled": false,
                "frames": [
                    {"file": "app.ts", "function": "run", "line": 7},
                    {"file": "lib.ts", "function": null, "line": null},
                ],
            }],
            "tags": [{"key": "browser", "value": "Chrome"}],
        },
    })
}

async fn on_errors() -> World {
    let world = connected().await;
    world.computer.answer("errors.list", list());
    world.engine.errors_open();
    world
        .until(|v| !v.errors.issues.is_empty(), "the issues")
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn issues_arrive_ready_to_read() {
    let world = on_errors().await;

    let issue = world.latest().unwrap().errors.issues.remove(0);

    assert_eq!(issue.level, ErrorLevel::Fatal);
    assert_eq!(issue.level_label, "Fatal");
    assert_eq!(issue.status, ErrorStatus::Unresolved);
    assert_eq!(issue.culprit.as_deref(), Some("checkout/index"));
    assert_eq!(issue.detail_label, "web, 2h ago, 12 events, 1 user");
    assert_eq!(issue.activity_label, "12 events, 1 user, 2h ago");
    assert_eq!(issue.new_label.as_deref(), Some("New"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_this_phone_knows_goes_by_its_name() {
    let world = signed_in().await;
    world.computer.answer(
        "projects.list",
        json!([{"id": "p1", "name": "Website", "tags": []}]),
    );
    world.computer.answer("errors.list", list());
    world.engine.connect(5);
    world
        .until(|v| !v.projects.is_empty(), "the projects")
        .await;

    world.engine.errors_open();
    let view = world
        .until(|v| !v.errors.issues.is_empty(), "the issues")
        .await;

    assert_eq!(
        view.errors.issues[0].detail_label,
        "Website, 2h ago, 12 events, 1 user"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_computer_it_says_so_and_asks_nothing() {
    let world = signed_in().await;

    world.engine.errors_open();
    let view = world.until(|v| v.errors.open, "open").await;

    assert_eq!(
        view.errors.note.as_deref(),
        Some("Connect to a computer to see its errors.")
    );
    assert!(world.computer.params_of("errors.list").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_linked_is_not_the_same_as_no_errors() {
    let world = connected().await;
    world.computer.answer(
        "errors.list",
        json!({"linked": false, "truncated": false, "problems": [], "issues": []}),
    );

    world.engine.errors_open();
    let view = world.until(|v| v.errors.note.is_some(), "the note").await;

    assert_eq!(
        view.errors.note.as_deref(),
        Some("No Sentry project is linked on this computer.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_list_says_how_far_it_looked() {
    let world = connected().await;
    world.computer.answer(
        "errors.list",
        json!({"linked": true, "truncated": false, "problems": [], "issues": []}),
    );

    world.engine.errors_open();
    let view = world.until(|v| v.errors.note.is_some(), "the note").await;

    assert_eq!(
        view.errors.note.as_deref(),
        Some("No unresolved errors in the last 14 days.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_it_could_not_read_is_named() {
    let world = connected().await;
    world.computer.answer(
        "errors.list",
        json!({"linked": true, "truncated": true,
               "problems": [{"label": "Acme", "message": "The vault is locked.", "locked": true}],
               "issues": [issue("unresolved")]}),
    );

    world.engine.errors_open();
    let view = world
        .until(|v| !v.errors.issues.is_empty(), "the issues")
        .await;

    assert_eq!(view.errors.problems, ["Acme: The vault is locked."]);
    assert_eq!(
        view.errors.cut_note.as_deref(),
        Some("Showing the 50 most recent.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_opens_with_what_went_wrong() {
    let world = on_errors().await;
    world
        .computer
        .answer("errors.show", detail("unresolved", true));

    world.engine.errors_open_issue("c1".into(), "42".into());
    let view = world
        .until(
            |v| {
                v.errors
                    .detail
                    .as_ref()
                    .is_some_and(|d| !d.exceptions.is_empty())
            },
            "the detail",
        )
        .await;

    let detail = view.errors.detail.unwrap();
    assert!(!detail.loading);
    assert_eq!(
        detail.issue.as_ref().unwrap().short_id,
        "WEB-3F",
        "keeps the row while it loads"
    );
    assert_eq!(
        detail.meta_label.as_deref(),
        Some("production, release 1.4.2")
    );
    assert_eq!(detail.exceptions[0].title, "TypeError: boom");
    assert!(detail.exceptions[0].unhandled);
    assert_eq!(detail.exceptions[0].frames, ["app.ts:7 in run", "lib.ts"]);
    assert_eq!(detail.request.as_deref(), Some("POST https://x.test/pay"));
    assert_eq!(detail.tags, ["browser: Chrome"]);
    assert!(detail.can_resolve);
    assert!(!detail.can_reopen);
    assert_eq!(detail.write_note, None);
    assert_eq!(
        world.computer.params_of("errors.show"),
        vec![Some(json!({"connectionId": "c1", "issueId": "42"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resolving_needs_no_question_and_can_be_taken_back() {
    let world = on_errors().await;
    world
        .computer
        .answer("errors.show", detail("unresolved", true));
    world.computer.answer(
        "errors.setStatus",
        json!({"ok": true, "message": "Resolved."}),
    );
    world.engine.errors_open_issue("c1".into(), "42".into());
    world
        .until(
            |v| v.errors.detail.as_ref().is_some_and(|d| d.can_resolve),
            "the detail",
        )
        .await;

    world
        .computer
        .answer("errors.show", detail("resolved", true));
    world.engine.errors_resolve();
    let view = world
        .until(
            |v| v.errors.detail.as_ref().is_some_and(|d| d.can_reopen),
            "reloaded",
        )
        .await;

    assert_eq!(view.confirm, None);
    assert_eq!(view.notice.as_deref(), Some("Resolved."));
    assert_eq!(
        world.computer.params_of("errors.setStatus"),
        vec![Some(
            json!({"connectionId": "c1", "issueId": "42", "status": "resolved"})
        )]
    );
    assert!(world.computer.params_of("errors.list").len() >= 2);

    world.computer.answer(
        "errors.setStatus",
        json!({"ok": true, "message": "Reopened."}),
    );
    world.engine.errors_reopen();
    world
        .until(
            |_| world.computer.params_of("errors.setStatus").len() == 2,
            "reopened",
        )
        .await;
    assert_eq!(
        world.computer.params_of("errors.setStatus")[1],
        Some(json!({"connectionId": "c1", "issueId": "42", "status": "unresolved"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_that_cannot_write_says_so_and_offers_nothing() {
    let world = on_errors().await;
    world
        .computer
        .answer("errors.show", detail("unresolved", false));

    world.engine.errors_open_issue("c1".into(), "42".into());
    let view = world
        .until(
            |v| {
                v.errors
                    .detail
                    .as_ref()
                    .is_some_and(|d| d.write_note.is_some())
            },
            "the detail",
        )
        .await;

    let detail = view.errors.detail.unwrap();
    assert!(!detail.can_resolve);
    assert!(!detail.can_reopen);
    assert_eq!(
        detail.write_note.as_deref(),
        Some("The Sentry token on this computer can't change issues.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_that_failed_to_load_stops_loading_and_says_why() {
    let world = on_errors().await;
    world
        .computer
        .refuse("errors.show", "failed", "The vault is locked.");

    world.engine.errors_open_issue("c1".into(), "42".into());
    let view = world.until(|v| v.error.is_some(), "the error").await;

    assert_eq!(view.error.as_deref(), Some("The vault is locked."));
    assert!(!view.errors.detail.unwrap().loading);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_list_refreshes_slowly_while_open_on_the_monitoring_screen() {
    let world = on_errors().await;

    world.engine.open_section(Some(Section::Monitoring));
    world
        .until(
            |_| world.computer.params_of("monitoring.list").len() >= 5,
            "ticks",
        )
        .await;

    assert!(world.computer.params_of("errors.list").len() < 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_goes_back_a_step_at_a_time() {
    let world = on_errors().await;
    world
        .computer
        .answer("errors.show", detail("unresolved", true));
    world.engine.errors_open_issue("c1".into(), "42".into());
    world
        .until(|v| v.errors.detail.is_some(), "the detail")
        .await;

    world.engine.errors_close_issue();
    let view = world.until(|v| v.errors.detail.is_none(), "the list").await;
    assert!(view.errors.open);

    world.engine.errors_close();
    let view = world.until(|v| !v.errors.open, "closed").await;
    assert!(view.errors.issues.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_computer_forgets_its_errors() {
    let world = on_errors().await;

    world.engine.disconnect();

    let view = world
        .until(|v| v.connection.is_none(), "disconnected")
        .await;
    assert!(view.errors.issues.is_empty());
    assert!(!view.errors.open);
}
