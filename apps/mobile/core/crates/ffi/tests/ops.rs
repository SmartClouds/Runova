mod common;

use common::{World, connected, signed_in};
use runova_ffi::view::{MonitorSource, MonitorState, PipelineRunState, Section, WorkflowInputKind};
use serde_json::{Value, json};
use std::collections::HashMap;

fn local() -> Value {
    json!([{"id": "h1", "name": "API", "state": "pass", "paused": false, "latencyMs": 42,
            "uptime24h": 99.5, "headline": "All good", "samples": [40.0, 50.0]}])
}

fn cloud() -> Value {
    json!({"items": [{"id": "m1", "name": "Shop", "paused": false, "canWrite": true,
        "status": {"verdict": "down", "latencyMs": null, "uptime24h": 90.0, "problem": "Timed out"}}]})
}

const CLOUD: &str = "/api/v1/cloud-monitors";

#[tokio::test(flavor = "multi_thread")]
async fn local_and_cloud_monitors_are_both_listed_and_labeled() {
    let world = connected().await;
    world.computer.answer("monitoring.list", local());
    world.backend.answer(CLOUD, cloud());

    world.engine.open_section(Some(Section::Monitoring));
    let view = world
        .until(
            |v| !v.monitoring.local.is_empty() && !v.monitoring.cloud.is_empty(),
            "both",
        )
        .await;

    let here = &view.monitoring.local[0];
    assert_eq!(here.source, MonitorSource::Local);
    assert_eq!(here.state, MonitorState::Up);
    assert_eq!(here.latency_label.as_deref(), Some("42 ms"));
    assert_eq!(here.uptime_label.as_deref(), Some("99.5%"));
    assert_eq!(here.samples, [40.0, 50.0]);
    let there = &view.monitoring.cloud[0];
    assert_eq!(there.source, MonitorSource::Cloud);
    assert_eq!(there.state, MonitorState::Down);
    assert_eq!(there.detail.as_deref(), Some("Timed out"));
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_computer_cloud_monitors_still_work_and_local_ones_say_why_not() {
    let world = signed_in().await;
    world.backend.answer(CLOUD, cloud());

    world.engine.open_section(Some(Section::Monitoring));
    let view = world
        .until(|v| !v.monitoring.cloud.is_empty(), "the cloud list")
        .await;

    assert!(view.monitoring.local.is_empty());
    assert_eq!(
        view.monitoring.local_note.as_deref(),
        Some("Connect to a computer to see the monitors it runs.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_monitor_can_be_checked_now() {
    let world = connected().await;
    world.computer.answer("monitoring.list", local());
    world.computer.answer(
        "monitoring.check",
        json!({"ok": true, "message": "Checked."}),
    );

    world.engine.monitor_check("h1".into());
    world.until(|v| v.notice.is_some(), "done").await;

    assert_eq!(
        world.computer.params_of("monitoring.check"),
        vec![Some(json!({"id": "h1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn pausing_goes_to_whoever_runs_the_monitor() {
    let world = connected().await;
    world.computer.answer(
        "monitoring.pause",
        json!({"ok": true, "message": "Paused."}),
    );
    world.backend.answer("/api/v1/cloud-monitors/m1", json!({}));

    world
        .engine
        .monitor_set_paused("h1".into(), MonitorSource::Local, true);
    world
        .until(
            |_| !world.computer.params_of("monitoring.pause").is_empty(),
            "local",
        )
        .await;
    world
        .engine
        .monitor_set_paused("m1".into(), MonitorSource::Cloud, true);
    world
        .until(|_| !world.backend.sent().is_empty(), "cloud")
        .await;

    assert_eq!(
        world.computer.params_of("monitoring.pause"),
        vec![Some(json!({"id": "h1", "paused": true}))]
    );
    assert_eq!(
        world.backend.sent(),
        vec![(
            "PATCH".to_owned(),
            "/api/v1/cloud-monitors/m1".to_owned(),
            json!({"paused": true})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_monitor_opens_and_closes() {
    let world = signed_in().await;
    world.backend.answer(CLOUD, cloud());
    world.engine.open_section(Some(Section::Monitoring));
    world
        .until(|v| !v.monitoring.cloud.is_empty(), "the list")
        .await;

    world.engine.monitor_open("m1".into());
    world
        .until(|v| v.monitoring.open.as_deref() == Some("m1"), "open")
        .await;

    world.engine.monitor_close();
    world.until(|v| v.monitoring.open.is_none(), "closed").await;
}

fn status() -> Value {
    json!({"problem": null, "workflows": [{
        "id": 7, "name": "CI", "canDispatch": true,
        "run": {"id": 100, "title": "Fix it", "branch": "master", "number": 12,
                "status": "in_progress", "conclusion": null},
    }, {
        "id": 8, "name": "Nightly", "canDispatch": false,
        "run": {"id": 101, "title": "Build", "branch": "master", "number": 3,
                "status": "completed", "conclusion": "failure"},
    }, {"id": 9, "name": "Never", "canDispatch": true, "run": null}, {
        "id": 11, "name": "Release", "canDispatch": true, "run": null, "inputs": [
            {"name": "version", "description": "Which version", "required": true, "type": "string", "default": "", "options": []},
            {"name": "channel", "description": "Where to", "required": false, "type": "choice", "default": "beta", "options": ["beta", "stable"]},
            {"name": "dry", "description": "", "required": false, "type": "boolean", "default": "false", "options": []},
        ],
    }]})
}

async fn on_pipelines() -> World {
    let world = connected().await;
    world.computer.answer("pipelines.status", status());
    world.engine.select_project(Some("p1".into()));
    world
        .until(|v| v.selected_project.is_some(), "project")
        .await;
    world.engine.open_section(Some(Section::Pipelines));
    world
        .until(|v| v.pipelines.status.is_some(), "the status")
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn workflows_show_their_latest_run() {
    let world = on_pipelines().await;

    let status = world.latest().unwrap().pipelines.status.unwrap();

    let run = status.workflows[0].run.as_ref().unwrap();
    assert_eq!(run.state, PipelineRunState::Running);
    assert_eq!(run.state_label, "Running");
    assert!(run.can_cancel);
    let failed = status.workflows[1].run.as_ref().unwrap();
    assert_eq!(failed.state, PipelineRunState::Failed);
    assert!(!failed.can_cancel);
    assert!(status.workflows[2].run.is_none());
    assert_eq!(
        world.computer.params_of("pipelines.status")[0],
        Some(json!({"projectId": "p1"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_without_gh_says_so() {
    let world = connected().await;
    world.computer.answer(
        "pipelines.status",
        json!({"problem": "GitHub CLI isn't signed in on this computer.", "workflows": []}),
    );
    world.engine.select_project(Some("p1".into()));
    world
        .until(|v| v.selected_project.is_some(), "project")
        .await;

    world.engine.open_section(Some(Section::Pipelines));
    let view = world
        .until(|v| v.pipelines.status.is_some(), "the status")
        .await;

    assert_eq!(
        view.pipelines.status.unwrap().problem.as_deref(),
        Some("GitHub CLI isn't signed in on this computer.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_opens_its_jobs_and_a_job_its_log() {
    let world = on_pipelines().await;
    world.computer.answer(
        "pipelines.run",
        json!({"jobs": [{"id": 5, "name": "build", "status": "completed", "conclusion": "failure"}]}),
    );
    world.computer.answer(
        "pipelines.jobLog",
        json!({"truncated": true, "lines": [{"text": "boom", "error": true}]}),
    );

    world.engine.pipelines_open_run(100);
    let view = world
        .until(
            |v| v.pipelines.run.as_ref().is_some_and(|r| !r.jobs.is_empty()),
            "the jobs",
        )
        .await;
    assert_eq!(
        view.pipelines.run.unwrap().jobs[0].state,
        PipelineRunState::Failed
    );

    world.engine.pipelines_open_job(5);
    let view = world
        .until(
            |v| {
                v.pipelines
                    .log
                    .as_ref()
                    .is_some_and(|l| !l.lines.is_empty())
            },
            "the log",
        )
        .await;
    let log = view.pipelines.log.unwrap();
    assert!(log.truncated);
    assert!(log.lines[0].error);
    assert_eq!(
        world.computer.params_of("pipelines.jobLog"),
        vec![Some(json!({"projectId": "p1", "runId": 100, "jobId": 5}))]
    );

    world.engine.pipelines_close_job();
    world.until(|v| v.pipelines.log.is_none(), "closed").await;
    world.engine.pipelines_close_run();
    world.until(|v| v.pipelines.run.is_none(), "closed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_workflow_with_inputs_opens_a_form_first() {
    let world = on_pipelines().await;

    world.engine.pipelines_dispatch(11);
    let view = world
        .until(|v| v.pipelines.dispatch_form.is_some(), "the form")
        .await;

    let form = view.pipelines.dispatch_form.unwrap();
    assert_eq!(form.name, "Release");
    assert_eq!(form.inputs[0].kind, WorkflowInputKind::Text);
    assert_eq!(form.inputs[1].kind, WorkflowInputKind::Choice);
    assert_eq!(form.inputs[1].default_value, "beta");
    assert_eq!(form.inputs[2].kind, WorkflowInputKind::Toggle);
    assert!(view.confirm.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_required_input_has_to_be_filled_in() {
    let world = on_pipelines().await;
    world.engine.pipelines_dispatch(11);
    world
        .until(|v| v.pipelines.dispatch_form.is_some(), "the form")
        .await;

    world
        .engine
        .pipelines_submit_dispatch(HashMap::from([("version".to_owned(), "  ".to_owned())]));
    let view = world
        .until(
            |v| {
                v.pipelines
                    .dispatch_form
                    .as_ref()
                    .is_some_and(|f| f.error.is_some())
            },
            "the message",
        )
        .await;

    assert_eq!(
        view.pipelines.dispatch_form.unwrap().error.as_deref(),
        Some("Fill in version.")
    );
    assert!(view.confirm.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn filled_in_inputs_are_sent_after_asking() {
    let world = on_pipelines().await;
    world.computer.answer(
        "pipelines.dispatch",
        json!({"ok": true, "message": "Started."}),
    );
    world.engine.pipelines_dispatch(11);
    world
        .until(|v| v.pipelines.dispatch_form.is_some(), "the form")
        .await;

    world.engine.pipelines_submit_dispatch(HashMap::from([
        ("version".to_owned(), "1.2.3".to_owned()),
        ("channel".to_owned(), "stable".to_owned()),
    ]));
    world
        .until(
            |v| v.confirm.is_some() && v.pipelines.dispatch_form.is_none(),
            "the question",
        )
        .await;
    assert!(world.computer.params_of("pipelines.dispatch").is_empty());
    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("pipelines.dispatch").is_empty(),
            "sent",
        )
        .await;

    assert_eq!(
        world.computer.params_of("pipelines.dispatch"),
        vec![Some(json!({
            "projectId": "p1", "workflowId": 11,
            "inputs": {"version": "1.2.3", "channel": "stable"},
        }))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_form_can_be_left() {
    let world = on_pipelines().await;
    world.engine.pipelines_dispatch(11);
    world
        .until(|v| v.pipelines.dispatch_form.is_some(), "the form")
        .await;

    world.engine.pipelines_close_dispatch();

    world
        .until(|v| v.pipelines.dispatch_form.is_none(), "closed")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_and_cancel_ask_first() {
    let world = on_pipelines().await;
    world.computer.answer(
        "pipelines.dispatch",
        json!({"ok": true, "message": "Started."}),
    );
    world.computer.answer(
        "pipelines.cancel",
        json!({"ok": true, "message": "Cancelled."}),
    );

    world.engine.pipelines_dispatch(7);
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.computer.params_of("pipelines.dispatch").is_empty());
    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("pipelines.dispatch").is_empty(),
            "sent",
        )
        .await;
    assert_eq!(
        world.computer.params_of("pipelines.dispatch"),
        vec![Some(json!({"projectId": "p1", "workflowId": 7}))]
    );

    world.until(|v| v.confirm.is_none(), "answered").await;
    world.engine.pipelines_cancel(100);
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("pipelines.cancel").is_empty(),
            "sent",
        )
        .await;
    assert_eq!(
        world.computer.params_of("pipelines.cancel"),
        vec![Some(json!({"projectId": "p1", "runId": 100}))]
    );
}
