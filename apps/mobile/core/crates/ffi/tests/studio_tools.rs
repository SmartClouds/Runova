mod common;

use common::{World, connected};
use runova_ffi::view::{Section, StudioDownloadState};
use serde_json::{Value, json};

const FLICKS: f64 = 705_600_000.0;

fn scene(id: &str, voiced: bool) -> Value {
    json!({"id": id, "title": id, "narration": "Words", "flicks": 4.0 * FLICKS, "thumbnail": "x", "voiced": voiced})
}

fn video(narration: Value) -> Value {
    json!({
        "id": "v1", "title": "Film", "aspect": "16:9", "quality": "standard", "resolution": "1080p", "fps": 30,
        "canUndo": false, "undoLabel": null, "scenes": [scene("a", true), scene("b", false)], "run": null,
        "failedRun": null, "proposal": null, "renders": [], "animatingAll": false, "stopped": null,
        "language": "fa", "narration": narration,
    })
}

async fn on_video(narration: Value) -> World {
    let world = connected().await;
    world.computer.answer("studio.list", json!([]));
    world.computer.answer("studio.video", video(narration));
    world.engine.open_section(Some(Section::Studio));
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
async fn running_narration_shows_on_the_video_and_voiced_scenes_are_marked() {
    let world =
        on_video(json!({"id": "n1", "status": "running", "done": 1, "total": 4, "error": null}))
            .await;
    let view = world
        .until(|v| v.studio_tools.narration.is_some(), "the narration")
        .await;

    let narration = view.studio_tools.narration.expect("narration");
    assert_eq!(narration.label, "Speaking 1 of 4");
    assert_eq!(narration.percent, Some(25.0));
    let detail = view.studio.video.expect("video");
    assert!(detail.scenes[0].voiced);
    assert!(!detail.scenes[1].voiced);
}

async fn on_voice() -> World {
    let world = on_video(Value::Null).await;
    world.computer.answer(
        "studio.voiceEngines",
        json!([
            {"id": "elevenlabs", "label": "ElevenLabs", "problem": "The vault is locked", "locked": true, "local": false, "nonCommercial": false},
            {"id": "openai", "label": "OpenAI", "problem": null, "locked": false, "local": false, "nonCommercial": false},
        ]),
    );
    world.computer.answer(
        "studio.voices",
        json!([{"id": "alloy", "label": "Alloy", "ref": "openai:alloy", "nonCommercial": false}]),
    );
    world.engine.studio_open_voice();
    world
        .until(
            |v| {
                v.studio_tools
                    .voice
                    .as_ref()
                    .is_some_and(|s| !s.voices.is_empty())
            },
            "the voices",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_engine_that_works_is_picked_in_the_videos_language() {
    let world = on_voice().await;
    let voice = world
        .latest()
        .and_then(|v| v.studio_tools.voice)
        .expect("sheet");

    assert_eq!(voice.engine.as_deref(), Some("openai"));
    assert_eq!(
        voice.engines[0].problem.as_deref(),
        Some("The vault is locked")
    );
    assert_eq!(voice.scene_count, 1);
    assert_eq!(
        world.computer.params_of("studio.voices"),
        vec![Some(json!({"engine": "openai", "lang": "fa"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn speaking_agrees_the_price_the_sheet_showed_for_silent_scenes() {
    let world = on_voice().await;
    world.computer.answer(
        "studio.voiceEstimate",
        json!({"chars": 5, "usd": 0.12, "costKnown": true}),
    );
    world.engine.studio_voice_pick("openai:alloy".to_owned());
    let view = world
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
    assert_eq!(
        view.studio_tools
            .voice
            .expect("sheet")
            .price_label
            .as_deref(),
        Some("About $0.12")
    );

    world.computer.answer(
        "studio.speak",
        json!({"ok": true, "message": "Speaking the scenes."}),
    );
    world.engine.studio_speak();

    world
        .until(
            |v| v.studio_tools.voice.is_none() && v.notice.is_some(),
            "speaking",
        )
        .await;
    assert_eq!(
        world.computer.params_of("studio.speak"),
        vec![Some(
            json!({"videoId": "v1", "sceneIds": ["b"], "voiceRef": "openai:alloy", "confirmedUsd": 0.12})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_price_says_so_and_is_agreed_to_outright() {
    let world = on_voice().await;
    world.computer.answer(
        "studio.voiceEstimate",
        json!({"chars": 5, "usd": 0.0, "costKnown": false}),
    );
    world.engine.studio_voice_pick("openai:alloy".to_owned());
    let view = world
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
    assert_eq!(
        view.studio_tools
            .voice
            .expect("sheet")
            .price_label
            .as_deref(),
        Some("This voice has no known price")
    );

    world
        .computer
        .answer("studio.speak", json!({"ok": true, "message": "Speaking."}));
    world.engine.studio_speak();

    world.until(|v| v.notice.is_some(), "speaking").await;
    let sent = world
        .computer
        .params_of("studio.speak")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(sent["acceptUnknownCost"], true);
}

fn timeline() -> Value {
    json!({
        "seq": 7, "lengthFlicks": 10.0 * FLICKS, "truncated": false,
        "tracks": [
            {"id": "t1", "kind": "music", "name": "Music", "muted": false, "solo": false, "locked": false, "volume": 1},
            {"id": "t2", "kind": "voice", "name": "Voice", "muted": true, "solo": false, "locked": true, "volume": 1},
        ],
        "clips": [{"id": "c1", "trackId": "t1", "start": 2.0 * FLICKS, "duration": 5.0 * FLICKS, "gain": 1, "fadeIn": 0, "fadeOut": 0, "label": "Song"}],
    })
}

async fn on_timeline() -> World {
    let world = on_video(Value::Null).await;
    world.computer.answer("studio.media", json!([{"hash": "abc", "name": "Song", "kind": "audio", "duration": 3.0 * FLICKS, "preparing": false, "problem": null}]));
    world.computer.answer("studio.timeline", timeline());
    world.engine.studio_open_timeline();
    world
        .until(
            |v| v.studio_tools.timeline.as_ref().is_some_and(|t| !t.loading),
            "the timeline",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn clips_sit_where_they_are_in_the_film() {
    let world = on_timeline().await;
    let timeline = world
        .latest()
        .and_then(|v| v.studio_tools.timeline)
        .expect("timeline");

    assert_eq!(timeline.length_label, "10s");
    assert_eq!(timeline.tracks[0].clips[0].left, 0.2);
    assert_eq!(timeline.tracks[0].clips[0].width, 0.5);
    assert!(timeline.tracks[1].locked);
    assert_eq!(timeline.music[0].name, "Song");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_nudge_moves_from_where_the_clip_is_on_the_version_on_screen() {
    let world = on_timeline().await;
    world
        .computer
        .answer("studio.clipEdit", json!({"ok": true, "message": "Moved"}));

    world.engine.studio_clip_nudge("c1".to_owned(), 1.0);

    world.until(|v| v.notice.is_some(), "moved").await;
    assert_eq!(
        world.computer.params_of("studio.clipEdit"),
        vec![Some(
            json!({"videoId": "v1", "baseSeq": 7, "clipId": "c1", "action": "move", "start": 3.0 * FLICKS})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn trimming_the_end_counts_from_the_end() {
    let world = on_timeline().await;
    world
        .computer
        .answer("studio.clipEdit", json!({"ok": true, "message": "Trimmed"}));

    world.engine.studio_clip_trim("c1".to_owned(), true, -1.0);

    world.until(|v| v.notice.is_some(), "trimmed").await;
    let sent = world
        .computer
        .params_of("studio.clipEdit")
        .pop()
        .flatten()
        .expect("params");
    assert_eq!(sent["edge"], "end");
    assert_eq!(sent["to"], 6.0 * FLICKS);
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_clip_asks_first() {
    let world = on_timeline().await;
    world
        .computer
        .answer("studio.clipEdit", json!({"ok": true, "message": "Deleted"}));

    world.engine.studio_clip_remove("c1".to_owned());
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.computer.params_of("studio.clipEdit").is_empty());
    world.engine.confirm();

    world.until(|v| v.notice.is_some(), "deleted").await;
}

async fn serve_pieces(world: &World, pieces: &[&[u8]]) {
    for (index, piece) in pieces.iter().enumerate() {
        let asked = index + 1;
        for _ in 0..500 {
            if world.computer.params_of("studio.downloadRead").len() >= asked
                && world.computer.subscription("studio.downloadRead").is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        world.computer.bytes("studio.downloadRead", piece);
        world.computer.end("studio.downloadRead");
    }
}

fn folder(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("runova-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("a folder");
    path
}

#[tokio::test(flavor = "multi_thread")]
async fn a_video_comes_down_in_pieces_and_closes() {
    let world = on_video(Value::Null).await;
    let dir = folder("download");
    let size = 512 * 1024 + 3;
    world.computer.answer(
        "studio.downloadOpen",
        json!({"downloadId": "d1", "fileName": "../Film.mp4", "bytes": size, "nonCommercial": []}),
    );
    world
        .computer
        .answer("studio.downloadClose", json!({"ok": true, "message": ""}));

    world
        .engine
        .studio_download("r1".to_owned(), dir.to_string_lossy().into_owned());
    let first = vec![7u8; 512 * 1024];
    serve_pieces(&world, &[&first, &[1, 2, 3]]).await;

    let view = world
        .until(
            |v| {
                v.studio_tools
                    .download
                    .as_ref()
                    .is_some_and(|d| d.state == StudioDownloadState::Done)
            },
            "done",
        )
        .await;
    let download = view.studio_tools.download.expect("download");
    assert_eq!(download.file_name, "Film.mp4");
    let written = std::fs::read(dir.join("Film.mp4")).expect("the file");
    assert_eq!(written.len(), size);
    assert_eq!(&written[size - 3..], &[1, 2, 3]);
    let reads = world.computer.params_of("studio.downloadRead");
    assert_eq!(
        reads[1],
        Some(json!({"downloadId": "d1", "offset": 512 * 1024, "length": 3}))
    );
    assert_eq!(world.computer.params_of("studio.downloadClose").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partly_fetched_file_picks_up_where_it_stopped() {
    let world = on_video(Value::Null).await;
    let dir = folder("resume");
    std::fs::write(dir.join("Film.mp4"), [9u8; 4]).expect("a part");
    world.computer.answer(
        "studio.downloadOpen",
        json!({"downloadId": "d1", "fileName": "Film.mp4", "bytes": 6, "nonCommercial": []}),
    );
    world
        .computer
        .answer("studio.downloadClose", json!({"ok": true, "message": ""}));

    world
        .engine
        .studio_download("r1".to_owned(), dir.to_string_lossy().into_owned());
    serve_pieces(&world, &[&[5, 6]]).await;

    world
        .until(
            |v| {
                v.studio_tools
                    .download
                    .as_ref()
                    .is_some_and(|d| d.state == StudioDownloadState::Done)
            },
            "done",
        )
        .await;
    assert_eq!(
        std::fs::read(dir.join("Film.mp4")).expect("the file"),
        vec![9, 9, 9, 9, 5, 6]
    );
    let reads = world.computer.params_of("studio.downloadRead");
    assert_eq!(
        reads[0],
        Some(json!({"downloadId": "d1", "offset": 4, "length": 2}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_download_says_why() {
    let world = on_video(Value::Null).await;
    let dir = folder("refused");
    world.computer.refuse(
        "studio.downloadOpen",
        "failed",
        "That file is not on this computer any more.",
    );

    world
        .engine
        .studio_download("r1".to_owned(), dir.to_string_lossy().into_owned());

    let view = world
        .until(
            |v| {
                v.studio_tools
                    .download
                    .as_ref()
                    .is_some_and(|d| d.state == StudioDownloadState::Failed)
            },
            "failed",
        )
        .await;
    assert_eq!(
        view.studio_tools
            .download
            .expect("download")
            .error
            .as_deref(),
        Some("That file is not on this computer any more.")
    );
}
