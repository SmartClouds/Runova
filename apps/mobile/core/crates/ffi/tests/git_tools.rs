mod common;

use common::{World, connected};
use runova_ffi::view::{GitAiKind, Section};
use serde_json::{Value, json};

fn state(staged: bool) -> Value {
    let staged_files = if staged {
        json!([{"path": "a.ts", "status": "M"}])
    } else {
        json!([])
    };
    json!({"isRepo": true, "branch": "main", "ahead": 0, "behind": 0, "hasRemote": true,
           "conflicts": [], "staged": staged_files, "unstaged": [], "untracked": []})
}

async fn on_git(staged: bool) -> World {
    let world = connected().await;
    world.computer.answer("git.state", state(staged));
    world.engine.select_project(Some("p1".to_owned()));
    world.engine.open_section(Some(Section::Git));
    world
        .until(|v| v.git.state.is_some(), "the git state")
        .await;
    world
}

fn tags() -> Value {
    json!({"latest": "v1.4.2", "recent": ["v1.4.2", "v1.4.1"], "commitsSince": 3, "hasRemote": true,
           "next": {"patch": "v1.4.3", "minor": "v1.5.0", "major": "v2.0.0"}})
}

async fn on_tags() -> World {
    let world = on_git(false).await;
    world.computer.answer("git.tags", tags());
    world.engine.git_open_tags();
    world
        .until(
            |v| v.git_tools.tags.as_ref().is_some_and(|t| !t.loading),
            "the tags",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn tags_show_the_latest_and_the_next_of_each_size() {
    let world = on_tags().await;
    let view = world.latest().and_then(|v| v.git_tools.tags).expect("tags");

    assert_eq!(view.latest.as_deref(), Some("v1.4.2"));
    assert_eq!(view.commits_label, "3 commits since this tag");
    assert_eq!(view.options[1].kind, "Minor");
    assert_eq!(view.options[1].tag, "v1.5.0");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_computer_suggests_a_version_and_the_phone_shows_why() {
    let world = on_tags().await;
    world.computer.answer(
        "git.suggestTag",
        json!({"ok": true, "tag": "v1.5.0", "reason": "A new feature", "message": "Notes", "cliName": "Claude Code", "error": null, "cancelled": false}),
    );

    world.engine.git_suggest_tag();

    let view = world
        .until(
            |v| {
                v.git_tools
                    .tags
                    .as_ref()
                    .is_some_and(|t| t.suggestion.is_some())
            },
            "the suggestion",
        )
        .await;
    let suggestion = view
        .git_tools
        .tags
        .expect("tags")
        .suggestion
        .expect("suggestion");
    assert_eq!(suggestion.tag, "v1.5.0");
    assert_eq!(suggestion.reason.as_deref(), Some("A new feature"));
    assert_eq!(suggestion.note, "Written by Claude Code on this computer");
    let params = world
        .computer
        .params_of("git.suggestTag")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(params["projectId"], "p1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_suggestion_that_fails_says_why() {
    let world = on_tags().await;
    world.computer.answer(
        "git.suggestTag",
        json!({"ok": false, "tag": null, "reason": null, "message": null, "cliName": null, "error": "No new commits since v1.4.2.", "cancelled": false}),
    );

    world.engine.git_suggest_tag();

    let view = world
        .until(
            |v| v.git_tools.tags.as_ref().is_some_and(|t| t.error.is_some()),
            "the problem",
        )
        .await;
    assert_eq!(
        view.git_tools.tags.expect("tags").error.as_deref(),
        Some("No new commits since v1.4.2.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn pushing_a_tag_asks_first_and_a_local_one_does_not() {
    let world = on_tags().await;
    world
        .computer
        .answer("git.createTag", json!({"ok": true, "message": "Created."}));

    world
        .engine
        .git_create_tag("v1.5.0".to_owned(), "Notes".to_owned(), true);
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.computer.params_of("git.createTag").is_empty());
    world.engine.confirm();
    world.until(|v| v.git_tools.tags.is_none(), "closed").await;
    assert_eq!(
        world.computer.params_of("git.createTag"),
        vec![Some(
            json!({"projectId": "p1", "tag": "v1.5.0", "message": "Notes", "push": true})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_tag_keeps_the_form_open() {
    let world = on_tags().await;
    world.computer.answer(
        "git.createTag",
        json!({"ok": false, "message": "Tag v1.5.0 already exists locally."}),
    );

    world
        .engine
        .git_create_tag("v1.5.0".to_owned(), String::new(), false);

    let view = world.until(|v| v.error.is_some(), "the problem").await;
    assert_eq!(
        view.error.as_deref(),
        Some("Tag v1.5.0 already exists locally.")
    );
    assert!(view.git_tools.tags.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_commit_message_comes_from_the_computer_for_what_is_staged() {
    let world = on_git(true).await;
    world.computer.answer(
        "git.suggestCommitMessage",
        json!({"ok": true, "text": "fix: the login redirect", "cliName": "Codex", "error": null, "cancelled": false}),
    );

    world.engine.git_suggest_commit_message();

    let view = world
        .until(
            |v| v.git_tools.ai.as_ref().is_some_and(|a| a.text.is_some()),
            "the message",
        )
        .await;
    let ai = view.git_tools.ai.expect("ai");
    assert_eq!(ai.kind, GitAiKind::Commit);
    assert_eq!(ai.text.as_deref(), Some("fix: the login redirect"));
    assert_eq!(
        ai.note.as_deref(),
        Some("Written by Codex on this computer")
    );
    let params = world
        .computer
        .params_of("git.suggestCommitMessage")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(params["scope"], "staged");

    world.engine.git_ai_taken();
    world
        .until(
            |v| v.git_tools.ai.as_ref().is_some_and(|a| a.text.is_none()),
            "taken",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn with_nothing_staged_the_message_covers_every_change() {
    let world = on_git(false).await;
    world.computer.answer(
        "git.suggestCommitMessage",
        json!({"ok": false, "text": null, "cliName": null, "error": "No CLI is set up.", "cancelled": false}),
    );

    world.engine.git_suggest_commit_message();

    let view = world
        .until(
            |v| v.git_tools.ai.as_ref().is_some_and(|a| a.error.is_some()),
            "the problem",
        )
        .await;
    assert_eq!(
        view.git_tools.ai.expect("ai").error.as_deref(),
        Some("No CLI is set up.")
    );
    let params = world
        .computer
        .params_of("git.suggestCommitMessage")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(params["scope"], "all");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_branch_name_is_suggested_too() {
    let world = on_git(false).await;
    world.computer.answer(
        "git.suggestBranchName",
        json!({"ok": true, "text": "fix/login", "cliName": "Codex", "error": null, "cancelled": false}),
    );

    world.engine.git_suggest_branch_name();

    let view = world
        .until(
            |v| v.git_tools.ai.as_ref().is_some_and(|a| a.text.is_some()),
            "the name",
        )
        .await;
    assert_eq!(view.git_tools.ai.expect("ai").kind, GitAiKind::Branch);
}

#[tokio::test(flavor = "multi_thread")]
async fn fixing_a_conflict_asks_first_and_shows_the_result() {
    let world = on_git(false).await;
    world.computer.answer("git.resolveWithAi", json!({"ok": true, "message": "Resolved.", "summary": "Kept both changes", "cancelled": false}));

    world.engine.git_resolve_with_ai("a.ts".to_owned());
    let asked = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(asked.confirm.expect("question").detail.contains("a.ts"));
    assert!(world.computer.params_of("git.resolveWithAi").is_empty());

    world.engine.confirm();
    let view = world.until(|v| v.notice.is_some(), "the result").await;
    assert_eq!(view.notice.as_deref(), Some("Kept both changes"));
    assert!(view.git_tools.resolving.is_none());
}
