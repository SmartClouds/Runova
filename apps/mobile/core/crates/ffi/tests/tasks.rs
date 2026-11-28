mod common;

use common::{World, connected};
use runova_ffi::view::{Section, TaskEditInput};
use serde_json::{Value, json};

fn row(id: &str, status: &str, label: &str) -> Value {
    json!({
        "id": id, "title": format!("Task {id}"), "status": status, "statusLabel": label,
        "priority": "p1", "size": "m", "milestone": "M001", "labels": [], "due": "2026-12-05",
        "agent": null, "checked": 1, "total": 3,
    })
}

fn overview(run: Value) -> Value {
    json!({
        "exists": true,
        "plan": {"title": "Gift cards", "mode": "plan", "goal": "Pay with a gift card."},
        "done": 1, "total": 3,
        "counts": {"todo": 1, "inProgress": 0, "testing": 0, "done": 1, "blocked": 1},
        "milestones": [{"id": "M001", "title": "Pay", "status": "active", "target": null, "done": 1, "total": 2}],
        "needsYou": [row("T002", "blocked", "Blocked")],
        "questions": [{"id": "Q001", "title": "Shipping?"}],
        "workarounds": 1, "risks": 0, "run": run,
    })
}

fn detail() -> Value {
    json!({
        "task": row("T002", "blocked", "Blocked"),
        "depends": [], "attempt": 2,
        "sections": [{"heading": "Goal", "text": "Split a payment."}],
        "acceptance": [{"text": "Works", "checked": true}, {"text": "Fast", "checked": false}],
        "body": "## Goal\n\nSplit a payment.\n",
        "handoff": {"outcome": "blocked", "tests": "failed", "leg": 2,
                    "sections": [{"heading": "next", "text": "Which provider?"}]},
        "journal": [{"heading": "2026-11-28 09:30 session 1", "lines": ["Result: continue"]}],
    })
}

async fn on_tasks(run: Value) -> World {
    let world = connected().await;
    world.computer.answer("tasks.overview", overview(run));
    world.computer.answer(
        "tasks.board",
        json!([
            row("T001", "done", "Done"),
            row("T002", "blocked", "Blocked")
        ]),
    );
    world.computer.answer("tasks.detail", detail());
    world.engine.select_project(Some("p1".to_owned()));
    world.engine.open_section(Some(Section::Tasks));
    world
        .until(|v| v.tasks.overview.is_some(), "the overview")
        .await;
    world
}

fn ok() -> Value {
    json!({"ok": true, "message": "Done."})
}

#[tokio::test(flavor = "multi_thread")]
async fn the_overview_reads_as_the_plan_at_a_glance() {
    let world = on_tasks(json!({"id": "r1", "status": "running", "taskId": "T003"})).await;
    let view = world.until(|v| v.tasks.tasks.len() == 2, "the tasks").await;
    let overview = view.tasks.overview.unwrap();

    assert_eq!(overview.title, "Gift cards");
    assert_eq!(overview.mode_label, "Plan mode, no context budget");
    assert_eq!(overview.progress_label, "1 of 3 tasks done");
    assert_eq!(overview.percent, 33);
    assert_eq!(overview.counts_label, "1 to do, 1 blocked");
    assert_eq!(overview.milestones[0].label, "1 of 2 done");
    assert_eq!(overview.records_label.as_deref(), Some("1 open workaround"));
    assert_eq!(overview.questions[0].title, "Shipping?");
    let run = overview.run.unwrap();
    assert_eq!(run.label, "Running T003");
    assert!(run.can_pause && !run.can_resume);
    assert!(!overview.can_start);
    assert_eq!(
        view.tasks.tasks[1].meta,
        "P1 · Size M · M001 · due 2026-12-05 · 1 of 3 criteria"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_opens_with_its_spec_criteria_handoff_and_journal() {
    let world = on_tasks(Value::Null).await;
    world.engine.tasks_open_task("T002".to_owned());
    let view = world.until(|v| v.tasks.detail.is_some(), "the task").await;
    let detail = view.tasks.detail.unwrap();

    assert_eq!(detail.attempt_label.as_deref(), Some("Attempt 2"));
    assert_eq!(detail.sections[0].text, "Split a payment.");
    assert_eq!(detail.acceptance.len(), 2);
    assert!(detail.acceptance[0].checked);
    let handoff = detail.handoff.unwrap();
    assert_eq!(handoff.summary, "Blocked, tests fail, session 2");
    assert_eq!(handoff.sections[0].heading, "Next step");
    assert_eq!(detail.journal[0].lines, vec!["Result: continue"]);
    assert!(detail.moves.iter().all(|m| m.status != "blocked"));
    assert!(view.tasks.overview.unwrap().can_start);
    assert_eq!(
        world.computer.params_of("tasks.detail")[0],
        Some(json!({"projectId": "p1", "taskId": "T002"}))
    );

    world.engine.tasks_close_task();
    world.until(|v| v.tasks.detail.is_none(), "closed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edits_go_to_the_computer_with_the_project_and_read_the_plan_again() {
    let world = on_tasks(Value::Null).await;
    for method in [
        "tasks.setStatus",
        "tasks.toggleAcceptance",
        "tasks.create",
        "tasks.update",
        "tasks.saveBody",
        "tasks.saveItem",
    ] {
        world.computer.answer(method, ok());
    }
    world.engine.tasks_open_task("T002".to_owned());
    world.until(|v| v.tasks.detail.is_some(), "the task").await;

    // The box ticks at once; the computer's answer to the next read then has the last word.
    world.engine.tasks_toggle("T002".to_owned(), 1, true);
    world
        .engine
        .tasks_set_status("T002".to_owned(), "todo".to_owned());
    world
        .engine
        .tasks_create("Export".to_owned(), Some("p2".to_owned()));
    world.engine.tasks_update(
        "T002".to_owned(),
        TaskEditInput {
            title: "Split".to_owned(),
            priority: Some("p0".to_owned()),
            size: None,
            due: None,
        },
    );
    world
        .engine
        .tasks_answer_question("Q001".to_owned(), "No.".to_owned());
    world.engine.tasks_add_record(
        "workaround".to_owned(),
        "Pin zod".to_owned(),
        Some("Pinned it.".to_owned()),
    );
    world
        .until(|v| v.notice.as_deref() == Some("Done."), "a notice")
        .await;
    for _ in 0..200 {
        if world.computer.params_of("tasks.saveItem").len() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    assert_eq!(
        world.computer.params_of("tasks.toggleAcceptance")[0],
        Some(json!({"projectId": "p1", "taskId": "T002", "index": 1, "checked": true}))
    );
    assert_eq!(
        world.computer.params_of("tasks.setStatus")[0],
        Some(json!({"projectId": "p1", "taskId": "T002", "status": "todo"}))
    );
    assert_eq!(
        world.computer.params_of("tasks.update")[0],
        Some(json!({"projectId": "p1", "taskId": "T002",
            "patch": {"title": "Split", "priority": "p0", "size": null, "due": null}}))
    );
    let items = world.computer.params_of("tasks.saveItem");
    assert!(items.contains(&Some(json!({"projectId": "p1", "item": {
        "kind": "question", "id": "Q001", "status": "answered", "sections": {"Answer": "No."}}}))));
    assert!(items.contains(&Some(json!({"projectId": "p1", "item": {
        "kind": "workaround", "title": "Pin zod", "sections": {"What we did": "Pinned it."}}}))));
    assert!(world.computer.params_of("tasks.overview").len() >= 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn records_show_by_kind() {
    let world = on_tasks(Value::Null).await;
    world.computer.answer(
        "tasks.items",
        json!([{"id": "W001", "title": "Pin zod", "status": "open", "statuses": ["open", "fixed"],
                "details": [{"label": "Waits on", "value": "zod"}],
                "sections": [{"heading": "What we did", "text": "Pinned."}]}]),
    );
    world
        .engine
        .tasks_show_records(Some("workaround".to_owned()));
    let view = world
        .until(|v| !v.tasks.records.is_empty(), "the records")
        .await;
    let record = &view.tasks.records[0];

    assert_eq!(record.details[0].heading, "Waits on");
    assert_eq!(record.details[0].text, "zod");
    assert_eq!(record.sections[0].text, "Pinned.");
    assert_eq!(
        world.computer.params_of("tasks.items")[0],
        Some(json!({"projectId": "p1", "kind": "workaround"}))
    );
    world.engine.tasks_show_records(None);
    world.until(|v| v.tasks.records.is_empty(), "cleared").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_split_is_planned_on_the_computer_and_added_on_request() {
    let world = on_tasks(Value::Null).await;
    let proposal = json!({"summary": "Two.", "add": [{"title": "A"}, {"title": "B"}],
        "change": [], "split": [], "remove": []});
    world.computer.answer(
        "tasks.split",
        json!({"ok": true, "error": null, "summary": "Two parts.",
            "entries": [{"kind": "add", "id": "T003", "title": "A"}, {"kind": "add", "id": "T004", "title": "B"}],
            "extras": "Also writes the plan.", "proposal": proposal}),
    );
    world.computer.answer("tasks.applyProposal", ok());
    world
        .engine
        .tasks_split("Search everywhere".to_owned(), true);
    let view = world
        .until(|v| v.tasks.split.summary.is_some(), "the plan")
        .await;

    assert_eq!(view.tasks.split.entries, vec!["T003 A", "T004 B"]);
    assert_eq!(
        view.tasks.split.extras.as_deref(),
        Some("Also writes the plan.")
    );
    assert!(view.tasks.split.plan_only);
    let asked = world.computer.params_of("tasks.split")[0].clone().unwrap();
    assert_eq!(asked["mode"], "plan");
    assert_eq!(asked["request"], "Search everywhere");
    assert!(
        asked["requestId"]
            .as_str()
            .unwrap()
            .starts_with("phone-split-")
    );

    world.engine.tasks_add_split();
    world
        .until(|v| v.tasks.split.summary.is_none(), "cleared")
        .await;
    for _ in 0..200 {
        if !world.computer.params_of("tasks.applyProposal").is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        world.computer.params_of("tasks.applyProposal")[0],
        Some(json!({"projectId": "p1", "proposal": proposal, "mode": "plan"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_split_says_why() {
    let world = on_tasks(Value::Null).await;
    world.computer.answer(
        "tasks.split",
        json!({"ok": false, "error": "Claude Code is not signed in.", "summary": "", "entries": [], "proposal": null}),
    );
    world.engine.tasks_split("x".to_owned(), false);
    let view = world
        .until(|v| v.tasks.split.error.is_some(), "the error")
        .await;
    assert_eq!(
        view.tasks.split.error.as_deref(),
        Some("Claude Code is not signed in.")
    );
    assert!(!view.tasks.split.running);
}

#[tokio::test(flavor = "multi_thread")]
async fn redo_and_running_ask_first() {
    let world = on_tasks(json!({"id": "r1", "status": "paused", "taskId": null})).await;
    for method in ["tasks.redo", "tasks.start", "tasks.pause", "tasks.resume"] {
        world.computer.answer(method, ok());
    }
    world
        .engine
        .tasks_redo("T002".to_owned(), Some("codex-cli".to_owned()), true);
    let asked = world.until(|v| v.confirm.is_some(), "the question").await;
    assert_eq!(asked.confirm.unwrap().title, "Redo T002?");
    world.engine.confirm();
    world
        .until(|v| v.notice.as_deref() == Some("Done."), "redone")
        .await;
    assert_eq!(
        world.computer.params_of("tasks.redo")[0],
        Some(
            json!({"projectId": "p1", "taskIds": ["T002"], "agent": "codex-cli",
            "keepLearnings": true, "start": true})
        )
    );

    let view = world.latest().unwrap();
    assert!(view.tasks.overview.unwrap().run.unwrap().can_resume);
    world.engine.tasks_resume();
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();
    for _ in 0..200 {
        if !world.computer.params_of("tasks.resume").is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        world.computer.params_of("tasks.resume")[0],
        Some(json!({"projectId": "p1"}))
    );
}
