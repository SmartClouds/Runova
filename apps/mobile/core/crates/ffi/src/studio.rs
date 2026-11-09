//! Studio on the phone: the video library, a new video from a prompt, watching the AI work, and
//! rendering. All of it runs on the computer; the phone only asks and watches.

use crate::engine::{Done, Engine, Runner, Task};
use crate::labels::{ago_label, bytes_label};
use crate::ops::asking;
use crate::studio_tools::{NarrationDto, apply_tools};
use crate::view::{
    AppView, StudioChangeField, StudioChangeView, StudioComposerView, StudioLanguageView,
    StudioProposalView, StudioRenderSheetView, StudioRenderState, StudioRenderView, StudioRunView,
    StudioSceneView, StudioStepState, StudioStepView, StudioStyleView, StudioVideoItemView,
    StudioVideoView,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use runova_rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

const FLICKS_PER_SECOND: f64 = 705_600_000.0;
/// Pictures kept in memory. A long video simply fetches the oldest again.
const MAX_THUMBNAILS: usize = 40;
const MAX_THUMBNAIL_FETCHES: usize = 3;
const NOT_ALLOWED: &str = "Turn on Studio for this phone in Runova on this computer, under Remote.";

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RenderDto {
    id: String,
    file_name: String,
    status: String,
    phase: Option<String>,
    done: u64,
    total: u64,
    finished: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoDto {
    id: String,
    title: String,
    pinned: bool,
    missing: bool,
    opened_ago_ms: i64,
    render: Option<RenderDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneDto {
    id: String,
    title: String,
    narration: String,
    flicks: f64,
    thumbnail: Option<String>,
    #[serde(default)]
    voiced: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunDto {
    id: String,
    stage: String,
    cli_name: Option<String>,
    elapsed_ms: i64,
    repairs: u32,
    lines: Vec<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct FieldDto {
    label: String,
    before: String,
    after: String,
}

#[derive(Deserialize)]
struct ChangeDto {
    title: String,
    fields: Vec<FieldDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalDto {
    generation_id: String,
    summary: String,
    changes: Vec<ChangeDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailDto {
    id: String,
    title: String,
    aspect: String,
    quality: String,
    can_undo: bool,
    undo_label: Option<String>,
    scenes: Vec<SceneDto>,
    run: Option<RunDto>,
    failed_run: Option<RunDto>,
    proposal: Option<ProposalDto>,
    renders: Vec<RenderDto>,
    animating_all: bool,
    stopped: Option<String>,
    #[serde(default)]
    language: String,
    #[serde(default)]
    narration: Option<NarrationDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionsDto {
    languages: Vec<LanguageDto>,
    styles: Vec<StyleDto>,
}

#[derive(Deserialize)]
struct LanguageDto {
    code: String,
    name: String,
    native: String,
}

#[derive(Deserialize)]
struct StyleDto {
    id: String,
    name: String,
    summary: String,
    colors: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EstimateDto {
    ok: bool,
    problems: Vec<String>,
    width: Option<u32>,
    height: Option<u32>,
    output_bytes: Option<u64>,
    seconds: Option<f64>,
    warnings: Vec<String>,
}

#[derive(Deserialize)]
struct CreatedDto {
    #[serde(rename = "videoId")]
    video_id: String,
}

#[derive(Deserialize)]
struct ThumbnailDto {
    png: Option<String>,
}

/// Picture bytes live here, not in the view, which is copied to native code on every change.
#[derive(Default)]
pub(crate) struct Thumbnails {
    bytes: HashMap<String, Vec<u8>>,
    order: VecDeque<String>,
    fetching: HashSet<String>,
}

impl Thumbnails {
    fn keep(&mut self, hash: String, png: Vec<u8>) {
        self.fetching.remove(&hash);
        if self.bytes.insert(hash.clone(), png).is_none() {
            self.order.push_back(hash);
        }
        while self.order.len() > MAX_THUMBNAILS {
            if let Some(oldest) = self.order.pop_front() {
                self.bytes.remove(&oldest);
            }
        }
    }
}

pub(crate) type SharedThumbnails = Arc<Mutex<Thumbnails>>;

fn clock_label(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}

fn plural(count: usize, one: &str) -> String {
    format!("{count} {one}{}", if count == 1 { "" } else { "s" })
}

fn state_of(render: &RenderDto) -> StudioRenderState {
    match render.status.as_str() {
        "queued" => StudioRenderState::Queued,
        "running" => StudioRenderState::Running,
        "done" => StudioRenderState::Done,
        "cancelled" => StudioRenderState::Stopped,
        _ => StudioRenderState::Failed,
    }
}

fn percent_of(render: &RenderDto) -> Option<f64> {
    (render.status == "running" && render.total > 0)
        .then(|| render.done as f64 * 100.0 / render.total as f64)
}

fn render_label(render: &RenderDto) -> String {
    match state_of(render) {
        StudioRenderState::Queued => "Waiting its turn".to_owned(),
        StudioRenderState::Running if render.phase.as_deref() == Some("encode") => {
            format!("Encoding {:.0}%", percent_of(render).unwrap_or(0.0))
        }
        StudioRenderState::Running if render.total > 0 => {
            format!("Drawing frames: {} of {}", render.done, render.total)
        }
        StudioRenderState::Running => "Getting ready".to_owned(),
        StudioRenderState::Done if render.finished => "Saved on this computer".to_owned(),
        StudioRenderState::Done => "Finished".to_owned(),
        StudioRenderState::Stopped => "Stopped".to_owned(),
        StudioRenderState::Failed => render
            .error
            .clone()
            .unwrap_or_else(|| "It did not finish".to_owned()),
    }
}

fn render_view(render: RenderDto) -> StudioRenderView {
    let state = state_of(&render);
    StudioRenderView {
        label: render_label(&render),
        percent: percent_of(&render),
        can_cancel: matches!(
            state,
            StudioRenderState::Queued | StudioRenderState::Running
        ),
        id: render.id,
        file_name: render.file_name,
        state,
    }
}

fn run_view(run: RunDto) -> StudioRunView {
    let title = match run.stage.as_str() {
        "scenario" => "Writing the scenes",
        "edit" => "Working on your change",
        "scene" => "Animating a scene",
        _ => "Working on the pictures",
    };
    let mut detail = vec![clock_label(run.elapsed_ms)];
    if let Some(cli) = run.cli_name {
        detail.insert(0, cli);
    }
    if run.repairs > 0 {
        detail.push(format!("repair {}", run.repairs));
    }
    StudioRunView {
        id: run.id,
        title: title.to_owned(),
        detail: detail.join(", "),
        lines: run.lines,
    }
}

fn steps(dto: &DetailDto, animated: usize) -> Vec<StudioStepView> {
    let total = dto.scenes.len();
    let running = dto.run.as_ref().map(|run| run.stage.as_str());
    let scenario = if total > 0 {
        StudioStepState::Done
    } else if running == Some("scenario") {
        StudioStepState::Active
    } else {
        StudioStepState::Todo
    };
    let animate = if total > 0 && animated == total {
        StudioStepState::Done
    } else if total > 0 {
        StudioStepState::Active
    } else {
        StudioStepState::Todo
    };
    let latest = dto.renders.first();
    let render = match latest.map(state_of) {
        Some(StudioRenderState::Queued | StudioRenderState::Running) => StudioStepState::Active,
        Some(StudioRenderState::Done) => StudioStepState::Done,
        _ => StudioStepState::Todo,
    };
    let render_detail = match render {
        StudioStepState::Active => "Working".to_owned(),
        StudioStepState::Done => "Saved".to_owned(),
        StudioStepState::Todo => "Not yet".to_owned(),
    };
    vec![
        StudioStepView {
            label: "Scenes".to_owned(),
            detail: if total > 0 {
                plural(total, "scene")
            } else {
                "Being written".to_owned()
            },
            state: scenario,
        },
        StudioStepView {
            label: "Animate".to_owned(),
            detail: format!("{animated} of {}", plural(total, "scene")),
            state: animate,
        },
        StudioStepView {
            label: "Render".to_owned(),
            detail: render_detail,
            state: render,
        },
    ]
}

fn detail_view(
    dto: DetailDto,
    thumbnails: &Thumbnails,
    sheet: Option<StudioRenderSheetView>,
) -> StudioVideoView {
    let animated = dto
        .scenes
        .iter()
        .filter(|scene| scene.thumbnail.is_some())
        .count();
    let total = dto.scenes.len();
    let left = total - animated;
    let idle = dto.run.is_none() && !dto.animating_all;
    let rendering = dto.renders.iter().any(|render| {
        matches!(
            state_of(render),
            StudioRenderState::Queued | StudioRenderState::Running
        )
    });
    let step_list = steps(&dto, animated);
    let scenes = dto
        .scenes
        .into_iter()
        .enumerate()
        .map(|(index, scene)| StudioSceneView {
            number: index as u32 + 1,
            duration_label: format!("{:.0}s", scene.flicks / FLICKS_PER_SECOND),
            animated: scene.thumbnail.is_some(),
            can_animate: idle,
            thumbnail_ready: scene
                .thumbnail
                .as_ref()
                .is_some_and(|hash| thumbnails.bytes.contains_key(hash)),
            thumbnail: scene.thumbnail,
            voiced: scene.voiced,
            id: scene.id,
            title: scene.title,
            narration: scene.narration,
        })
        .collect();
    StudioVideoView {
        loading: false,
        id: dto.id,
        title: dto.title,
        aspect: dto.aspect,
        quality: dto.quality,
        can_undo: dto.can_undo && idle,
        undo_label: dto.undo_label,
        steps: step_list,
        scenes,
        problem: dto
            .stopped
            .or_else(|| dto.failed_run.and_then(|run| run.error)),
        run: dto.run.map(run_view),
        proposal: dto.proposal.map(|proposal| StudioProposalView {
            generation_id: proposal.generation_id,
            summary: proposal.summary,
            changes: proposal
                .changes
                .into_iter()
                .map(|change| StudioChangeView {
                    title: change.title,
                    fields: change
                        .fields
                        .into_iter()
                        .map(|field| StudioChangeField {
                            label: field.label,
                            before: field.before,
                            after: field.after,
                        })
                        .collect(),
                })
                .collect(),
        }),
        renders: dto.renders.into_iter().map(render_view).collect(),
        animating_all: dto.animating_all,
        animate_all_label: (left > 0 && idle).then(|| format!("Animate {}", plural(left, "scene"))),
        can_ask: idle,
        can_render: total > 0 && left == 0 && idle && !rendering,
        render_sheet: sheet,
    }
}

fn minutes_label(seconds: f64) -> String {
    if seconds < 90.0 {
        format!("about {} seconds", seconds.round() as u64)
    } else {
        format!("about {} minutes", (seconds / 60.0).round() as u64)
    }
}

impl Runner {
    pub(crate) fn refresh_studio(&mut self) {
        if self.view.studio.video.is_some() {
            self.load_studio_video();
        } else {
            self.load_studio_list();
        }
    }

    fn load_studio_list(&mut self) {
        self.view.studio.loading = self.view.studio.videos.is_empty();
        let Some(client) = self.client() else {
            self.view.studio.loading = false;
            return;
        };
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call("studio.list", None).await;
            let task: Task = Box::new(move |runner| {
                runner.view.studio.loading = false;
                match outcome {
                    Ok(value) => {
                        if let Ok(videos) = serde_json::from_value::<Vec<VideoDto>>(value) {
                            runner.view.studio.note = None;
                            runner.view.studio.videos = videos.into_iter().map(item_view).collect();
                        }
                    }
                    Err(RpcError::Closed) => {}
                    Err(RpcError::Refused { code, .. }) if code == "forbidden" => {
                        runner.view.studio.note = Some(NOT_ALLOWED.to_owned());
                    }
                    Err(error) => runner.view.studio.note = Some(error.to_string()),
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        });
    }

    fn load_studio_video(&mut self) {
        let Some(id) = self
            .view
            .studio
            .video
            .as_ref()
            .map(|video| video.id.clone())
        else {
            return;
        };
        let Some(client) = self.client() else {
            return;
        };
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client
                .call("studio.video", Some(json!({"videoId": id})))
                .await;
            let task: Task = Box::new(move |runner| runner.studio_video_arrived(outcome));
            let _ = done.send(Done::Run { attempt, task });
        });
    }

    fn studio_video_arrived(&mut self, outcome: Result<Value, RpcError>) {
        let mut dto = match outcome.map(serde_json::from_value::<DetailDto>) {
            Ok(Ok(dto)) => dto,
            Ok(Err(_)) | Err(RpcError::Closed) => return,
            Err(error) => {
                self.view.error = Some(error.to_string());
                if let Some(video) = self.view.studio.video.as_mut() {
                    video.loading = false;
                }
                return;
            }
        };
        let Some(sheet) = self
            .view
            .studio
            .video
            .as_ref()
            .filter(|video| video.id == dto.id)
            .map(|video| video.render_sheet.clone())
        else {
            return;
        };
        self.studio_language.clone_from(&dto.language);
        apply_tools(&mut self.view, dto.narration.take());
        let wanted: Vec<String> = dto
            .scenes
            .iter()
            .filter_map(|scene| scene.thumbnail.clone())
            .collect();
        let view = {
            let pictures = self.thumbnails.lock().expect("thumbnails");
            detail_view(dto, &pictures, sheet)
        };
        let id = view.id.clone();
        self.view.studio.video = Some(view);
        self.fetch_thumbnails(id, wanted);
    }

    fn fetch_thumbnails(&mut self, video_id: String, wanted: Vec<String>) {
        let Some(client) = self.client() else {
            return;
        };
        let start: Vec<String> = {
            let mut pictures = self.thumbnails.lock().expect("thumbnails");
            let room = MAX_THUMBNAIL_FETCHES.saturating_sub(pictures.fetching.len());
            let picked: Vec<String> = wanted
                .into_iter()
                .filter(|hash| {
                    !pictures.bytes.contains_key(hash) && !pictures.fetching.contains(hash)
                })
                .take(room)
                .collect();
            pictures.fetching.extend(picked.iter().cloned());
            picked
        };
        for hash in start {
            let client = client.clone();
            let done = self.done_tx.clone();
            let attempt = self.attempt;
            let thumbnails = self.thumbnails.clone();
            let params = json!({"videoId": video_id, "hash": hash});
            tokio::spawn(async move {
                let png = client
                    .call("studio.thumbnail", Some(params))
                    .await
                    .ok()
                    .and_then(|value| serde_json::from_value::<ThumbnailDto>(value).ok())
                    .and_then(|dto| dto.png)
                    .and_then(|text| STANDARD.decode(text).ok());
                let task: Task = Box::new(move |runner| {
                    let mut pictures = thumbnails.lock().expect("thumbnails");
                    let Some(png) = png else {
                        pictures.fetching.remove(&hash);
                        return;
                    };
                    pictures.keep(hash.clone(), png);
                    if let Some(video) = runner.view.studio.video.as_mut() {
                        for scene in &mut video.scenes {
                            if scene.thumbnail.as_deref() == Some(hash.as_str()) {
                                scene.thumbnail_ready = true;
                            }
                        }
                    }
                });
                let _ = done.send(Done::Run { attempt, task });
            });
        }
    }

    fn studio_video_id(&self) -> Option<String> {
        self.view
            .studio
            .video
            .as_ref()
            .map(|video| video.id.clone())
    }

    fn studio_op(&mut self, method: &'static str, extra: Value) {
        let Some(video_id) = self.studio_video_id() else {
            return;
        };
        let mut params = json!({"videoId": video_id});
        if let (Some(target), Some(fields)) = (params.as_object_mut(), extra.as_object()) {
            target.extend(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
        self.op(method, Some(params), Runner::refresh_studio);
    }

    fn open_studio_video(&mut self, id: String, title: String) {
        self.view.studio.composer = None;
        self.view.studio.video = Some(StudioVideoView {
            loading: true,
            id,
            title,
            aspect: String::new(),
            quality: String::new(),
            can_undo: false,
            undo_label: None,
            steps: Vec::new(),
            scenes: Vec::new(),
            problem: None,
            run: None,
            proposal: None,
            renders: Vec::new(),
            animating_all: false,
            animate_all_label: None,
            can_ask: false,
            can_render: false,
            render_sheet: None,
        });
        self.load_studio_video();
    }

    fn studio_create(&mut self, params: Value) {
        let Some(client) = self.client() else {
            return;
        };
        self.view.busy = true;
        self.view.error = None;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call("studio.create", Some(params)).await;
            let task: Task = Box::new(move |runner| {
                runner.view.busy = false;
                match outcome.map(serde_json::from_value::<CreatedDto>) {
                    Ok(Ok(created)) => {
                        runner.open_studio_video(created.video_id, "New video".to_owned())
                    }
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => runner.view.error = Some(error.to_string()),
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        });
    }

    fn apply_estimate(view: &mut AppView, dto: EstimateDto) {
        let Some(sheet) = view
            .studio
            .video
            .as_mut()
            .and_then(|video| video.render_sheet.as_mut())
        else {
            return;
        };
        sheet.loading = false;
        sheet.problems = dto.problems;
        sheet.warnings = dto.warnings;
        sheet.summary = dto.ok.then(|| {
            format!(
                "{} x {}, about {}, {}",
                dto.width.unwrap_or(0),
                dto.height.unwrap_or(0),
                bytes_label(dto.output_bytes.unwrap_or(0)),
                minutes_label(dto.seconds.unwrap_or(0.0)),
            )
        });
    }
}

fn item_view(video: VideoDto) -> StudioVideoItemView {
    StudioVideoItemView {
        render_label: video
            .render
            .as_ref()
            .filter(|render| render.status != "cancelled")
            .map(render_label),
        render_state: video
            .render
            .as_ref()
            .filter(|render| render.status != "cancelled")
            .map(state_of),
        detail: format!("Opened {}", ago_label(video.opened_ago_ms)),
        id: video.id,
        title: video.title,
        pinned: video.pinned,
        missing: video.missing,
    }
}

#[uniffi::export]
impl Engine {
    pub fn studio_open_composer(&self) {
        self.run(|r| {
            r.view.error = None;
            r.view.studio.composer = Some(StudioComposerView::default());
            r.call(
                "studio.options",
                None,
                |view: &mut AppView, dto: OptionsDto| {
                    if let Some(composer) = view.studio.composer.as_mut() {
                        composer.languages = dto
                            .languages
                            .into_iter()
                            .map(|l| StudioLanguageView {
                                code: l.code,
                                name: l.name,
                                native: l.native,
                            })
                            .collect();
                        composer.styles = dto
                            .styles
                            .into_iter()
                            .map(|s| StudioStyleView {
                                id: s.id,
                                name: s.name,
                                summary: s.summary,
                                colors: s.colors,
                            })
                            .collect();
                    }
                },
                |_| {},
            );
        });
    }

    pub fn studio_close_composer(&self) {
        self.run(|r| r.view.studio.composer = None);
    }

    pub fn studio_create(
        &self,
        brief: String,
        aspect: String,
        language: String,
        seconds: u32,
        style_id: Option<String>,
    ) {
        self.run(move |r| {
            r.studio_create(json!({
                "brief": brief, "aspect": aspect, "language": language, "seconds": seconds, "styleId": style_id,
            }));
        });
    }

    pub fn studio_open_video(&self, id: String) {
        self.run(move |r| {
            let title = r
                .view
                .studio
                .videos
                .iter()
                .find(|video| video.id == id)
                .map(|video| video.title.clone())
                .unwrap_or_default();
            r.view.error = None;
            r.open_studio_video(id, title);
        });
    }

    pub fn studio_close_video(&self) {
        self.run(|r| {
            if let Some(video_id) = r.studio_video_id() {
                r.call(
                    "studio.leave",
                    Some(json!({"videoId": video_id})),
                    |_: &mut AppView, _: Value| {},
                    |_| {},
                );
            }
            r.view.studio.video = None;
            r.view.error = None;
            r.refresh_studio();
        });
    }

    pub fn studio_ask(&self, instruction: String) {
        self.run(move |r| r.studio_op("studio.ask", json!({"instruction": instruction})));
    }

    pub fn studio_apply_proposal(&self) {
        self.run(|r| {
            let id = r
                .view
                .studio
                .video
                .as_ref()
                .and_then(|v| v.proposal.as_ref())
                .map(|p| p.generation_id.clone());
            if let Some(generation_id) = id {
                r.studio_op(
                    "studio.applyProposal",
                    json!({"generationId": generation_id}),
                );
            }
        });
    }

    pub fn studio_discard_proposal(&self) {
        self.run(|r| {
            let id = r
                .view
                .studio
                .video
                .as_ref()
                .and_then(|v| v.proposal.as_ref())
                .map(|p| p.generation_id.clone());
            if let Some(generation_id) = id {
                r.studio_op(
                    "studio.discardProposal",
                    json!({"generationId": generation_id}),
                );
            }
        });
    }

    pub fn studio_undo(&self) {
        self.run(|r| r.studio_op("studio.undo", json!({})));
    }

    pub fn studio_animate(&self, scene_id: String) {
        self.run(move |r| r.studio_op("studio.animate", json!({"sceneId": scene_id})));
    }

    pub fn studio_animate_all(&self) {
        self.run(|r| {
            let left = r.view.studio.video.as_ref().map_or(0, |video| {
                video.scenes.iter().filter(|scene| !scene.animated).count()
            });
            r.ask(
                asking(
                    "Animate every scene?",
                    format!(
                        "Your AI CLI on this computer draws {}, one at a time. Each is its own AI run, and it carries on if you lock your phone.",
                        plural(left, "scene"),
                    ),
                    "Animate",
                ),
                |runner| runner.studio_op("studio.animateAll", json!({})),
            );
        });
    }

    pub fn studio_cancel_run(&self) {
        self.run(|r| {
            let id = r
                .view
                .studio
                .video
                .as_ref()
                .and_then(|v| v.run.as_ref())
                .map(|run| run.id.clone());
            if let Some(generation_id) = id {
                r.studio_op("studio.cancelRun", json!({"generationId": generation_id}));
            }
        });
    }

    pub fn studio_open_render(&self) {
        self.run(|r| {
            let Some(video) = r.view.studio.video.as_mut() else {
                return;
            };
            video.render_sheet = Some(StudioRenderSheetView {
                loading: true,
                quality: video.quality.clone(),
                summary: None,
                warnings: Vec::new(),
                problems: Vec::new(),
            });
            let id = video.id.clone();
            r.call(
                "studio.renderEstimate",
                Some(json!({"videoId": id})),
                |view: &mut AppView, dto: EstimateDto| Runner::apply_estimate(view, dto),
                |view| {
                    if let Some(sheet) = view
                        .studio
                        .video
                        .as_mut()
                        .and_then(|v| v.render_sheet.as_mut())
                    {
                        sheet.loading = false;
                    }
                },
            );
        });
    }

    pub fn studio_close_render(&self) {
        self.run(|r| {
            if let Some(video) = r.view.studio.video.as_mut() {
                video.render_sheet = None;
            }
        });
    }

    pub fn studio_render(&self, quality: String) {
        self.run(move |r| {
            if let Some(video) = r.view.studio.video.as_mut() {
                video.render_sheet = None;
            }
            r.studio_op("studio.render", json!({"quality": quality}));
        });
    }

    pub fn studio_cancel_render(&self, job_id: String) {
        self.run(move |r| r.studio_op("studio.cancelRender", json!({"jobId": job_id})));
    }

    /// A scene's picture, as PNG bytes, or `None` until it has arrived.
    pub fn studio_thumbnail(&self, hash: String) -> Option<Vec<u8>> {
        self.thumbnails
            .lock()
            .expect("thumbnails")
            .bytes
            .get(&hash)
            .cloned()
    }
}
