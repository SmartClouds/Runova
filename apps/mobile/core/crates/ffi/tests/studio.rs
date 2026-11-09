mod common;

use common::{World, connected};
use runova_ffi::view::{Section, StudioRenderState, StudioStepState};
use serde_json::{Value, json};

const FLICKS: i64 = 705_600_000;

fn scene(id: &str, hash: Option<&str>) -> Value {
    json!({"id": id, "title": format!("Scene {id}"), "narration": "Words", "flicks": 4 * FLICKS, "thumbnail": hash})
}

fn video(over: Value) -> Value {
    let mut base = json!({
        "id": "v1", "title": "Launch film", "aspect": "16:9", "quality": "standard",
        "resolution": "1080p", "fps": 30, "canUndo": true, "undoLabel": "Edit scene",
        "scenes": [scene("a", Some("hash-a")), scene("b", None)],
        "run": null, "failedRun": null, "proposal": null, "renders": [],
        "animatingAll": false, "stopped": null,
    });
    for (key, value) in over.as_object().expect("an object") {
        base[key] = value.clone();
    }
    base
}

fn run(stage: &str) -> Value {
    json!({
        "id": "g1", "stage": stage, "status": "running", "cliName": "Claude Code",
        "instruction": "Make it short", "elapsedMs": 72_000, "repairs": 1,
        "lines": ["Reading the scenes", "Writing scene 2"], "error": null,
    })
}

fn listing() -> Value {
    json!([
        {"id": "v1", "title": "Launch film", "pinned": true, "missing": false, "openedAgoMs": 7_200_000, "render": null},
        {"id": "v2", "title": "Teaser", "pinned": false, "missing": false, "openedAgoMs": 60_000, "render": {
            "id": "r1", "fileName": "Teaser.mp4", "status": "running", "phase": "encode", "done": 30, "total": 60,
            "durationSeconds": 12.0, "finished": false, "error": null,
        }},
    ])
}

async fn on_studio() -> World {
    let world = connected().await;
    world.computer.answer("studio.list", listing());
    world.engine.open_section(Some(Section::Studio));
    world
        .until(|v| v.studio.videos.len() == 2, "the videos")
        .await;
    world
}

async fn on_video(over: Value) -> World {
    let world = on_studio().await;
    world.computer.answer("studio.video", video(over));
    world.engine.studio_open_video("v1".to_owned());
    world
        .until(
            |v| v.studio.video.as_ref().is_some_and(|d| !d.loading),
            "the video",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_library_lists_videos_with_their_render() {
    let world = on_studio().await;
    let view = world.latest().expect("a view");

    assert_eq!(view.studio.videos[0].title, "Launch film");
    assert!(view.studio.videos[0].pinned);
    assert_eq!(view.studio.videos[0].render_label, None);
    assert_eq!(
        view.studio.videos[1].render_label.as_deref(),
        Some("Encoding 50%")
    );
    assert_eq!(
        view.studio.videos[1].render_state,
        Some(StudioRenderState::Running)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_video_starts_from_a_prompt_and_opens() {
    let world = on_studio().await;
    world.computer.answer(
        "studio.options",
        json!({"languages": [{"code": "en", "name": "English", "native": "English"}], "styles": []}),
    );
    world.engine.studio_open_composer();
    world
        .until(|v| v.studio.composer.is_some(), "the composer")
        .await;
    world
        .until(
            |v| {
                v.studio
                    .composer
                    .as_ref()
                    .is_some_and(|c| !c.languages.is_empty())
            },
            "the choices",
        )
        .await;

    world
        .computer
        .answer("studio.create", json!({"videoId": "v1"}));
    world.computer.answer(
        "studio.video",
        video(json!({"scenes": [], "run": run("scenario")})),
    );
    world.engine.studio_create(
        "A launch film".to_owned(),
        "9:16".to_owned(),
        "en".to_owned(),
        30,
        None,
    );

    let view = world
        .until(
            |v| v.studio.video.as_ref().is_some_and(|d| d.run.is_some()),
            "the run",
        )
        .await;
    assert!(view.studio.composer.is_none());
    let params = world
        .computer
        .params_of("studio.create")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(
        params,
        json!({"brief": "A launch film", "aspect": "9:16", "language": "en", "seconds": 30, "styleId": null})
    );
    let detail = view.studio.video.expect("the video");
    assert_eq!(detail.steps[0].state, StudioStepState::Active);
    assert_eq!(detail.run.expect("run").title, "Writing the scenes");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_create_stays_on_the_form_and_says_why() {
    let world = on_studio().await;
    world
        .computer
        .answer("studio.options", json!({"languages": [], "styles": []}));
    world.engine.studio_open_composer();
    world
        .until(|v| v.studio.composer.is_some(), "the composer")
        .await;
    world
        .computer
        .refuse("studio.create", "failed", "Set up an AI CLI first.");

    world.engine.studio_create(
        "A film".to_owned(),
        "16:9".to_owned(),
        "en".to_owned(),
        30,
        None,
    );

    let view = world.until(|v| v.error.is_some(), "the problem").await;
    assert_eq!(view.error.as_deref(), Some("Set up an AI CLI first."));
    assert!(view.studio.composer.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_video_shows_steps_and_how_much_is_left() {
    let world = on_video(json!({})).await;
    let detail = world
        .latest()
        .and_then(|v| v.studio.video)
        .expect("the video");

    assert_eq!(detail.title, "Launch film");
    assert_eq!(detail.steps[0].state, StudioStepState::Done);
    assert_eq!(detail.steps[1].state, StudioStepState::Active);
    assert_eq!(detail.steps[1].detail, "1 of 2 scenes");
    assert_eq!(detail.steps[2].state, StudioStepState::Todo);
    assert_eq!(detail.animate_all_label.as_deref(), Some("Animate 1 scene"));
    assert!(!detail.can_render);
    assert_eq!(detail.scenes[0].number, 1);
    assert_eq!(detail.scenes[0].duration_label, "4s");
    assert!(detail.scenes[0].animated);
    assert!(!detail.scenes[1].animated);
    assert!(detail.scenes[1].can_animate);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scene_cannot_start_while_a_run_is_going() {
    let world = on_video(json!({"run": run("scene")})).await;
    let detail = world
        .latest()
        .and_then(|v| v.studio.video)
        .expect("the video");

    assert!(!detail.scenes[1].can_animate);
    assert_eq!(detail.animate_all_label, None);
    let live = detail.run.expect("the run");
    assert_eq!(live.title, "Animating a scene");
    assert_eq!(live.detail, "Claude Code, 1m 12s, repair 1");
    assert_eq!(live.lines.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn animating_everything_asks_first() {
    let world = on_video(json!({})).await;
    world.computer.answer(
        "studio.animateAll",
        json!({"ok": true, "message": "Animating every scene."}),
    );

    world.engine.studio_animate_all();
    let asked = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(asked.confirm.expect("question").detail.contains("1 scene"));
    assert!(world.computer.params_of("studio.animateAll").is_empty());

    world.engine.confirm();
    world.until(|v| v.notice.is_some(), "the answer").await;
    assert_eq!(
        world.computer.params_of("studio.animateAll"),
        vec![Some(json!({"videoId": "v1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_proposal_shows_before_and_after_and_can_be_applied() {
    let proposal = json!({"generationId": "g9", "summary": "Shorter", "changes": [
        {"title": "Scene 1", "fields": [{"label": "Narration", "before": "Long", "after": "Short"}]},
    ]});
    let world = on_video(json!({"proposal": proposal})).await;
    let shown = world
        .latest()
        .and_then(|v| v.studio.video)
        .and_then(|d| d.proposal)
        .expect("the proposal");
    assert_eq!(shown.summary, "Shorter");
    assert_eq!(shown.changes[0].fields[0].after, "Short");

    world.computer.answer(
        "studio.applyProposal",
        json!({"ok": true, "message": "Applied."}),
    );
    world.computer.answer("studio.video", video(json!({})));
    world.engine.studio_apply_proposal();

    world
        .until(
            |v| {
                v.studio
                    .video
                    .as_ref()
                    .is_some_and(|d| d.proposal.is_none())
            },
            "applied",
        )
        .await;
    assert_eq!(
        world.computer.params_of("studio.applyProposal"),
        vec![Some(json!({"videoId": "v1", "generationId": "g9"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_names_the_run() {
    let world = on_video(json!({"run": run("edit")})).await;
    world.computer.answer(
        "studio.cancelRun",
        json!({"ok": true, "message": "Stopped."}),
    );

    world.engine.studio_cancel_run();

    world.until(|v| v.notice.is_some(), "stopped").await;
    assert_eq!(
        world.computer.params_of("studio.cancelRun"),
        vec![Some(json!({"videoId": "v1", "generationId": "g1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn asking_the_ai_sends_the_words_on() {
    let world = on_video(json!({})).await;
    world.computer.answer(
        "studio.ask",
        json!({"ok": true, "message": "Asked the AI."}),
    );

    world.engine.studio_ask("Make it shorter".to_owned());

    world.until(|v| v.notice.is_some(), "asked").await;
    assert_eq!(
        world.computer.params_of("studio.ask"),
        vec![Some(
            json!({"videoId": "v1", "instruction": "Make it shorter"})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn render_needs_every_scene_animated_and_shows_the_estimate() {
    let scenes = json!([scene("a", Some("hash-a"))]);
    let world = on_video(json!({"scenes": scenes})).await;
    assert!(
        world
            .latest()
            .and_then(|v| v.studio.video)
            .expect("video")
            .can_render
    );

    world.computer.answer(
        "studio.renderEstimate",
        json!({"ok": true, "problems": [], "width": 1920, "height": 1080, "durationSeconds": 60.0,
               "outputBytes": 38_000_000, "seconds": 120.0, "warnings": ["Disk is nearly full."]}),
    );
    world.engine.studio_open_render();

    let view = world
        .until(
            |v| {
                v.studio
                    .video
                    .as_ref()
                    .is_some_and(|d| d.render_sheet.as_ref().is_some_and(|s| s.summary.is_some()))
            },
            "the estimate",
        )
        .await;
    let sheet = view
        .studio
        .video
        .and_then(|d| d.render_sheet)
        .expect("the sheet");
    assert_eq!(
        sheet.summary.as_deref(),
        Some("1920 x 1080, about 36 MB, about 2 minutes")
    );
    assert_eq!(sheet.quality, "standard");
    assert_eq!(sheet.warnings, vec!["Disk is nearly full.".to_owned()]);

    world.computer.answer(
        "studio.render",
        json!({"ok": true, "message": "Rendering on this computer."}),
    );
    world.computer.answer(
        "studio.video",
        video(json!({"scenes": [scene("a", Some("hash-a"))]})),
    );
    world.engine.studio_render("draft".to_owned());

    world
        .until(
            |v| {
                v.studio
                    .video
                    .as_ref()
                    .is_some_and(|d| d.render_sheet.is_none())
            },
            "closed",
        )
        .await;
    assert_eq!(
        world.computer.params_of("studio.render"),
        vec![Some(json!({"videoId": "v1", "quality": "draft"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_render_shows_its_phase_and_can_be_stopped() {
    let renders = json!([
        {"id": "r1", "fileName": "Launch.mp4", "status": "running", "phase": "capture", "done": 25, "total": 100,
         "durationSeconds": 60.0, "finished": false, "error": null},
    ]);
    let world = on_video(json!({"renders": renders})).await;
    let detail = world
        .latest()
        .and_then(|v| v.studio.video)
        .expect("the video");

    assert_eq!(detail.renders[0].label, "Drawing frames: 25 of 100");
    assert_eq!(detail.renders[0].percent, Some(25.0));
    assert!(detail.renders[0].can_cancel);
    assert!(!detail.can_render);
    assert_eq!(detail.steps[2].state, StudioStepState::Active);

    world.computer.answer(
        "studio.cancelRender",
        json!({"ok": true, "message": "Render stopped."}),
    );
    world.engine.studio_cancel_render("r1".to_owned());
    world.until(|v| v.notice.is_some(), "stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_render_says_where_it_is() {
    let renders = json!([
        {"id": "r1", "fileName": "Launch.mp4", "status": "done", "phase": null, "done": 0, "total": 0,
         "durationSeconds": 60.0, "finished": true, "error": null},
    ]);
    let world = on_video(json!({"renders": renders, "scenes": [scene("a", Some("hash-a"))]})).await;
    let detail = world
        .latest()
        .and_then(|v| v.studio.video)
        .expect("the video");

    assert_eq!(detail.renders[0].state, StudioRenderState::Done);
    assert_eq!(detail.renders[0].label, "Saved on this computer");
    assert_eq!(detail.steps[2].state, StudioStepState::Done);
}

#[tokio::test(flavor = "multi_thread")]
async fn pictures_arrive_outside_the_view_and_only_once() {
    world_with_pictures().await;
}

async fn world_with_pictures() {
    let world = connected().await;
    world.computer.answer("studio.list", listing());
    world
        .computer
        .answer("studio.thumbnail", json!({"png": "AQI="}));
    world.computer.answer("studio.video", video(json!({})));
    world.engine.open_section(Some(Section::Studio));
    world
        .until(|v| v.studio.videos.len() == 2, "the videos")
        .await;
    world.engine.studio_open_video("v1".to_owned());

    let view = world
        .until(
            |v| {
                v.studio
                    .video
                    .as_ref()
                    .is_some_and(|d| d.scenes.first().is_some_and(|s| s.thumbnail_ready))
            },
            "the picture",
        )
        .await;

    assert_eq!(
        view.studio.video.expect("video").scenes[0]
            .thumbnail
            .as_deref(),
        Some("hash-a")
    );
    assert_eq!(
        world.engine.studio_thumbnail("hash-a".to_owned()),
        Some(vec![1, 2])
    );
    assert_eq!(world.engine.studio_thumbnail("nope".to_owned()), None);
    assert_eq!(world.computer.params_of("studio.thumbnail").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn going_back_lets_go_of_the_video() {
    let world = on_video(json!({})).await;
    world
        .computer
        .answer("studio.leave", json!({"ok": true, "message": ""}));

    world.engine.studio_close_video();

    world.until(|v| v.studio.video.is_none(), "closed").await;
    let left = world.computer.params_of("studio.leave");
    assert_eq!(left, vec![Some(json!({"videoId": "v1"}))]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_computer_says_how_to_turn_it_on() {
    let world = connected().await;
    world.computer.refuse(
        "studio.list",
        "forbidden",
        "This phone is not allowed to do that.",
    );

    world.engine.open_section(Some(Section::Studio));

    let view = world.until(|v| v.studio.note.is_some(), "the note").await;
    assert!(view.studio.note.expect("note").contains("Studio"));
}
