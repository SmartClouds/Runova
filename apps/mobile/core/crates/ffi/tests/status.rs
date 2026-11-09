mod common;

use common::{World, connected};
use runova_ffi::view::{LimitState, ProviderState, Section};
use serde_json::{Value, json};

fn system() -> Value {
    json!({
        "cpuModel": "Ryzen 9",
        "cpuCoreCount": 16,
        "cpuPercent": 12.5,
        "memPercent": 50.0,
        "memUsedBytes": 8u64 * 1024 * 1024 * 1024,
        "memTotalBytes": 16u64 * 1024 * 1024 * 1024,
        "netRxBytesPerSec": 1536 * 1024,
        "netTxBytesPerSec": 2048,
    })
}

fn bar() -> Value {
    json!({
        "agents": {"working": 2, "waiting": 1, "finished": 0, "idle": 3},
        "terminals": 4,
        "relays": {"running": 1, "paused": 0, "scheduled": 1, "needsYou": 1},
        "transfers": 2,
        "sync": {"needsSignIn": false, "conflicts": 2, "phase": "idle", "keysNeeded": 0},
        "github": {"login": "sam", "signedIn": true, "checkFailed": false},
        "docker": {"running": 2, "total": 5},
        "android": {"running": 1, "booting": 1},
        "keepAwake": {"mode": "agent", "awake": true, "busy": ["agents", "sftp"]},
    })
}

fn usage() -> Value {
    json!({
        "limits": [
            {"providerId": "claude-code", "name": "Claude", "plan": "Max", "state": "ok", "problem": null,
             "windows": [{"label": "5 hours", "percent": 25.0, "resetInMs": 11_520_000}]},
            {"providerId": "codex", "name": "Codex", "plan": null, "state": "stale", "problem": "Offline",
             "windows": [{"label": "Week", "percent": 90.0, "resetInMs": null}]},
            {"providerId": "cursor", "name": "Cursor", "plan": null, "state": "unavailable", "problem": "Signed out", "windows": []},
            {"providerId": "x", "name": "X", "plan": null, "state": "estimate", "problem": null, "windows": []},
        ],
        "providers": [
            {"providerId": "claude-code", "name": "Claude", "status": "ok", "error": null,
             "todayUsd": 1.5, "weekUsd": 10.0, "monthUsd": null, "series": [1.0, 2.0]},
            {"providerId": "codex", "name": "Codex", "status": "connect", "error": null,
             "todayUsd": null, "weekUsd": null, "monthUsd": null, "series": []},
            {"providerId": "cursor", "name": "Cursor", "status": "error", "error": "Bad key",
             "todayUsd": null, "weekUsd": null, "monthUsd": null, "series": []},
        ],
    })
}

async fn on_status() -> World {
    let world = connected().await;
    world.computer.answer("status.system", system());
    world.computer.answer("status.usage", usage());
    world.engine.open_section(Some(Section::Status));
    world
        .until(
            |v| v.status.system.is_some() && !v.status.limits.is_empty(),
            "the status",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_computers_numbers_arrive_ready_to_read() {
    let world = on_status().await;

    let system = world.latest().unwrap().status.system.unwrap();

    assert_eq!(system.cpu_percent, 12.5);
    assert_eq!(system.cpu_label, "12.5%");
    assert_eq!(system.cpu_detail, "Ryzen 9, 16 cores");
    assert_eq!(system.mem_label, "8 GB of 16 GB");
    assert_eq!(system.net_down_label, "1.5 MB/s");
    assert_eq!(system.net_up_label, "2 KB/s");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_rest_of_the_status_bar_arrives_ready_to_read_in_its_order() {
    let world = connected().await;
    world.computer.answer("status.system", system());
    world.computer.answer("status.bar", bar());

    world.engine.open_section(Some(Section::Status));
    let view = world
        .until(|v| !v.status.computer.is_empty(), "the list")
        .await;

    let items = view.status.computer;
    let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "agents",
            "relay",
            "transfers",
            "terminals",
            "sync",
            "github",
            "docker",
            "android",
            "keep-awake"
        ]
    );
    assert_eq!(items[0].value, "1 waiting on you, 2 working, 3 idle");
    assert!(items[0].attention);
    assert_eq!(items[1].value, "1 needs you, 1 running, 1 scheduled");
    assert_eq!(items[2].value, "2 running");
    assert_eq!(items[3].value, "4 running");
    assert_eq!(items[4].value, "2 to review");
    assert_eq!(items[5].value, "@sam");
    assert_eq!(items[6].value, "2 running");
    assert_eq!(items[7].value, "1 running");
    assert_eq!(items[7].detail.as_deref(), Some("1 starting"));
    assert_eq!(items[8].value, "Awake now");
    assert_eq!(
        items[8].detail.as_deref(),
        Some("Set to Agent, awake for an agent at work, file transfers")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn what_the_computer_lacks_stays_off_the_list() {
    let world = connected().await;
    world.computer.answer(
        "status.bar",
        json!({"agents": {"working": 0, "waiting": 0, "finished": 0, "idle": 0}, "terminals": 0,
               "relays": {"running": 0, "paused": 0, "scheduled": 0, "needsYou": 0}, "transfers": 0,
               "sync": null, "github": null, "docker": null, "android": null,
               "keepAwake": {"mode": "off", "awake": false, "busy": []}}),
    );

    world.engine.open_section(Some(Section::Status));
    let view = world
        .until(|v| !v.status.computer.is_empty(), "the list")
        .await;

    let items = view.status.computer;
    let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, ["agents", "keep-awake"]);
    assert_eq!(items[0].value, "None running");
    assert_eq!(items[1].value, "Sleep allowed");
    assert_eq!(items[1].detail.as_deref(), Some("Set to Off"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_github_check_that_failed_keeps_the_login_and_says_so() {
    let world = connected().await;
    world.computer.answer(
        "status.bar",
        json!({"github": {"login": "sam", "signedIn": true, "checkFailed": true}}),
    );

    world.engine.open_section(Some(Section::Status));
    let view = world
        .until(
            |v| v.status.computer.iter().any(|i| i.id == "github"),
            "the list",
        )
        .await;

    let github = view
        .status
        .computer
        .iter()
        .find(|i| i.id == "github")
        .unwrap();
    assert_eq!(github.value, "@sam");
    assert_eq!(github.detail.as_deref(), Some("Couldn't check it just now"));
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_says_the_most_pressing_thing() {
    let cases = [
        (
            json!({"needsSignIn": true, "conflicts": 2, "phase": "error", "keysNeeded": 1}),
            "Sign in again",
            true,
        ),
        (
            json!({"needsSignIn": false, "conflicts": 0, "phase": "syncing", "keysNeeded": 0}),
            "Syncing",
            false,
        ),
        (
            json!({"needsSignIn": false, "conflicts": 0, "phase": "offline", "keysNeeded": 0}),
            "Offline",
            false,
        ),
        (
            json!({"needsSignIn": false, "conflicts": 0, "phase": "error", "keysNeeded": 0}),
            "Sync stopped",
            true,
        ),
        (
            json!({"needsSignIn": false, "conflicts": 0, "phase": "idle", "keysNeeded": 1}),
            "Key needed",
            false,
        ),
        (
            json!({"needsSignIn": false, "conflicts": 0, "phase": "idle", "keysNeeded": 0}),
            "Synced",
            false,
        ),
    ];
    for (sync, label, attention) in cases {
        let world = connected().await;
        world.computer.answer("status.bar", json!({"sync": sync}));
        world.engine.open_section(Some(Section::Status));
        let view = world
            .until(
                |v| v.status.computer.iter().any(|i| i.id == "sync"),
                "the list",
            )
            .await;
        let line = view
            .status
            .computer
            .iter()
            .find(|i| i.id == "sync")
            .unwrap()
            .clone();
        assert_eq!(line.value, label);
        assert_eq!(line.attention, attention);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_that_cannot_answer_the_list_shows_no_error() {
    let world = connected().await;
    world.computer.answer("status.system", system());
    world
        .computer
        .refuse("status.bar", "unknown-method", "Unknown method.");

    world.engine.open_section(Some(Section::Status));
    world
        .until(|v| v.status.system.is_some(), "the numbers")
        .await;
    world
        .until(
            |_| world.computer.params_of("status.bar").len() >= 2,
            "asked twice",
        )
        .await;

    let view = world.latest().unwrap();
    assert_eq!(view.error, None);
    assert!(view.status.computer.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn each_limit_says_how_it_was_read() {
    let world = on_status().await;

    let limits = world.latest().unwrap().status.limits;

    let states: Vec<LimitState> = limits.iter().map(|l| l.state).collect();
    assert_eq!(
        states,
        [
            LimitState::Ok,
            LimitState::Stale,
            LimitState::Unavailable,
            LimitState::Estimate
        ]
    );
    assert_eq!(limits[0].plan.as_deref(), Some("Max"));
    assert_eq!(limits[0].windows[0].percent_label, "25%");
    assert_eq!(
        limits[0].windows[0].resets_label.as_deref(),
        Some("Resets in 3h 12m")
    );
    assert_eq!(limits[1].windows[0].resets_label, None);
    assert_eq!(limits[2].problem.as_deref(), Some("Signed out"));
}

#[tokio::test(flavor = "multi_thread")]
async fn each_provider_shows_what_it_cost() {
    let world = on_status().await;

    let providers = world.latest().unwrap().status.providers;

    assert_eq!(providers[0].state, ProviderState::Ok);
    assert_eq!(providers[0].today_label.as_deref(), Some("$1.50"));
    assert_eq!(providers[0].month_label, None);
    assert_eq!(providers[0].series, [1.0, 2.0]);
    assert_eq!(providers[1].state, ProviderState::Connect);
    assert_eq!(providers[2].state, ProviderState::Error);
    assert_eq!(providers[2].error.as_deref(), Some("Bad key"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_computer_refreshes_often_and_usage_rarely() {
    let world = on_status().await;

    world
        .until(
            |_| world.computer.params_of("status.system").len() >= 5,
            "system samples",
        )
        .await;

    assert!(world.computer.params_of("status.usage").len() < 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_asked_once_the_screen_closes() {
    let world = on_status().await;
    let asked = || world.computer.params_of("status.system").len();

    world.engine.open_section(None);
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    let after_closing = asked();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    assert_eq!(asked(), after_closing);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_provider_opens_and_closes_its_detail() {
    let world = on_status().await;

    world.engine.open_usage_provider("codex".into());
    world
        .until(
            |v| v.status.detail.as_deref() == Some("codex"),
            "the detail",
        )
        .await;

    world.engine.close_usage_provider();
    world.until(|v| v.status.detail.is_none(), "closed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_computer_forgets_its_numbers() {
    let world = on_status().await;

    world.engine.disconnect();

    let view = world
        .until(|v| v.connection.is_none(), "disconnected")
        .await;
    assert!(view.status.system.is_none());
    assert!(view.status.limits.is_empty());
    assert!(view.status.computer.is_empty());
}
