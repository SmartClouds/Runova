//! The demo computer's developer screens (E119): git, status, the vault, agents, prompts and
//! Studio all show made-up content, and what is changed reports success and keeps nothing.

mod common;

use common::{DemoWorld, connected_demo};
use runova_ffi::agents::PromptScheduleInput;
use runova_ffi::view::{
    AppView, GitGroup, GitVersionState, PipelineRunState, Section, StudioDownloadState,
    VaultLockState,
};

const SHOP: &str = "northwind-shop";

/// The demo, connected, with the shop chosen and `section` open.
async fn on(section: Section) -> DemoWorld {
    let demo = connected_demo().await;
    demo.world.engine.select_project(Some(SHOP.to_owned()));
    demo.world
        .until(|v| v.selected_project.is_some(), "the project")
        .await;
    demo.world.engine.open_section(Some(section));
    demo
}

fn no_error(view: &AppView) {
    assert_eq!(view.error, None, "{view:?}");
}

/// Runs a change and waits for its notice. The section has just been opened, so none is up yet.
async fn succeeds(demo: &DemoWorld, change: impl FnOnce()) -> AppView {
    change();
    let view = demo
        .world
        .until(|v| v.notice.is_some() || v.error.is_some(), "the answer")
        .await;
    no_error(&view);
    view
}

async fn confirmed(demo: &DemoWorld) {
    demo.world
        .until(|v| v.confirm.is_some(), "the question")
        .await;
    demo.world.engine.confirm();
}

async fn on_git() -> DemoWorld {
    let demo = on(Section::Git).await;
    demo.world
        .until(
            |v| v.git.state.as_ref().is_some_and(|s| !s.files.is_empty()),
            "the changes",
        )
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn git_shows_changes_a_diff_branches_and_stashes() {
    let demo = on_git().await;
    let state = demo.world.latest().unwrap().git.state.unwrap();
    assert_eq!(state.branch.as_deref(), Some("feature/gift-cards"));
    assert!(state.files.iter().any(|f| f.group == GitGroup::Staged));
    assert!(state.files.iter().any(|f| f.group == GitGroup::Unstaged));
    let changed = state
        .files
        .iter()
        .find(|f| f.group == GitGroup::Unstaged)
        .unwrap();

    demo.world
        .engine
        .open_git_diff(changed.path.clone(), GitGroup::Unstaged);
    demo.world
        .until(
            |v| {
                v.git
                    .diff
                    .as_ref()
                    .is_some_and(|d| !d.loading && !d.lines.is_empty())
            },
            "the diff",
        )
        .await;
    demo.world.engine.open_git_branches();
    let view = demo
        .world
        .until(
            |v| v.git.branches.len() > 2 && !v.git.stashes.is_empty(),
            "branches and stashes",
        )
        .await;

    assert!(view.git.branches.iter().any(|b| b.current));
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_commit_says_it_worked_and_the_changes_stay() {
    let demo = on_git().await;
    let before = demo.world.latest().unwrap().git.state.unwrap().files;

    succeeds(&demo, || {
        demo.world
            .engine
            .git_commit("Add gift card balance check".to_owned(), false)
    })
    .await;

    let view = demo.world.until(|v| !v.busy, "settled").await;
    assert_eq!(view.git.state.unwrap().files, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_says_it_worked() {
    let demo = on_git().await;

    succeeds(&demo, || demo.world.engine.git_push()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn staging_and_stashing_say_they_worked() {
    let demo = on_git().await;
    succeeds(&demo, || {
        demo.world
            .engine
            .git_stage(vec!["src/checkout/GiftCardInput.tsx".to_owned()])
    })
    .await;

    demo.world.engine.git_stash_push(Some("wip".to_owned()));
    demo.world
        .until(|v| !v.busy && v.notice.is_some(), "stashed")
        .await;
    no_error(&demo.world.latest().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_pull_request_shows_with_a_review_to_read() {
    let demo = on_git().await;

    demo.world.engine.git_open_pr();
    let view = demo
        .world
        .until(
            |v| v.git_more.pr.as_ref().is_some_and(|p| !p.loading),
            "the pull request",
        )
        .await;
    let pr = view.git_more.pr.unwrap();
    assert!(pr.pr.is_some(), "{pr:?}");
    assert_eq!(pr.error, None);
    assert_eq!(pr.note, None);

    demo.world.engine.git_review_pr();
    let view = demo
        .world
        .until(
            |v| v.git_more.pr.as_ref().is_some_and(|p| p.review.is_some()),
            "the review",
        )
        .await;
    no_error(&view);
    demo.world.engine.git_post_review("Looks good".to_owned());
    confirmed(&demo).await;
    demo.world.until(|v| v.notice.is_some(), "posted").await;
    no_error(&demo.world.latest().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn updating_the_version_runs_to_the_end() {
    let demo = on_git().await;

    demo.world.engine.git_apply_version("v1.5.0".to_owned());
    confirmed(&demo).await;
    let view = demo
        .world
        .until(
            |v| {
                v.git_more
                    .version
                    .as_ref()
                    .is_some_and(|r| r.state == GitVersionState::Done)
            },
            "the version run",
        )
        .await;

    let version = view.git_more.version.as_ref().unwrap();
    assert!(!version.files.is_empty());
    assert!(!version.lines.is_empty());
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn tags_and_the_ai_helpers_answer() {
    let demo = on_git().await;

    demo.world.engine.git_open_tags();
    let view = demo
        .world
        .until(
            |v| v.git_tools.tags.as_ref().is_some_and(|t| !t.loading),
            "the tags",
        )
        .await;
    let tags = view.git_tools.tags.unwrap();
    assert!(tags.latest.is_some());
    assert!(!tags.channels.is_empty());
    assert!(tags.recent.len() > 2);

    demo.world.engine.git_suggest_tag();
    demo.world
        .until(
            |v| {
                v.git_tools
                    .tags
                    .as_ref()
                    .is_some_and(|t| t.suggestion.is_some())
            },
            "the suggested tag",
        )
        .await;
    demo.world.engine.git_suggest_commit_message();
    demo.world
        .until(
            |v| v.git_tools.ai.as_ref().is_some_and(|a| a.text.is_some()),
            "the commit message",
        )
        .await;
    demo.world.engine.git_suggest_branch_name();
    let view = demo
        .world
        .until(
            |v| {
                v.git_tools.ai.as_ref().is_some_and(|a| {
                    a.kind == runova_ffi::view::GitAiKind::Branch && a.text.is_some()
                })
            },
            "the branch name",
        )
        .await;
    no_error(&view);

    succeeds(&demo, || {
        demo.world
            .engine
            .git_create_tag("v1.5.0".to_owned(), "Gift cards".to_owned(), false)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn status_shows_the_computer_and_ai_usage() {
    let demo = on(Section::Status).await;

    let view = demo
        .world
        .until(
            |v| {
                v.status.system.is_some()
                    && v.status.limits.len() > 1
                    && v.status.providers.len() > 1
                    && v.status.computer.len() > 3
            },
            "the status",
        )
        .await;

    no_error(&view);
}

async fn on_vault() -> DemoWorld {
    let demo = on(Section::Vault).await;
    demo.world
        .until(|v| v.vault.entries.len() > 3, "the vault")
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn the_vault_lists_entries_and_reveals_a_made_up_secret() {
    let demo = on_vault().await;
    let view = demo.world.latest().unwrap();
    assert_eq!(view.vault.state, VaultLockState::Unlocked);
    let entry = view
        .vault
        .entries
        .iter()
        .find(|e| e.secrets.iter().any(|s| s.key == "password"))
        .unwrap()
        .clone();

    demo.world.engine.vault_open_entry(entry.id);
    demo.world
        .until(|v| v.vault.open_entry.is_some(), "the entry")
        .await;
    demo.world
        .engine
        .vault_request_reveal("password".to_owned(), false);
    let asked = demo
        .world
        .until(|v| v.vault.biometric.is_some(), "the check")
        .await;
    demo.world
        .engine
        .biometric_result(asked.vault.biometric.unwrap().id, true);
    let view = demo
        .world
        .until(|v| v.vault.revealed.is_some(), "the value")
        .await;

    assert!(view.vault.revealed.as_ref().unwrap().value.contains("demo"));
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_to_the_vault_says_so_and_the_list_stays() {
    let demo = on_vault().await;
    let before = demo.world.latest().unwrap().vault.entries;

    succeeds(&demo, || {
        demo.world
            .engine
            .vault_save(Some(before[0].id.clone()), "Renamed".to_owned(), None, None)
    })
    .await;

    let view = demo.world.until(|v| !v.busy, "settled").await;
    assert_eq!(view.vault.entries, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_fix_sessions_show_on_pipelines_and_can_be_stopped() {
    let demo = on(Section::Pipelines).await;

    let view = demo
        .world
        .until(|v| v.auto_fix.len() > 1, "the auto-fix sessions")
        .await;
    let running = view.auto_fix.iter().find(|s| s.can_stop).unwrap().clone();

    succeeds(&demo, || demo.world.engine.auto_fix_stop(running.id)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn fixing_a_failed_run_with_ai_opens_the_agent() {
    let demo = on(Section::Pipelines).await;
    let view = demo
        .world
        .until(|v| v.pipelines.status.is_some(), "the pipelines")
        .await;
    let failed = view
        .pipelines
        .status
        .unwrap()
        .workflows
        .into_iter()
        .find(|w| {
            w.run
                .as_ref()
                .is_some_and(|r| r.state == PipelineRunState::Failed)
        })
        .unwrap();

    demo.world
        .engine
        .pipelines_fix_with_ai(failed.id, None, None, None);
    let view = demo
        .world
        .until(|v| v.terminal.is_some(), "the agent's terminal")
        .await;

    no_error(&view);
}

async fn on_prompts() -> DemoWorld {
    let demo = on(Section::Prompts).await;
    demo.world
        .until(|v| v.prompts.options.is_some(), "the choices")
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn prompts_offer_choices_a_library_and_write_one() {
    let demo = on_prompts().await;
    let options = demo.world.latest().unwrap().prompts.options.unwrap();
    assert!(options.types.len() > 2);
    assert!(options.targets.len() > 1);

    demo.world.engine.prompts_load_library(None);
    demo.world
        .until(
            |v| {
                v.prompts.templates.len() > 1
                    && v.prompts.history.len() > 1
                    && !v.prompts.scheduled.is_empty()
            },
            "the library",
        )
        .await;
    demo.world.engine.prompts_generate(
        "the gift card field accepts spaces".to_owned(),
        options.types[0].clone(),
        options.targets[0].name.clone(),
    );
    let view = demo
        .world
        .until(|v| v.prompts.result.is_some(), "the prompt")
        .await;

    assert!(!view.prompts.generating);
    assert_eq!(view.prompts.error, None);
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_template_saves_and_a_prompt_is_scheduled() {
    let demo = on_prompts().await;

    succeeds(&demo, || {
        demo.world.engine.prompts_save_template(
            "Tidy up".to_owned(),
            "Refactor".to_owned(),
            "Claude Code".to_owned(),
            "Tidy this".to_owned(),
        )
    })
    .await;
    demo.world.engine.prompts_schedule(PromptScheduleInput {
        raw_input: "Run the tests".to_owned(),
        prompt_type: "Testing".to_owned(),
        target: "Codex".to_owned(),
        content: "Run the tests".to_owned(),
        in_ms: 3_600_000,
        cli_id: None,
        model: None,
        effort: None,
    });
    confirmed(&demo).await;
    demo.world
        .until(|v| !v.busy && v.notice.is_some(), "scheduled")
        .await;
    no_error(&demo.world.latest().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_prompt_sent_to_an_agent_opens_its_terminal() {
    let demo = on_prompts().await;

    demo.world.engine.prompts_send(
        "Fix the gift card rounding".to_owned(),
        Some("claude".to_owned()),
        None,
        None,
    );
    confirmed(&demo).await;
    let view = demo
        .world
        .until(|v| v.terminal.is_some(), "the agent's terminal")
        .await;

    no_error(&view);
}

async fn on_video() -> DemoWorld {
    let demo = on(Section::Studio).await;
    let view = demo
        .world
        .until(|v| v.studio.videos.len() > 2, "the videos")
        .await;
    demo.world
        .engine
        .studio_open_video(view.studio.videos[0].id.clone());
    demo.world
        .until(
            |v| {
                v.studio.video.as_ref().is_some_and(|d| {
                    !d.loading && !d.scenes.is_empty() && d.scenes.iter().any(|s| s.thumbnail_ready)
                })
            },
            "the video",
        )
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn studio_lists_videos_and_opens_one_with_its_pictures() {
    let demo = on_video().await;
    let view = demo.world.latest().unwrap();
    let video = view.studio.video.as_ref().unwrap();
    let hash = video.scenes[0].thumbnail.clone().unwrap();

    assert!(demo.world.engine.studio_thumbnail(hash).is_some());
    assert!(video.can_render);
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_render_is_estimated_and_started_and_the_video_stays() {
    let demo = on_video().await;
    let before = demo.world.latest().unwrap().studio.video.unwrap().scenes;

    demo.world.engine.studio_open_render();
    demo.world
        .until(
            |v| {
                v.studio
                    .video
                    .as_ref()
                    .and_then(|d| d.render_sheet.as_ref())
                    .is_some_and(|s| s.summary.is_some())
            },
            "the estimate",
        )
        .await;
    succeeds(&demo, || {
        demo.world.engine.studio_render("standard".to_owned())
    })
    .await;

    let view = demo.world.until(|v| !v.busy, "settled").await;
    assert_eq!(view.studio.video.unwrap().scenes.len(), before.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_video_is_written_from_a_prompt() {
    let demo = on(Section::Studio).await;
    demo.world
        .until(|v| !v.studio.videos.is_empty(), "the videos")
        .await;

    demo.world.engine.studio_open_composer();
    demo.world
        .until(
            |v| {
                v.studio
                    .composer
                    .as_ref()
                    .is_some_and(|c| !c.languages.is_empty() && !c.styles.is_empty())
            },
            "the choices",
        )
        .await;
    demo.world.engine.studio_create(
        "A short film about gift cards".to_owned(),
        "16:9".to_owned(),
        "en".to_owned(),
        30,
        None,
    );
    let view = demo
        .world
        .until(
            |v| v.studio.video.as_ref().is_some_and(|d| !d.loading),
            "the new video",
        )
        .await;

    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_voice_is_picked_priced_and_spoken() {
    let demo = on_video().await;

    demo.world.engine.studio_open_voice();
    let view = demo
        .world
        .until(
            |v| {
                v.studio_tools
                    .voice
                    .as_ref()
                    .is_some_and(|s| !s.loading && !s.voices.is_empty())
            },
            "the voices",
        )
        .await;
    let voice = view.studio_tools.voice.unwrap().voices[0].reference.clone();
    demo.world.engine.studio_voice_pick(voice);
    demo.world
        .until(
            |v| {
                v.studio_tools
                    .voice
                    .as_ref()
                    .is_some_and(|s| s.price_label.is_some())
            },
            "the price",
        )
        .await;

    succeeds(&demo, || demo.world.engine.studio_speak()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_timeline_shows_tracks_and_a_clip_moves() {
    let demo = on_video().await;

    demo.world.engine.studio_open_timeline();
    let view = demo
        .world
        .until(
            |v| {
                v.studio_tools
                    .timeline
                    .as_ref()
                    .is_some_and(|t| !t.loading && t.tracks.len() > 1 && !t.music.is_empty())
            },
            "the timeline",
        )
        .await;
    let timeline = view.studio_tools.timeline.unwrap();
    let clip = timeline
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .next()
        .unwrap()
        .id
        .clone();

    succeeds(&demo, || demo.world.engine.studio_clip_nudge(clip, 1.0)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_render_comes_down_to_the_phone() {
    let demo = on_video().await;
    let job = demo.world.latest().unwrap().studio.video.unwrap().renders[0]
        .id
        .clone();
    let folder = std::env::temp_dir().join(format!("runova-demo-download-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();

    demo.world
        .engine
        .studio_download(job, folder.to_string_lossy().into_owned());
    let view = demo
        .world
        .until(
            |v| {
                v.studio_tools
                    .download
                    .as_ref()
                    .is_some_and(|d| d.state != StudioDownloadState::Running)
            },
            "the download",
        )
        .await;

    let download = view.studio_tools.download.unwrap();
    assert_eq!(download.state, StudioDownloadState::Done, "{download:?}");
    let _ = std::fs::remove_dir_all(&folder);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_video_in_the_studio_list_opens() {
    let demo = on(Section::Studio).await;
    let videos = demo
        .world
        .until(|v| v.studio.videos.len() > 2, "the videos")
        .await
        .studio
        .videos;

    for item in videos {
        demo.world.engine.studio_open_video(item.id.clone());
        let view = demo
            .world
            .until(
                |v| {
                    v.studio
                        .video
                        .as_ref()
                        .is_some_and(|d| d.id == item.id && !d.loading)
                },
                &format!("the video {}", item.id),
            )
            .await;
        assert_eq!(view.studio.video.unwrap().title, item.title);
        demo.world.engine.studio_close_video();
    }
}
