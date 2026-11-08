mod common;

use common::{World, connected};
use runova_ffi::view::{ProblemSeverity, Section};
use serde_json::{Value, json};

fn servers() -> Value {
    json!([
        {"id": "srv1", "name": "Prod", "host": "10.0.0.1", "state": "online", "problem": null},
        {"id": "srv2", "name": "Lab", "host": "10.0.0.2", "state": "needs-sign-in", "problem": null},
    ])
}

fn overview() -> Value {
    json!({
        "reachable": true,
        "version": "1.2.3",
        "containers": [
            {"id": "c1", "name": "web", "image": "nginx", "state": "running", "status": "Up 2 hours", "health": "healthy"},
            {"id": "c2", "name": "db", "image": "pg", "state": "exited", "status": "Exited (1)", "health": "unhealthy"},
        ],
        "stacks": [{"id": "s1", "name": "shop", "status": "running", "running": 2, "total": 3, "canRedeploy": true}],
        "problems": [{"id": "p1", "severity": "critical", "title": "db keeps restarting", "detail": "3 restarts"}],
        "lastBackup": {"state": "failed", "planName": "Nightly", "error": "Disk full"},
    })
}

const OK: fn() -> Value = || json!({"ok": true, "message": "Restarted."});

async fn on_deploy() -> World {
    let world = connected().await;
    world.computer.answer("deploy.servers", servers());
    world.computer.answer("deploy.overview", overview());
    world.engine.open_section(Some(Section::Deploy));
    world
        .until(|v| !v.deploy.servers.is_empty(), "the servers")
        .await;
    world
}

async fn on_server() -> World {
    let world = on_deploy().await;
    world.engine.deploy_open_server("srv1".into());
    world
        .until(
            |v| v.deploy.server.as_ref().is_some_and(|s| !s.loading),
            "the server",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn each_server_says_how_it_is_connected() {
    let world = on_deploy().await;

    let servers = world.latest().unwrap().deploy.servers;

    assert_eq!(servers[0].state_label, "Online");
    assert!(servers[0].online);
    assert_eq!(servers[1].state_label, "Needs sign-in");
    assert!(!servers[1].online);
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_a_server_shows_its_overview() {
    let world = on_server().await;

    let server = world.latest().unwrap().deploy.server.unwrap();

    assert_eq!(
        world.computer.params_of("deploy.overview")[0],
        Some(json!({"serverId": "srv1"}))
    );
    assert!(server.containers[0].running);
    assert_eq!(server.containers[1].healthy, Some(false));
    assert_eq!(server.stacks[0].detail, "2 of 3 running");
    assert_eq!(server.problems[0].severity, ProblemSeverity::Critical);
    let backup = server.backup.unwrap();
    assert!(backup.failed);
    assert_eq!(backup.detail, "Disk full");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_server_says_so() {
    let world = on_deploy().await;
    world
        .computer
        .answer("deploy.overview", json!({"reachable": false}));

    world.engine.deploy_open_server("srv1".into());
    let view = world
        .until(
            |v| {
                v.deploy
                    .server
                    .as_ref()
                    .is_some_and(|s| s.unreachable.is_some())
            },
            "the message",
        )
        .await;

    assert_eq!(
        view.deploy.server.unwrap().unreachable.as_deref(),
        Some("This computer can't reach that server right now.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restarting_a_container_asks_first() {
    let world = on_server().await;
    world.computer.answer("deploy.containerAction", OK());

    world
        .engine
        .deploy_container_action("c1".into(), "restart".into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(view.confirm.unwrap().detail.contains("web"));
    assert!(
        world
            .computer
            .params_of("deploy.containerAction")
            .is_empty()
    );

    world.engine.confirm();
    world.until(|v| v.notice.is_some(), "done").await;

    assert_eq!(
        world.computer.params_of("deploy.containerAction"),
        vec![Some(
            json!({"serverId": "srv1", "containerId": "c1", "action": "restart"})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn starting_a_stopped_container_just_starts_it() {
    let world = on_server().await;
    world.computer.answer("deploy.containerAction", OK());

    world
        .engine
        .deploy_container_action("c2".into(), "start".into());
    world.until(|v| v.notice.is_some(), "done").await;

    assert!(world.latest().unwrap().confirm.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn redeploying_asks_first() {
    let world = on_server().await;
    world.computer.answer("deploy.stackRedeploy", OK());

    world.engine.deploy_stack_redeploy("s1".into());
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.computer.params_of("deploy.stackRedeploy").is_empty());

    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("deploy.stackRedeploy").is_empty(),
            "sent",
        )
        .await;

    assert_eq!(
        world.computer.params_of("deploy.stackRedeploy"),
        vec![Some(json!({"serverId": "srv1", "stack": "s1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stack_action_asks_first() {
    let world = on_server().await;
    world.computer.answer("deploy.stackAction", OK());

    world
        .engine
        .deploy_stack_action("s1".into(), "restart".into());
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("deploy.stackAction").is_empty(),
            "sent",
        )
        .await;

    assert_eq!(
        world.computer.params_of("deploy.stackAction"),
        vec![Some(
            json!({"serverId": "srv1", "stack": "s1", "action": "restart"})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn logs_refresh_while_open_and_stop_when_closed() {
    let world = on_server().await;
    world.computer.answer(
        "deploy.containerLogs",
        json!([{"text": "started", "error": false}, {"text": "oops", "error": true}]),
    );

    world.engine.deploy_open_logs("c1".into());
    let view = world
        .until(
            |v| v.deploy.logs.as_ref().is_some_and(|l| !l.lines.is_empty()),
            "the logs",
        )
        .await;
    let logs = view.deploy.logs.unwrap();
    assert_eq!(logs.name, "web");
    assert!(logs.lines[1].error);
    let asked = || world.computer.params_of("deploy.containerLogs").len();
    world.until(|_| asked() >= 3, "refreshes").await;

    world.engine.deploy_close_logs();
    world.until(|v| v.deploy.logs.is_none(), "closed").await;
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    let after_closing = asked();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    assert_eq!(asked(), after_closing);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_server_forgets_it() {
    let world = on_server().await;

    world.engine.deploy_close_server();

    world.until(|v| v.deploy.server.is_none(), "closed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_computer_forgets_all_of_it() {
    let world = on_server().await;

    world.engine.disconnect();

    let view = world
        .until(|v| v.connection.is_none(), "disconnected")
        .await;
    assert!(view.deploy.servers.is_empty());
    assert!(view.deploy.server.is_none());
}
