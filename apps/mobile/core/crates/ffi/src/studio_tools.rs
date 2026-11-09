//! The rest of Studio on the phone: voice, the timeline, and taking the finished film home.

use crate::engine::{Done, Engine, Runner, Task};
use crate::labels::bytes_label;
use crate::ops::asking;
use crate::view::{
    AppView, StudioClipView, StudioDownloadState, StudioDownloadView, StudioMediaView,
    StudioNarrationView, StudioTimelineView, StudioTrackView, StudioVoiceEngineView,
    StudioVoiceOptionView, StudioVoiceView,
};
use runova_rpc::{ManageClient, RpcError, StreamEvent};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const FLICKS_PER_SECOND: f64 = 705_600_000.0;
/// One pull. Small enough to go through the link, big enough not to crawl.
const CHUNK: u64 = 512 * 1024;

#[derive(Deserialize)]
struct EngineDto {
    id: String,
    label: String,
    problem: Option<String>,
    locked: bool,
    local: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDto {
    label: String,
    #[serde(rename = "ref")]
    reference: String,
    non_commercial: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EstimateDto {
    usd: f64,
    cost_known: bool,
}

#[derive(Deserialize)]
struct TrackDto {
    id: String,
    kind: String,
    name: String,
    muted: bool,
    locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipDto {
    id: String,
    track_id: String,
    start: f64,
    duration: f64,
    gain: f64,
    fade_in: f64,
    fade_out: f64,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineDto {
    seq: i64,
    length_flicks: f64,
    tracks: Vec<TrackDto>,
    clips: Vec<ClipDto>,
    truncated: bool,
}

#[derive(Deserialize)]
struct MediaDto {
    hash: String,
    name: String,
    duration: Option<f64>,
}

#[derive(Deserialize)]
pub(crate) struct NarrationDto {
    id: String,
    status: String,
    done: u32,
    total: u32,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenedDto {
    download_id: String,
    file_name: String,
    bytes: u64,
    non_commercial: Vec<String>,
}

fn seconds_label(flicks: f64) -> String {
    let seconds = (flicks / FLICKS_PER_SECOND).round() as i64;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

pub(crate) fn narration_view(dto: NarrationDto) -> Option<StudioNarrationView> {
    let running = dto.status == "running";
    if !running && dto.status != "failed" {
        return None;
    }
    Some(StudioNarrationView {
        label: if running {
            format!("Speaking {} of {}", dto.done, dto.total)
        } else {
            dto.error
                .clone()
                .unwrap_or_else(|| "The voice did not finish".to_owned())
        },
        percent: (running && dto.total > 0)
            .then(|| f64::from(dto.done) * 100.0 / f64::from(dto.total)),
        running,
        job_id: dto.id,
    })
}

fn price_label(estimate: &EstimateDto) -> String {
    if !estimate.cost_known {
        "This voice has no known price".to_owned()
    } else if estimate.usd == 0.0 {
        "Free".to_owned()
    } else if estimate.usd < 0.01 {
        "Under 1 cent".to_owned()
    } else {
        format!("About ${:.2}", estimate.usd)
    }
}

fn timeline_view(dto: TimelineDto, music: Vec<StudioMediaView>) -> StudioTimelineView {
    let length = dto.length_flicks.max(1.0);
    let mut by_track: HashMap<String, Vec<StudioClipView>> = HashMap::new();
    for clip in dto.clips {
        by_track
            .entry(clip.track_id)
            .or_default()
            .push(StudioClipView {
                id: clip.id,
                label: clip.label,
                detail: format!(
                    "{}, {}",
                    seconds_label(clip.start),
                    seconds_label(clip.duration)
                ),
                left: (clip.start / length).clamp(0.0, 1.0),
                width: (clip.duration / length).clamp(0.0, 1.0),
                start: clip.start,
                duration: clip.duration,
                gain: clip.gain,
                has_fades: clip.fade_in > 0.0 || clip.fade_out > 0.0,
            });
    }
    StudioTimelineView {
        loading: false,
        seq: dto.seq,
        length_label: seconds_label(dto.length_flicks),
        tracks: dto
            .tracks
            .into_iter()
            .map(|track| StudioTrackView {
                clips: by_track.remove(&track.id).unwrap_or_default(),
                id: track.id,
                kind: track.kind,
                name: track.name,
                muted: track.muted,
                locked: track.locked,
            })
            .collect(),
        truncated: dto.truncated,
        music,
    }
}

/// Only the last part of a name from the computer, so nothing can land outside the folder.
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if last.is_empty() || last == "." || last == ".." {
        "video.mp4".to_owned()
    } else {
        last.to_owned()
    }
}

/// Puts one piece at its place in the file, off the runtime's threads.
async fn write_at(path: PathBuf, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(&bytes)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

async fn read_piece(
    client: &ManageClient,
    id: &str,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    let mut stream = client
        .subscribe(
            "studio.downloadRead",
            Some(json!({"downloadId": id, "offset": offset, "length": length})),
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(length as usize);
    while let Some(event) = stream.next().await {
        match event {
            StreamEvent::Bytes(part) => bytes.extend_from_slice(&part),
            StreamEvent::Ended(None) => break,
            StreamEvent::Ended(Some(error)) => return Err(error.to_string()),
            StreamEvent::Value(_) => {}
        }
    }
    Ok(bytes)
}

impl Runner {
    fn studio_call(
        &mut self,
        method: &'static str,
        params: Value,
        then: impl FnOnce(&mut Runner, Result<Value, RpcError>) + Send + 'static,
    ) {
        let Some(client) = self.client() else {
            return;
        };
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call(method, Some(params)).await;
            let task: Task = Box::new(move |runner| then(runner, outcome));
            let _ = done.send(Done::Run { attempt, task });
        });
    }

    fn open_video_id(&self) -> Option<String> {
        self.view
            .studio
            .video
            .as_ref()
            .map(|video| video.id.clone())
    }

    fn voice_scene_ids(&self) -> Vec<String> {
        let Some(video) = self.view.studio.video.as_ref() else {
            return Vec::new();
        };
        let silent: Vec<String> = video
            .scenes
            .iter()
            .filter(|scene| !scene.voiced && !scene.narration.is_empty())
            .map(|scene| scene.id.clone())
            .collect();
        if silent.is_empty() {
            video.scenes.iter().map(|scene| scene.id.clone()).collect()
        } else {
            silent
        }
    }

    fn load_voices(&mut self, engine: String) {
        let lang = self.studio_language.clone();
        self.studio_call(
            "studio.voices",
            json!({"engine": engine, "lang": lang}),
            |runner, outcome| {
                let Some(voice) = runner.view.studio_tools.voice.as_mut() else {
                    return;
                };
                voice.loading = false;
                match outcome.map(serde_json::from_value::<Vec<VoiceDto>>) {
                    Ok(Ok(voices)) => {
                        voice.voices = voices
                            .into_iter()
                            .map(|one| StudioVoiceOptionView {
                                label: one.label,
                                reference: one.reference,
                                non_commercial: one.non_commercial,
                            })
                            .collect();
                    }
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => voice.error = Some(error.to_string()),
                }
            },
        );
    }

    fn estimate_voice(&mut self) {
        let (Some(video_id), Some(voice_ref)) = (
            self.open_video_id(),
            self.view
                .studio_tools
                .voice
                .as_ref()
                .and_then(|voice| voice.voice.clone()),
        ) else {
            return;
        };
        let scenes = self.voice_scene_ids();
        self.studio_call(
            "studio.voiceEstimate",
            json!({"videoId": video_id, "sceneIds": scenes, "voiceRef": voice_ref}),
            |runner, outcome| {
                let Some(voice) = runner.view.studio_tools.voice.as_mut() else {
                    return;
                };
                if let Ok(Ok(dto)) = outcome.map(serde_json::from_value::<EstimateDto>) {
                    voice.price_label = Some(price_label(&dto));
                    voice.usd = dto.usd;
                    voice.cost_known = dto.cost_known;
                }
            },
        );
    }

    fn load_timeline(&mut self) {
        let Some(video_id) = self.open_video_id() else {
            return;
        };
        let timeline_for = video_id.clone();
        self.studio_call(
            "studio.media",
            json!({"videoId": video_id, "kind": "audio"}),
            move |runner, outcome| {
                let music: Vec<StudioMediaView> = outcome
                    .ok()
                    .and_then(|value| serde_json::from_value::<Vec<MediaDto>>(value).ok())
                    .unwrap_or_default()
                    .into_iter()
                    .map(|one| StudioMediaView {
                        hash: one.hash,
                        detail: one.duration.map(seconds_label).unwrap_or_default(),
                        name: one.name,
                    })
                    .collect();
                runner.studio_call(
                    "studio.timeline",
                    json!({"videoId": timeline_for}),
                    move |runner, outcome| {
                        if runner.view.studio_tools.timeline.is_none() {
                            return;
                        }
                        match outcome.map(serde_json::from_value::<TimelineDto>) {
                            Ok(Ok(dto)) => {
                                runner.view.studio_tools.timeline = Some(timeline_view(dto, music))
                            }
                            Ok(Err(_)) | Err(RpcError::Closed) => {}
                            Err(error) => {
                                runner.view.error = Some(error.to_string());
                                if let Some(timeline) = runner.view.studio_tools.timeline.as_mut() {
                                    timeline.loading = false;
                                }
                            }
                        }
                    },
                );
            },
        );
    }

    fn timeline_op(&mut self, method: &'static str, extra: Value) {
        let (Some(video_id), Some(seq)) = (
            self.open_video_id(),
            self.view
                .studio_tools
                .timeline
                .as_ref()
                .map(|timeline| timeline.seq),
        ) else {
            return;
        };
        let mut params = json!({"videoId": video_id, "baseSeq": seq});
        if let (Some(target), Some(fields)) = (params.as_object_mut(), extra.as_object()) {
            target.extend(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
        self.op(method, Some(params), Runner::load_timeline);
    }

    fn clip(&self, id: &str) -> Option<StudioClipView> {
        self.view
            .studio_tools
            .timeline
            .as_ref()?
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter())
            .find(|clip| clip.id == id)
            .cloned()
    }

    fn start_download(&mut self, job_id: String, folder: String) {
        let Some(client) = self.client() else {
            return;
        };
        let stop = Arc::new(AtomicBool::new(false));
        self.download_stop = Some(stop.clone());
        self.view.studio_tools.download = Some(StudioDownloadView {
            job_id: job_id.clone(),
            file_name: String::new(),
            size_label: String::new(),
            percent: 0.0,
            state: StudioDownloadState::Running,
            path: None,
            error: None,
            non_commercial: false,
        });
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        let report = move |task: Task| {
            let _ = done.send(Done::Run { attempt, task });
        };
        tokio::spawn(async move {
            let outcome = download(&client, &job_id, Path::new(&folder), &stop, &report).await;
            report(Box::new(move |runner| {
                runner.download_stop = None;
                let Some(view) = runner.view.studio_tools.download.as_mut() else {
                    return;
                };
                match outcome {
                    Ok(path) => {
                        view.state = StudioDownloadState::Done;
                        view.percent = 100.0;
                        view.path = Some(path);
                    }
                    Err(error) => {
                        view.state = StudioDownloadState::Failed;
                        view.error = Some(error);
                    }
                }
            }));
        });
    }
}

async fn download(
    client: &ManageClient,
    job_id: &str,
    folder: &Path,
    stop: &AtomicBool,
    report: &(impl Fn(Task) + Send + Sync),
) -> Result<String, String> {
    let opened: OpenedDto = serde_json::from_value(
        client
            .call("studio.downloadOpen", Some(json!({"jobId": job_id})))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|_| "The computer's answer could not be read.".to_owned())?;
    let name = safe_name(&opened.file_name);
    let size = opened.bytes;
    let warned = !opened.non_commercial.is_empty();
    let shown = name.clone();
    report(Box::new(move |runner: &mut Runner| {
        if let Some(view) = runner.view.studio_tools.download.as_mut() {
            view.file_name = shown;
            view.size_label = bytes_label(size);
            view.non_commercial = warned;
        }
    }));
    let path = folder.join(&name);
    // A file left by an earlier try picks up where it stopped.
    let mut offset = std::fs::metadata(&path)
        .map_or(0, |meta| meta.len())
        .min(size);
    let mut last_percent = 0u64;
    while offset < size {
        if stop.load(Ordering::SeqCst) {
            let _ = client
                .call(
                    "studio.downloadClose",
                    Some(json!({"downloadId": opened.download_id})),
                )
                .await;
            return Err("Stopped.".to_owned());
        }
        let bytes = read_piece(
            client,
            &opened.download_id,
            offset,
            CHUNK.min(size - offset),
        )
        .await?;
        if bytes.is_empty() {
            return Err("The computer sent nothing more.".to_owned());
        }
        let length = bytes.len() as u64;
        write_at(path.clone(), offset, bytes).await?;
        offset += length;
        let percent = offset * 100 / size.max(1);
        if percent > last_percent {
            last_percent = percent;
            report(Box::new(move |runner: &mut Runner| {
                if let Some(view) = runner.view.studio_tools.download.as_mut() {
                    view.percent = percent as f64;
                }
            }));
        }
    }
    let _ = client
        .call(
            "studio.downloadClose",
            Some(json!({"downloadId": opened.download_id})),
        )
        .await;
    Ok(path.to_string_lossy().into_owned())
}

/// Called with the video's details as they arrive.
pub(crate) fn apply_tools(view: &mut AppView, narration: Option<NarrationDto>) {
    view.studio_tools.narration = narration.and_then(narration_view);
}

#[uniffi::export]
impl Engine {
    pub fn studio_open_voice(&self) {
        self.run(|r| {
            r.view.studio_tools.voice = Some(StudioVoiceView {
                loading: true,
                engines: Vec::new(),
                engine: None,
                voices: Vec::new(),
                voice: None,
                price_label: None,
                usd: 0.0,
                cost_known: false,
                scene_count: r.voice_scene_ids().len() as u32,
                error: None,
            });
            r.studio_call("studio.voiceEngines", json!({}), |runner, outcome| {
                let mut first = None;
                {
                    let Some(voice) = runner.view.studio_tools.voice.as_mut() else {
                        return;
                    };
                    match outcome.map(serde_json::from_value::<Vec<EngineDto>>) {
                        Ok(Ok(engines)) => {
                            voice.engines = engines
                                .into_iter()
                                .map(|one| StudioVoiceEngineView {
                                    problem: one.problem,
                                    locked: one.locked,
                                    local: one.local,
                                    id: one.id,
                                    label: one.label,
                                })
                                .collect();
                            first = voice
                                .engines
                                .iter()
                                .find(|one| one.problem.is_none())
                                .map(|one| one.id.clone());
                            voice.engine.clone_from(&first);
                            voice.loading = first.is_some();
                        }
                        Ok(Err(_)) | Err(RpcError::Closed) => voice.loading = false,
                        Err(error) => {
                            voice.loading = false;
                            voice.error = Some(error.to_string());
                        }
                    }
                }
                if let Some(engine) = first {
                    runner.load_voices(engine);
                }
            });
        });
    }

    pub fn studio_close_voice(&self) {
        self.run(|r| r.view.studio_tools.voice = None);
    }

    pub fn studio_voice_pick_engine(&self, engine: String) {
        self.run(move |r| {
            if let Some(voice) = r.view.studio_tools.voice.as_mut() {
                voice.engine = Some(engine.clone());
                voice.voices.clear();
                voice.voice = None;
                voice.price_label = None;
                voice.loading = true;
            }
            r.load_voices(engine);
        });
    }

    pub fn studio_voice_pick(&self, reference: String) {
        self.run(move |r| {
            if let Some(voice) = r.view.studio_tools.voice.as_mut() {
                voice.voice = Some(reference);
                voice.price_label = None;
            }
            r.estimate_voice();
        });
    }

    /// Speaks at the price the sheet is showing. The computer turns down any other.
    pub fn studio_speak(&self) {
        self.run(|r| {
            let Some(voice) = r.view.studio_tools.voice.clone() else {
                return;
            };
            let (Some(video_id), Some(reference)) = (r.open_video_id(), voice.voice) else {
                return;
            };
            let scenes = r.voice_scene_ids();
            let mut params =
                json!({"videoId": video_id, "sceneIds": scenes, "voiceRef": reference});
            if voice.cost_known {
                params["confirmedUsd"] = json!(voice.usd);
            } else {
                params["acceptUnknownCost"] = json!(true);
            }
            r.view.studio_tools.voice = None;
            r.op("studio.speak", Some(params), Runner::refresh_studio);
        });
    }

    pub fn studio_cancel_speak(&self) {
        self.run(|r| {
            let (Some(video_id), Some(job_id)) = (
                r.open_video_id(),
                r.view
                    .studio_tools
                    .narration
                    .as_ref()
                    .map(|one| one.job_id.clone()),
            ) else {
                return;
            };
            r.op(
                "studio.cancelSpeak",
                Some(json!({"videoId": video_id, "jobId": job_id})),
                Runner::refresh_studio,
            );
        });
    }

    pub fn studio_caption_scene(&self, scene_id: String) {
        self.run(move |r| {
            if let Some(video_id) = r.open_video_id() {
                r.op(
                    "studio.captionScene",
                    Some(json!({"videoId": video_id, "sceneId": scene_id})),
                    Runner::refresh_studio,
                );
            }
        });
    }

    pub fn studio_open_timeline(&self) {
        self.run(|r| {
            r.view.error = None;
            r.view.studio_tools.timeline = Some(StudioTimelineView {
                loading: true,
                seq: 0,
                length_label: String::new(),
                tracks: Vec::new(),
                truncated: false,
                music: Vec::new(),
            });
            r.load_timeline();
        });
    }

    pub fn studio_close_timeline(&self) {
        self.run(|r| r.view.studio_tools.timeline = None);
    }

    /// Moves a clip by this many seconds, either way.
    pub fn studio_clip_nudge(&self, clip_id: String, seconds: f64) {
        self.run(move |r| {
            if let Some(clip) = r.clip(&clip_id) {
                let start = (clip.start + seconds * FLICKS_PER_SECOND).max(0.0).round();
                r.timeline_op(
                    "studio.clipEdit",
                    json!({"clipId": clip_id, "action": "move", "start": start}),
                );
            }
        });
    }

    /// Moves one end of a clip by this many seconds.
    pub fn studio_clip_trim(&self, clip_id: String, end: bool, seconds: f64) {
        self.run(move |r| {
            if let Some(clip) = r.clip(&clip_id) {
                let edge_at = if end { clip.start + clip.duration } else { clip.start };
                let to = (edge_at + seconds * FLICKS_PER_SECOND).max(0.0).round();
                r.timeline_op(
                    "studio.clipEdit",
                    json!({"clipId": clip_id, "action": "trim", "edge": if end { "end" } else { "start" }, "to": to}),
                );
            }
        });
    }

    pub fn studio_clip_gain(&self, clip_id: String, gain: f64) {
        self.run(move |r| {
            r.timeline_op(
                "studio.clipEdit",
                json!({"clipId": clip_id, "action": "set", "gain": gain}),
            );
        });
    }

    pub fn studio_clip_fades(&self, clip_id: String, seconds: f64) {
        self.run(move |r| {
            let fade = (seconds * FLICKS_PER_SECOND).round();
            r.timeline_op(
                "studio.clipEdit",
                json!({"clipId": clip_id, "action": "set", "fadeIn": fade, "fadeOut": fade}),
            );
        });
    }

    pub fn studio_clip_remove(&self, clip_id: String) {
        self.run(move |r| {
            r.ask(
                asking(
                    "Delete this clip?",
                    "You can undo this from the video.".to_owned(),
                    "Delete",
                ),
                move |runner| {
                    runner.timeline_op(
                        "studio.clipEdit",
                        json!({"clipId": clip_id, "action": "remove"}),
                    )
                },
            );
        });
    }

    pub fn studio_add_music(&self, hash: String) {
        self.run(move |r| r.timeline_op("studio.addMusic", json!({"hash": hash})));
    }

    pub fn studio_track_mute(&self, track_id: String, muted: bool) {
        self.run(move |r| {
            r.timeline_op(
                "studio.trackSet",
                json!({"trackId": track_id, "muted": muted}),
            )
        });
    }

    /// Fetches a finished video into `folder`, which the app owns.
    pub fn studio_download(&self, job_id: String, folder: String) {
        self.run(move |r| r.start_download(job_id, folder));
    }

    pub fn studio_download_stop(&self) {
        self.run(|r| {
            if let Some(stop) = r.download_stop.take() {
                stop.store(true, Ordering::SeqCst);
            }
        });
    }

    pub fn studio_download_dismiss(&self) {
        self.run(|r| r.view.studio_tools.download = None);
    }
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn a_name_cannot_climb_out_of_the_folder() {
        assert_eq!(safe_name("../../evil.mp4"), "evil.mp4");
        assert_eq!(safe_name("C:\\x\\film.mp4"), "film.mp4");
        assert_eq!(safe_name(".."), "video.mp4");
    }
}
