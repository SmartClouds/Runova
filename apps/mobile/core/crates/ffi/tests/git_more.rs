mod common;

use common::{World, connected};
use runova_ffi::view::{GitVersionState, Section};
use serde_json::{Value, json};

fn state() -> Value {
    json!({"isRepo": true, "branch": "fix/login", "ahead": 0, "behind": 0, "hasRemote": true,
           "conflicts": [], "staged": [], "unstaged": [], "untracked": []})
}

fn status(pr: Value) -> Value {
    json!({"cliAvailable": true, "authenticated": true, "repo": "a/b", "branch": "fix/login",
           "defaultBranch": "main", "onDefaultBranch": false, "ahead": 2, "dirty": false, "pr": pr, "error": null})
}

fn open_pr() -> Value {
    json!({"number": 12, "title": "Fix login", "url": "https://x/12", "state": "OPEN", "isDraft": false, "base": "main",
           "review": "APPROVED", "additions": 10, "deletions": 2, "checksTotal": 3, "checksFailed": 1, "checksRunning": 0, "unresolved": 2})
}

async fn on_git() -> World {
    let world = connected().await;
    world.computer.answer("git.state", state());
    world.engine.select_project(Some("p1".to_owned()));
    world.engine.open_section(Some(Section::Git));
    world
        .until(|v| v.git.state.is_some(), "the git state")
        .await;
    world
}

async fn on_pr(pr: Value) -> World {
    let world = on_git().await;
    world.computer.answer("git.pr", status(pr));
    world.engine.git_open_pr();
    world
        .until(
            |v| v.git_more.pr.as_ref().is_some_and(|p| !p.loading),
            "the status",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn an_open_pull_request_sums_up_its_state() {
    let world = on_pr(open_pr()).await;
    let view = world.latest().and_then(|v| v.git_more.pr).expect("pr");
    let info = view.pr.expect("info");

    assert!(!view.can_create);
    assert_eq!(info.number, 12);
    assert_eq!(info.state_label, "Open");
    assert_eq!(info.review_label.as_deref(), Some("Approved"));
    assert_eq!(info.meta, "+10 -2, 1 of 3 checks failed");
    assert_eq!(
        info.unresolved_label.as_deref(),
        Some("2 open review threads")
    );
    assert!(info.checks_failed);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_github_cli_says_so() {
    let world = on_git().await;
    world.computer.answer(
        "git.pr",
        json!({"cliAvailable": false, "authenticated": true, "repo": "a/b", "branch": "x", "defaultBranch": "main",
               "onDefaultBranch": false, "ahead": 0, "dirty": false, "pr": null, "error": null}),
    );
    world.engine.git_open_pr();

    let view = world
        .until(
            |v| v.git_more.pr.as_ref().is_some_and(|p| !p.loading),
            "the status",
        )
        .await;
    let pr = view.git_more.pr.expect("pr");
    assert!(pr.note.expect("note").contains("isn't installed"));
    assert!(!pr.can_create);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_ai_writes_the_title_and_body() {
    let world = on_pr(Value::Null).await;
    world.computer.answer(
        "git.suggestPrText",
        json!({"ok": true, "title": "Fix login", "body": "Why", "text": null, "cliName": "Codex", "error": null, "cancelled": false}),
    );

    world.engine.git_suggest_pr();

    let view = world
        .until(
            |v| {
                v.git_more
                    .pr
                    .as_ref()
                    .is_some_and(|p| p.suggestion.is_some())
            },
            "the text",
        )
        .await;
    let suggestion = view
        .git_more
        .pr
        .expect("pr")
        .suggestion
        .expect("suggestion");
    assert_eq!(suggestion.title, "Fix login");
    assert_eq!(suggestion.note, "Written by Codex on this computer");
    let sent = world
        .computer
        .params_of("git.suggestPrText")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(sent["base"], "main");
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_one_asks_and_then_shows_it() {
    let world = on_pr(Value::Null).await;
    world.computer.answer(
        "git.createPr",
        json!({"ok": true, "url": "https://x/12", "error": null, "usedFallback": false}),
    );

    world
        .engine
        .git_create_pr("T".to_owned(), "B".to_owned(), true);
    let asked = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(
        asked
            .confirm
            .expect("question")
            .detail
            .contains("pushed first")
    );
    assert!(world.computer.params_of("git.createPr").is_empty());

    world.computer.answer("git.pr", status(open_pr()));
    world.engine.confirm();

    world
        .until(
            |v| v.git_more.pr.as_ref().is_some_and(|p| p.pr.is_some()),
            "the pull request",
        )
        .await;
    assert_eq!(
        world.computer.params_of("git.createPr"),
        vec![Some(
            json!({"projectId": "p1", "title": "T", "body": "B", "base": "main", "draft": true})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_cli_it_hands_back_a_link() {
    let world = on_pr(Value::Null).await;
    world.computer.answer(
        "git.createPr",
        json!({"ok": true, "url": "https://x/compare", "error": null, "usedFallback": true}),
    );

    world
        .engine
        .git_create_pr("T".to_owned(), "B".to_owned(), false);
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();

    let view = world
        .until(
            |v| {
                v.git_more
                    .pr
                    .as_ref()
                    .is_some_and(|p| p.fallback_url.is_some())
            },
            "the link",
        )
        .await;
    assert_eq!(
        view.git_more.pr.expect("pr").fallback_url.as_deref(),
        Some("https://x/compare")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_review_comes_back_to_edit_and_posting_asks() {
    let world = on_pr(open_pr()).await;
    world.computer.answer(
        "git.reviewPr",
        json!({"ok": true, "text": "Looks fine", "title": null, "body": null, "cliName": "Codex", "error": null, "cancelled": false}),
    );

    world.engine.git_review_pr();
    let view = world
        .until(
            |v| v.git_more.pr.as_ref().is_some_and(|p| p.review.is_some()),
            "the review",
        )
        .await;
    assert_eq!(
        view.git_more.pr.expect("pr").review.as_deref(),
        Some("Looks fine")
    );

    world
        .computer
        .answer("git.prComment", json!({"ok": true, "message": "Posted."}));
    world.engine.git_post_review("Edited".to_owned());
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.computer.params_of("git.prComment").is_empty());
    world.engine.confirm();

    world.until(|v| v.notice.is_some(), "posted").await;
    assert_eq!(
        world.computer.params_of("git.prComment"),
        vec![Some(
            json!({"projectId": "p1", "number": 12, "body": "Edited"})
        )]
    );
}

fn run(status: &str) -> Value {
    json!({"status": status, "lines": ["Reading package.json"],
           "changes": [{"path": "package.json", "kind": "modified", "additions": 1, "deletions": 1, "kept": true}],
           "warning": null, "error": null, "committedByCli": false})
}

async fn on_version() -> World {
    let world = on_git().await;
    world
        .computer
        .answer("git.applyVersion", json!({"ok": true}));
    world.computer.answer("git.versionRun", run("running"));
    world.engine.git_apply_version("v1.5.0".to_owned());
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();
    world
        .until(|v| v.git_more.version.is_some(), "the run")
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn a_version_run_asks_first_and_is_followed_on_the_tick() {
    let world = on_version().await;
    let sent = world
        .computer
        .params_of("git.applyVersion")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(sent["tag"], "v1.5.0");

    world.computer.answer("git.versionRun", run("done"));
    let view = world
        .until(
            |v| {
                v.git_more
                    .version
                    .as_ref()
                    .is_some_and(|r| r.state == GitVersionState::Done)
            },
            "finished",
        )
        .await;
    let version = view.git_more.version.expect("run");
    assert_eq!(version.files[0].path, "package.json");
    assert_eq!(version.files[0].detail, "modified, +1 -1");
    assert!(version.files[0].kept);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_can_be_put_back() {
    let world = on_version().await;
    world.computer.answer("git.versionRun", run("done"));
    world
        .until(
            |v| {
                v.git_more
                    .version
                    .as_ref()
                    .is_some_and(|r| r.state == GitVersionState::Done)
            },
            "finished",
        )
        .await;
    world.computer.answer(
        "git.versionToggle",
        json!({"ok": true, "message": "Reverted."}),
    );

    world.engine.git_version_toggle("package.json".to_owned());

    world
        .until(
            |_| !world.computer.params_of("git.versionToggle").is_empty(),
            "the call",
        )
        .await;
    let sent = world
        .computer
        .params_of("git.versionToggle")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(sent["path"], "package.json");
}
