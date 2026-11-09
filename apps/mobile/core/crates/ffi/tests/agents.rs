mod common;

use common::{World, connected};
use runova_ffi::view::{AutoFixTone, Section};
use serde_json::{Value, json};

fn status(state: &str) -> Value {
    json!({
        "problem": null, "hasWorkflows": true, "repo": "a/b", "defaultBranch": "main",
        "workflows": [{
            "id": 7, "name": "CI", "state": "active", "canDispatch": true, "inputs": [],
            "run": {"id": 41, "number": 41, "title": "Fix login", "branch": "main", "event": "push",
                    "status": "completed", "conclusion": state, "canCancel": false},
        }],
    })
}

fn session(phase: &str, blocker: Option<&str>) -> Value {
    json!({
        "id": "s1", "projectId": "p1", "workflowId": 7, "workflowName": "CI", "branch": "main",
        "phase": phase, "blocker": blocker, "message": "The tree is dirty.", "maxAttempts": 3,
        "runNumber": 41, "agentSession": if phase == "fixing" { json!("tab-1") } else { json!(null) },
        "attempts": [{"n": 1, "runNumber": 41, "nextRunNumber": 42, "commit": "abc1234", "outcome": "passed"}],
    })
}

async fn on_pipelines(conclusion: &str, sessions: Value) -> World {
    let world = connected().await;
    world
        .computer
        .answer("pipelines.status", status(conclusion));
    world.computer.answer("autofix.list", sessions);
    world.engine.select_project(Some("p1".to_owned()));
    world.engine.open_section(Some(Section::Pipelines));
    world
        .until(|v| v.pipelines.status.is_some(), "the pipelines")
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_reads_as_a_short_story() {
    let world = on_pipelines("success", json!([session("succeeded", None)])).await;
    let view = world.until(|v| !v.auto_fix.is_empty(), "the session").await;
    let one = &view.auto_fix[0];

    assert_eq!(one.title, "CI on main");
    assert_eq!(one.phase_label, "Fixed");
    assert_eq!(one.tone, AutoFixTone::Done);
    assert_eq!(
        one.timeline,
        vec!["Run #41 failed", "Pushed abc1234", "Run #42 passed"]
    );
    assert!(one.can_dismiss);
    assert!(!one.can_stop);
}

#[tokio::test(flavor = "multi_thread")]
async fn while_fixing_the_agent_can_be_followed() {
    let world = on_pipelines("failure", json!([session("fixing", None)])).await;
    let view = world.until(|v| !v.auto_fix.is_empty(), "the session").await;
    let one = &view.auto_fix[0];

    assert_eq!(one.phase_label, "Fixing 1 of 3");
    assert_eq!(one.agent_session.as_deref(), Some("tab-1"));
    assert!(one.can_stop);
    assert!(one.can_commit);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blocked_session_says_why_and_can_be_retried() {
    let world = on_pipelines("failure", json!([session("attention", Some("dirty-tree"))])).await;
    let view = world.until(|v| !v.auto_fix.is_empty(), "the session").await;

    assert_eq!(view.auto_fix[0].tone, AutoFixTone::Attention);
    assert_eq!(
        view.auto_fix[0].message.as_deref(),
        Some("The tree is dirty.")
    );
    assert!(view.auto_fix[0].can_retry);
}

#[tokio::test(flavor = "multi_thread")]
async fn waiting_on_an_answer_points_at_the_agent_not_retry() {
    let world = on_pipelines(
        "failure",
        json!([session("attention", Some("needs-input"))]),
    )
    .await;
    let view = world.until(|v| !v.auto_fix.is_empty(), "the session").await;

    assert!(!view.auto_fix[0].can_retry);
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_auto_fix_on_names_the_run() {
    let world = on_pipelines("failure", json!([])).await;
    world.computer.answer(
        "autofix.start",
        json!({"ok": true, "message": "Auto-fix is on."}),
    );

    world.engine.auto_fix_start(7, None, None, None);
    world.until(|v| v.notice.is_some(), "the answer").await;
    assert_eq!(
        world.computer.params_of("autofix.start"),
        vec![Some(
            json!({"projectId": "p1", "workflowId": 7, "workflowName": "CI", "branch": "main", "runId": 41, "runNumber": 41})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fix_with_ai_opens_the_agent_it_started() {
    let world = on_pipelines("failure", json!([])).await;
    world.computer.answer(
        "agents.fixRun",
        json!({"sessionId": "tab-9", "title": "Claude Code · from phone"}),
    );
    world.computer.answer(
        "terminals.follow",
        json!({"cols": 80, "rows": 24, "data": ""}),
    );

    world.engine.pipelines_fix_with_ai(
        7,
        Some("claude-code".to_owned()),
        Some("opus".to_owned()),
        Some("high".to_owned()),
    );

    let view = world.until(|v| v.terminal.is_some(), "the terminal").await;
    let sent = world
        .computer
        .params_of("agents.fixRun")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(sent["cliId"], "claude-code");
    assert_eq!(sent["model"], "opus");
    assert_eq!(sent["effort"], "high");
    let terminal = view.terminal.expect("terminal");
    assert_eq!(terminal.session_id, "tab-9");
    assert_eq!(terminal.title, "Claude Code · from phone");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_passed_cannot_be_fixed() {
    let world = on_pipelines("success", json!([])).await;

    world.engine.pipelines_fix_with_ai(7, None, None, None);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    assert!(world.computer.params_of("agents.fixRun").is_empty());
}

async fn on_prompts() -> World {
    let world = connected().await;
    world.computer.answer(
        "prompts.options",
        json!({"types": ["Bug Fix", "Testing"], "targets": [{"id": "codex", "name": "Codex", "models": [{"value": "gpt", "label": "GPT", "tier": "Fast", "efforts": ["low", "high"]}]}], "defaultTarget": "Codex"}),
    );
    world.engine.select_project(Some("p1".to_owned()));
    world.engine.open_section(Some(Section::Prompts));
    world
        .until(|v| v.prompts.options.is_some(), "the choices")
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_prompt_is_written_on_the_computer() {
    let world = on_prompts().await;
    world.computer.answer(
        "prompts.generate",
        json!({"ok": true, "text": "A sharp prompt", "error": null, "cancelled": false}),
    );

    world.engine.prompts_generate(
        "Fix login".to_owned(),
        "Bug Fix".to_owned(),
        "Codex".to_owned(),
    );

    let view = world
        .until(|v| v.prompts.result.is_some(), "the prompt")
        .await;
    assert_eq!(view.prompts.result.as_deref(), Some("A sharp prompt"));
    assert!(!view.prompts.generating);
    let params = world
        .computer
        .params_of("prompts.generate")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(params["promptType"], "Bug Fix");
    assert_eq!(params["targetAI"], "Codex");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_prompt_says_why() {
    let world = on_prompts().await;
    world.computer.answer(
        "prompts.generate",
        json!({"ok": false, "text": "", "error": "No CLI is set up.", "cancelled": false}),
    );

    world.engine.prompts_generate(
        "Fix login".to_owned(),
        "Bug Fix".to_owned(),
        "Codex".to_owned(),
    );

    let view = world
        .until(|v| v.prompts.error.is_some(), "the problem")
        .await;
    assert_eq!(view.prompts.error.as_deref(), Some("No CLI is set up."));
}

#[tokio::test(flavor = "multi_thread")]
async fn sending_starts_an_agent_and_opens_it() {
    let world = on_prompts().await;
    world.computer.answer(
        "agents.runPrompt",
        json!({"sessionId": "tab-5", "title": "Codex · from phone"}),
    );
    world.computer.answer(
        "terminals.follow",
        json!({"cols": 80, "rows": 24, "data": ""}),
    );

    world.engine.prompts_send(
        "Do it".to_owned(),
        Some("codex".to_owned()),
        Some("gpt".to_owned()),
        Some("high".to_owned()),
    );
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.computer.params_of("agents.runPrompt").is_empty());
    world.engine.confirm();

    let view = world.until(|v| v.terminal.is_some(), "the terminal").await;
    assert_eq!(view.terminal.expect("terminal").session_id, "tab-5");
    assert_eq!(
        world.computer.params_of("agents.runPrompt"),
        vec![Some(
            json!({"projectId": "p1", "prompt": "Do it", "cliId": "codex", "model": "gpt", "effort": "high"})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_library_lists_templates_history_and_what_is_waiting() {
    let world = on_prompts().await;
    world.computer.answer("prompts.templates", json!([{"id": "t1", "name": "Bug", "promptType": "Bug Fix", "targetAI": "Codex", "content": "C"}]));
    world.computer.answer("prompts.history", json!([{"id": "h1", "rawInput": "Fix login", "promptType": "Bug Fix", "targetAI": "Codex", "content": "P", "agoMs": 7_200_000}]));
    world.computer.answer(
        "prompts.scheduled",
        json!([{"id": "a", "summary": "Do it", "targetAI": "Codex", "runsInMs": 3_600_000}]),
    );

    world.engine.prompts_load_library(None);

    let view = world
        .until(
            |v| {
                !v.prompts.templates.is_empty()
                    && !v.prompts.history.is_empty()
                    && !v.prompts.scheduled.is_empty()
            },
            "the library",
        )
        .await;
    assert_eq!(view.prompts.templates[0].name, "Bug");
    assert!(
        view.prompts.history[0]
            .meta
            .starts_with("Bug Fix, for Codex, ")
    );
    assert_eq!(view.prompts.scheduled[0].when_label, "In 1 hour");
}

#[tokio::test(flavor = "multi_thread")]
async fn scheduling_asks_first_and_carries_the_pick() {
    let world = on_prompts().await;
    world.computer.answer(
        "prompts.schedule",
        json!({"ok": true, "message": "Scheduled."}),
    );
    world.computer.answer("prompts.templates", json!([]));
    world.computer.answer("prompts.history", json!([]));
    world.computer.answer("prompts.scheduled", json!([]));

    world
        .engine
        .prompts_schedule(runova_ffi::agents::PromptScheduleInput {
            raw_input: "R".to_owned(),
            prompt_type: "Bug Fix".to_owned(),
            target: "Codex".to_owned(),
            content: "C".to_owned(),
            in_ms: 3_600_000,
            cli_id: Some("codex".to_owned()),
            model: Some("gpt".to_owned()),
            effort: None,
        });
    let asked = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(
        asked
            .confirm
            .expect("question")
            .detail
            .contains("in 1 hour")
    );
    assert!(world.computer.params_of("prompts.schedule").is_empty());
    world.engine.confirm();

    world.until(|v| v.notice.is_some(), "scheduled").await;
    let sent = world
        .computer
        .params_of("prompts.schedule")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(sent["inMs"], 3_600_000);
    assert_eq!(sent["cliId"], "codex");
    assert_eq!(sent["model"], "gpt");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_template_is_saved_and_deleting_one_asks() {
    let world = on_prompts().await;
    world.computer.answer(
        "prompts.saveTemplate",
        json!({"ok": true, "message": "Template saved."}),
    );
    world.computer.answer(
        "prompts.deleteTemplate",
        json!({"ok": true, "message": "Template deleted."}),
    );
    world.computer.answer("prompts.templates", json!([]));
    world.computer.answer("prompts.history", json!([]));
    world.computer.answer("prompts.scheduled", json!([]));

    world.engine.prompts_save_template(
        "N".to_owned(),
        "Bug Fix".to_owned(),
        "Codex".to_owned(),
        "C".to_owned(),
    );
    world
        .until(|v| v.notice.as_deref() == Some("Template saved."), "saved")
        .await;

    world.engine.prompts_delete_template("t1".to_owned());
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(
        world
            .computer
            .params_of("prompts.deleteTemplate")
            .is_empty()
    );
    world.engine.confirm();
    world
        .until(
            |v| v.notice.as_deref() == Some("Template deleted."),
            "deleted",
        )
        .await;
}
