//! Monitors, from both the computer and Runova itself, and CI through the computer's `gh`.

use crate::backend::BackendError;
use crate::engine::{Done, Engine, Runner};
use crate::labels::percent_label;
use crate::view::{
    AppView, ConfirmView, DispatchFormView, JobLogView, LogLineView, MonitorSource, MonitorState,
    MonitorView, PipelineJobView, PipelineRunDetailView, PipelineRunState, PipelineRunView,
    PipelinesStatusView, WorkflowInputKind, WorkflowInputView, WorkflowView,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

const CLOUD_MONITORS: &str = "/api/v1/cloud-monitors";
/// Runova's own numbers change slowly, and this is a request to its servers.
const CLOUD_EVERY_TICKS: u32 = 4;
const OFFLINE_NOTE: &str = "Connect to a computer to see the monitors it runs.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalDto {
    id: String,
    name: String,
    state: String,
    #[serde(default)]
    paused: bool,
    latency_ms: Option<f64>,
    uptime24h: Option<f64>,
    headline: Option<String>,
    #[serde(default)]
    samples: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudStatusDto {
    verdict: Option<String>,
    latency_ms: Option<f64>,
    uptime24h: Option<f64>,
    problem: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudDto {
    id: String,
    name: String,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    can_write: bool,
    status: Option<CloudStatusDto>,
}

#[derive(Deserialize)]
struct CloudListDto {
    #[serde(default)]
    items: Vec<CloudDto>,
}

#[derive(Deserialize)]
struct RunDto {
    id: i64,
    title: String,
    branch: String,
    number: u32,
    status: String,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowDto {
    id: i64,
    name: String,
    #[serde(default)]
    can_dispatch: bool,
    run: Option<RunDto>,
    #[serde(default)]
    inputs: Vec<InputDto>,
}

#[derive(Deserialize)]
struct InputDto {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    required: bool,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    default: String,
    #[serde(default)]
    options: Vec<String>,
}

#[derive(Deserialize)]
struct StatusDto {
    problem: Option<String>,
    #[serde(default)]
    workflows: Vec<WorkflowDto>,
}

#[derive(Deserialize)]
struct JobDto {
    id: i64,
    name: String,
    status: String,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
struct JobsDto {
    #[serde(default)]
    jobs: Vec<JobDto>,
}

#[derive(Deserialize)]
struct LogLineDto {
    text: String,
    #[serde(default)]
    error: bool,
}

#[derive(Deserialize)]
struct JobLogDto {
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    lines: Vec<LogLineDto>,
}

fn monitor_state(state: &str, paused: bool) -> MonitorState {
    if paused {
        return MonitorState::Paused;
    }
    match state {
        "pass" | "up" => MonitorState::Up,
        "warn" | "degraded" => MonitorState::Degraded,
        "fail" | "down" => MonitorState::Down,
        "paused" => MonitorState::Paused,
        _ => MonitorState::Unknown,
    }
}

fn latency_label(ms: Option<f64>) -> Option<String> {
    ms.map(|ms| format!("{ms:.0} ms"))
}

fn local_of(dto: LocalDto) -> MonitorView {
    MonitorView {
        state: monitor_state(&dto.state, dto.paused),
        id: dto.id,
        name: dto.name,
        source: MonitorSource::Local,
        detail: dto.headline,
        latency_label: latency_label(dto.latency_ms),
        uptime_label: dto.uptime24h.map(percent_label),
        paused: dto.paused,
        can_check: true,
        can_pause: true,
        samples: dto.samples,
    }
}

fn cloud_of(dto: CloudDto) -> MonitorView {
    let status = dto.status.as_ref();
    MonitorView {
        state: monitor_state(
            status
                .and_then(|s| s.verdict.as_deref())
                .unwrap_or_default(),
            dto.paused,
        ),
        detail: status.and_then(|s| s.problem.clone()),
        latency_label: latency_label(status.and_then(|s| s.latency_ms)),
        uptime_label: status.and_then(|s| s.uptime24h).map(percent_label),
        id: dto.id,
        name: dto.name,
        source: MonitorSource::Cloud,
        paused: dto.paused,
        can_check: false,
        can_pause: dto.can_write,
        samples: Vec::new(),
    }
}

fn run_state(status: &str, conclusion: Option<&str>) -> (PipelineRunState, &'static str) {
    if status != "completed" {
        return if status == "queued" || status == "waiting" || status == "pending" {
            (PipelineRunState::Queued, "Queued")
        } else {
            (PipelineRunState::Running, "Running")
        };
    }
    match conclusion {
        Some("success") => (PipelineRunState::Success, "Passed"),
        Some("failure") | Some("timed_out") | Some("startup_failure") => {
            (PipelineRunState::Failed, "Failed")
        }
        Some("cancelled") => (PipelineRunState::Other, "Cancelled"),
        _ => (PipelineRunState::Other, "Finished"),
    }
}

fn run_of(dto: RunDto) -> PipelineRunView {
    let (state, label) = run_state(&dto.status, dto.conclusion.as_deref());
    PipelineRunView {
        id: dto.id,
        title: dto.title,
        branch: dto.branch,
        number: dto.number,
        state,
        state_label: label.to_owned(),
        can_cancel: matches!(state, PipelineRunState::Queued | PipelineRunState::Running),
    }
}

fn input_of(dto: InputDto) -> WorkflowInputView {
    WorkflowInputView {
        kind: match dto.kind.as_str() {
            "boolean" => WorkflowInputKind::Toggle,
            "choice" => WorkflowInputKind::Choice,
            _ => WorkflowInputKind::Text,
        },
        name: dto.name,
        description: dto.description,
        required: dto.required,
        default_value: dto.default,
        options: dto.options,
    }
}

fn status_of(dto: StatusDto) -> PipelinesStatusView {
    PipelinesStatusView {
        problem: dto.problem,
        workflows: dto
            .workflows
            .into_iter()
            .map(|w| WorkflowView {
                id: w.id,
                name: w.name,
                can_dispatch: w.can_dispatch,
                run: w.run.map(run_of),
                inputs: w.inputs.into_iter().map(input_of).collect(),
            })
            .collect(),
    }
}

fn asking(title: &str, detail: String, action: &str) -> ConfirmView {
    ConfirmView {
        title: title.to_owned(),
        detail,
        action: action.to_owned(),
        danger: true,
    }
}

impl Runner {
    pub(crate) fn refresh_monitoring(&mut self) {
        let tick = self.ticks;
        let cloud_due = tick.is_multiple_of(CLOUD_EVERY_TICKS);
        self.ticks = self.ticks.wrapping_add(1);
        if self.client().is_some() {
            self.view.monitoring.local_note = None;
            self.call(
                "monitoring.list",
                None,
                |view: &mut AppView, items: Vec<LocalDto>| {
                    view.monitoring.local = items.into_iter().map(local_of).collect();
                },
                |_| {},
            );
        } else {
            self.view.monitoring.local.clear();
            self.view.monitoring.local_note = Some(OFFLINE_NOTE.to_owned());
        }
        if cloud_due {
            self.load_cloud();
        }
        self.refresh_errors_on(tick);
    }

    pub(crate) fn reload_cloud(&mut self) {
        self.load_cloud();
    }

    fn load_cloud(&mut self) {
        self.view.monitoring.loading = self.view.monitoring.cloud.is_empty();
        self.rest(
            CLOUD_MONITORS,
            |view: &mut AppView, dto: CloudListDto| {
                view.monitoring.loading = false;
                view.monitoring.cloud = dto.items.into_iter().map(cloud_of).collect();
            },
            |view| view.monitoring.loading = false,
        );
    }

    fn set_cloud_paused(&mut self, id: String, paused: bool) {
        let backend = self.deps_backend();
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        self.view.busy = true;
        tokio::spawn(async move {
            let path = format!("{CLOUD_MONITORS}/{id}");
            let outcome = backend
                .send_json("PATCH", &path, json!({ "paused": paused }))
                .await;
            let task = move |runner: &mut Runner| {
                runner.view.busy = false;
                match outcome {
                    Ok(_) => {
                        runner.view.notice =
                            Some(if paused { "Paused." } else { "Resumed." }.to_owned());
                        runner.load_cloud();
                    }
                    Err(BackendError::SignedOut) => runner.on_signed_out(),
                    Err(BackendError::Failed(message)) => runner.view.error = Some(message),
                }
            };
            let _ = done.send(Done::Run {
                attempt,
                task: Box::new(task),
            });
        });
    }

    pub(crate) fn refresh_pipelines(&mut self) {
        let Some(project) = self.view.selected_project.clone() else {
            return;
        };
        self.view.pipelines.loading = self.view.pipelines.status.is_none();
        self.call(
            "pipelines.status",
            Some(json!({ "projectId": project })),
            |view: &mut AppView, dto: StatusDto| {
                view.pipelines.loading = false;
                view.pipelines.status = Some(status_of(dto));
            },
            |view| view.pipelines.loading = false,
        );
        self.load_run();
    }

    fn load_run(&mut self) {
        let (Some(project), Some(run_id)) = (
            self.view.selected_project.clone(),
            self.view.pipelines.run.as_ref().map(|r| r.run_id),
        ) else {
            return;
        };
        self.call(
            "pipelines.run",
            Some(json!({ "projectId": project, "runId": run_id })),
            move |view: &mut AppView, dto: JobsDto| {
                if let Some(run) = view.pipelines.run.as_mut()
                    && run.run_id == run_id
                {
                    run.loading = false;
                    run.jobs = dto
                        .jobs
                        .into_iter()
                        .map(|j| {
                            let (state, label) = run_state(&j.status, j.conclusion.as_deref());
                            PipelineJobView {
                                id: j.id,
                                name: j.name,
                                state,
                                state_label: label.to_owned(),
                            }
                        })
                        .collect();
                }
            },
            |view| {
                if let Some(run) = view.pipelines.run.as_mut() {
                    run.loading = false;
                }
            },
        );
    }

    fn open_job(&mut self, job_id: i64) {
        let (Some(project), Some(run)) = (
            self.view.selected_project.clone(),
            self.view.pipelines.run.as_ref(),
        ) else {
            return;
        };
        let run_id = run.run_id;
        let name = run
            .jobs
            .iter()
            .find(|j| j.id == job_id)
            .map_or_else(String::new, |j| j.name.clone());
        self.view.pipelines.log = Some(JobLogView {
            job_id,
            name,
            loading: true,
            truncated: false,
            lines: Vec::new(),
        });
        self.call(
            "pipelines.jobLog",
            Some(json!({ "projectId": project, "runId": run_id, "jobId": job_id })),
            move |view: &mut AppView, dto: JobLogDto| {
                if let Some(log) = view.pipelines.log.as_mut()
                    && log.job_id == job_id
                {
                    log.loading = false;
                    log.truncated = dto.truncated;
                    log.lines = dto
                        .lines
                        .into_iter()
                        .map(|l| LogLineView {
                            text: l.text,
                            error: l.error,
                        })
                        .collect();
                }
            },
            |view| {
                if let Some(log) = view.pipelines.log.as_mut() {
                    log.loading = false;
                }
            },
        );
    }

    fn ask_to_dispatch(&mut self, name: &str, params: Value) {
        self.ask(
            asking(
                "Run this workflow?",
                format!("{name} starts on the default branch."),
                "Run",
            ),
            move |runner| runner.pipeline_op("pipelines.dispatch", params),
        );
    }

    fn submit_dispatch(&mut self, values: HashMap<String, String>) {
        let Some(form) = self.view.pipelines.dispatch_form.as_mut() else {
            return;
        };
        let missing = form.inputs.iter().find(|input| {
            input.required && values.get(&input.name).is_none_or(|v| v.trim().is_empty())
        });
        if let Some(missing) = missing {
            form.error = Some(format!("Fill in {}.", missing.name));
            return;
        }
        let workflow_id = form.workflow_id;
        let name = form.name.clone();
        self.view.pipelines.dispatch_form = None;
        let params = json!({ "workflowId": workflow_id, "inputs": values });
        self.ask_to_dispatch(&name, params);
    }

    fn pipeline_op(&mut self, method: &'static str, mut params: Value) {
        let Some(project) = self.view.selected_project.clone() else {
            return;
        };
        params["projectId"] = Value::String(project);
        self.op(method, Some(params), Self::refresh_pipelines);
    }
}

#[uniffi::export]
impl Engine {
    pub fn monitor_open(&self, id: String) {
        self.run(move |r| r.view.monitoring.open = Some(id));
    }

    pub fn monitor_close(&self) {
        self.run(|r| r.view.monitoring.open = None);
    }

    pub fn monitor_check(&self, id: String) {
        self.run(move |r| {
            r.op(
                "monitoring.check",
                Some(json!({ "id": id })),
                Runner::refresh_section,
            );
        });
    }

    pub fn monitor_set_paused(&self, id: String, source: MonitorSource, paused: bool) {
        self.run(move |r| match source {
            MonitorSource::Local => r.op(
                "monitoring.pause",
                Some(json!({ "id": id, "paused": paused })),
                Runner::refresh_section,
            ),
            MonitorSource::Cloud => r.set_cloud_paused(id, paused),
        });
    }

    pub fn pipelines_open_run(&self, run_id: i64) {
        self.run(move |r| {
            r.view.pipelines.run = Some(PipelineRunDetailView {
                run_id,
                loading: true,
                jobs: Vec::new(),
            });
            r.load_run();
        });
    }

    pub fn pipelines_close_run(&self) {
        self.run(|r| {
            r.view.pipelines.log = None;
            r.view.pipelines.run = None;
        });
    }

    pub fn pipelines_open_job(&self, job_id: i64) {
        self.run(move |r| r.open_job(job_id));
    }

    pub fn pipelines_close_job(&self) {
        self.run(|r| r.view.pipelines.log = None);
    }

    pub fn pipelines_dispatch(&self, workflow_id: i64) {
        self.run(move |r| {
            let workflow = r
                .view
                .pipelines
                .status
                .as_ref()
                .and_then(|s| s.workflows.iter().find(|w| w.id == workflow_id))
                .cloned();
            let Some(workflow) = workflow else {
                return;
            };
            if workflow.inputs.is_empty() {
                let params = json!({ "workflowId": workflow_id });
                r.ask_to_dispatch(&workflow.name, params);
            } else {
                r.view.pipelines.dispatch_form = Some(DispatchFormView {
                    workflow_id,
                    name: workflow.name,
                    inputs: workflow.inputs,
                    error: None,
                });
            }
        });
    }

    pub fn pipelines_submit_dispatch(&self, values: HashMap<String, String>) {
        self.run(move |r| r.submit_dispatch(values));
    }

    pub fn pipelines_close_dispatch(&self) {
        self.run(|r| r.view.pipelines.dispatch_form = None);
    }

    pub fn pipelines_cancel(&self, run_id: i64) {
        self.run(move |r| {
            r.ask(
                asking(
                    "Cancel this run?",
                    "It stops on GitHub and can't be resumed.".to_owned(),
                    "Cancel run",
                ),
                move |runner| {
                    runner.pipeline_op("pipelines.cancel", json!({ "runId": run_id }));
                },
            );
        });
    }
}
