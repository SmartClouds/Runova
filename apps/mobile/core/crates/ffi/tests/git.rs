mod common;

use common::{World, connected};
use runova_ffi::view::{DiffLineKind, GitGroup, Section};
use serde_json::{Value, json};

fn state() -> Value {
    json!({
        "isRepo": true,
        "branch": "master",
        "detached": false,
        "upstream": "origin/master",
        "ahead": 1,
        "behind": 2,
        "hasRemote": true,
        "operation": null,
        "conflicts": [{"path": "c.ts", "status": "U", "conflict": "UU"}],
        "staged": [{"path": "a.ts", "status": "M", "additions": 3, "deletions": 1}],
        "unstaged": [{"path": "b.ts", "origPath": "old.ts", "status": "R"}],
        "untracked": [{"path": "n.ts", "status": "?", "binary": false}],
        "untrackedTruncated": false,
    })
}

const OK: fn() -> Value = || json!({"ok": true, "message": "Done."});

async fn in_project() -> World {
    let world = connected().await;
    world.computer.answer("git.state", state());
    world.engine.select_project(Some("p1".into()));
    world
        .until(|v| v.selected_project.is_some(), "project")
        .await;
    world.engine.load_git();
    world.until(|v| v.git.state.is_some(), "the state").await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_state_lists_every_kind_of_change_in_order() {
    let world = in_project().await;

    let view = world.latest().unwrap();
    let state = view.git.state.unwrap();

    assert_eq!(state.branch.as_deref(), Some("master"));
    assert_eq!((state.ahead, state.behind), (1, 2));
    let groups: Vec<GitGroup> = state.files.iter().map(|f| f.group).collect();
    assert_eq!(
        groups,
        [
            GitGroup::Conflict,
            GitGroup::Staged,
            GitGroup::Unstaged,
            GitGroup::Untracked
        ]
    );
    assert_eq!(state.files[1].additions, Some(3));
    assert_eq!(state.files[2].orig_path.as_deref(), Some("old.ts"));
    assert_eq!(state.files[0].conflict.as_deref(), Some("UU"));
}

#[tokio::test(flavor = "multi_thread")]
async fn it_asks_about_the_chosen_project() {
    let world = in_project().await;

    assert_eq!(
        world.computer.params_of("git.state"),
        vec![Some(json!({"projectId": "p1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_project_chosen_nothing_is_asked() {
    let world = connected().await;

    world.engine.load_git();
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;

    assert!(world.computer.params_of("git.state").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_screen_keeps_itself_current_while_on_show() {
    let world = in_project().await;

    world.engine.open_section(Some(Section::Git));
    world
        .until(
            |_| world.computer.params_of("git.state").len() >= 3,
            "refreshes",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn choosing_another_project_forgets_the_last_ones_changes() {
    let world = in_project().await;
    world.engine.open_section(Some(Section::Git));
    world.computer.answer("git.state", json!({"isRepo": false}));

    world.engine.select_project(Some("p2".into()));

    let asked_about_p2 = || {
        world
            .computer
            .params_of("git.state")
            .last()
            .cloned()
            .flatten()
            == Some(json!({"projectId": "p2"}))
    };
    let view = world
        .until(
            |v| asked_about_p2() && v.git.state.as_ref().is_some_and(|s| !s.is_repo),
            "the other project",
        )
        .await;
    assert!(view.git.state.unwrap().files.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_diff_opens_with_its_lines() {
    let world = in_project().await;
    world.computer.answer(
        "git.diff",
        json!({"path": "b.ts", "binary": false, "tooLarge": false, "lines": [
            {"kind": "hunk", "text": "@@"},
            {"kind": "add", "text": "new"},
            {"kind": "del", "text": "old"},
            {"kind": "ctx", "text": "same"},
        ]}),
    );

    world
        .engine
        .open_git_diff("b.ts".into(), GitGroup::Unstaged);
    let view = world
        .until(
            |v| v.git.diff.as_ref().is_some_and(|d| !d.loading),
            "the diff",
        )
        .await;

    assert_eq!(
        world.computer.params_of("git.diff"),
        vec![Some(
            json!({"projectId": "p1", "path": "b.ts", "side": "unstaged", "origPath": "old.ts"})
        )]
    );
    let diff = view.git.diff.unwrap();
    let kinds: Vec<DiffLineKind> = diff.lines.iter().map(|l| l.kind).collect();
    assert_eq!(
        kinds,
        [
            DiffLineKind::Hunk,
            DiffLineKind::Added,
            DiffLineKind::Removed,
            DiffLineKind::Context
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_too_big_says_so() {
    let world = in_project().await;
    world.computer.answer(
        "git.diff",
        json!({"path": "a.ts", "binary": false, "tooLarge": true, "lines": []}),
    );

    world.engine.open_git_diff("a.ts".into(), GitGroup::Staged);
    let view = world
        .until(
            |v| v.git.diff.as_ref().is_some_and(|d| d.too_large),
            "too large",
        )
        .await;

    assert!(view.git.diff.unwrap().lines.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn staging_refreshes_the_changes_and_says_it_worked() {
    let world = in_project().await;
    world.computer.answer("git.stage", OK());

    world.engine.git_stage(vec!["b.ts".into()]);
    world
        .until(|v| v.notice.as_deref() == Some("Done."), "the notice")
        .await;
    world
        .until(
            |_| world.computer.params_of("git.state").len() >= 2,
            "a refresh",
        )
        .await;

    assert_eq!(
        world.computer.params_of("git.stage"),
        vec![Some(json!({"projectId": "p1", "paths": ["b.ts"]}))]
    );
    assert!(!world.latest().unwrap().busy);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_push_shows_gits_reason() {
    let world = in_project().await;
    world.computer.answer(
        "git.push",
        json!({"ok": false, "message": "rejected: non-fast-forward"}),
    );

    world.engine.git_push();
    let view = world.until(|v| v.error.is_some(), "the reason").await;

    assert_eq!(view.error.as_deref(), Some("rejected: non-fast-forward"));
    assert_eq!(view.notice, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn commit_sends_the_message_and_whether_to_push() {
    let world = in_project().await;
    world.computer.answer("git.commit", OK());

    world.engine.git_commit("Fix the bug".into(), true);
    world.until(|v| v.notice.is_some(), "the notice").await;

    assert_eq!(
        world.computer.params_of("git.commit"),
        vec![Some(
            json!({"projectId": "p1", "message": "Fix the bug", "push": true})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_first_line_of_gits_output_is_shown() {
    let world = in_project().await;
    world.computer.answer(
        "git.pull",
        json!({"ok": true, "message": "Updating abc\nFast-forward\n 3 files changed"}),
    );

    world.engine.git_pull();
    let view = world.until(|v| v.notice.is_some(), "the notice").await;

    assert_eq!(view.notice.as_deref(), Some("Updating abc"));
}

#[tokio::test(flavor = "multi_thread")]
async fn discarding_asks_first_and_does_nothing_until_confirmed() {
    let world = in_project().await;
    world.computer.answer("git.discard", OK());

    world.engine.git_discard("b.ts".into(), GitGroup::Unstaged);
    let view = world.until(|v| v.confirm.is_some(), "the question").await;

    assert!(view.confirm.as_ref().unwrap().danger);
    assert!(view.confirm.unwrap().detail.contains("b.ts"));
    assert!(world.computer.params_of("git.discard").is_empty());

    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("git.discard").is_empty(),
            "sent",
        )
        .await;

    assert_eq!(
        world.computer.params_of("git.discard"),
        vec![Some(
            json!({"projectId": "p1", "paths": ["b.ts"], "side": "unstaged"})
        )]
    );
    assert!(world.latest().unwrap().confirm.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn saying_no_changes_nothing() {
    let world = in_project().await;

    world.engine.git_discard("b.ts".into(), GitGroup::Untracked);
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.dismiss_confirm();
    world.until(|v| v.confirm.is_none(), "gone").await;

    world.engine.confirm();
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;

    assert!(world.computer.params_of("git.discard").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn branches_and_stashes_load_together() {
    let world = in_project().await;
    world.computer.answer(
        "git.branches",
        json!([{"name": "master", "current": true, "local": true}]),
    );
    world.computer.answer(
        "git.stashes",
        json!([{"ref": "stash@{0}", "message": "WIP"}]),
    );

    world.engine.open_git_branches();
    let view = world
        .until(
            |v| v.git.branches_open && !v.git.branches.is_empty() && !v.git.stashes.is_empty(),
            "the lists",
        )
        .await;

    assert!(view.git.branches[0].current);
    assert_eq!(view.git.stashes[0].reference, "stash@{0}");
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_branch_and_dropping_a_stash_ask_first() {
    let world = in_project().await;

    world.engine.git_delete_branch("old".into());
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.dismiss_confirm();
    world.until(|v| v.confirm.is_none(), "gone").await;

    world.engine.git_stash_drop("stash@{0}".into());
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.dismiss_confirm();

    assert!(world.computer.params_of("git.deleteBranch").is_empty());
    assert!(world.computer.params_of("git.stashDrop").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conflict_can_keep_one_side() {
    let world = in_project().await;
    world.computer.answer("git.resolve", OK());

    world.engine.git_resolve("c.ts".into(), "theirs".into());
    world.until(|v| v.notice.is_some(), "the notice").await;

    assert_eq!(
        world.computer.params_of("git.resolve"),
        vec![Some(
            json!({"projectId": "p1", "path": "c.ts", "pick": "theirs"})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_computer_forgets_all_of_it() {
    let world = in_project().await;

    world.engine.git_discard("b.ts".into(), GitGroup::Unstaged);
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.disconnect();

    let view = world
        .until(|v| v.connection.is_none(), "disconnected")
        .await;
    assert!(view.git.state.is_none());
    assert!(view.confirm.is_none());
}
