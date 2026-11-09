//! Agents the phone starts on the computer: pipeline fixes and the prompt builder. The work runs
//! there, and the phone follows it in the terminal it already knows how to show.

use crate::engine::{Done, Engine, Runner, Task};
use crate::labels::ago_label;
use crate::ops::asking;
use crate::view::{
    AutoFixSessionView, AutoFixTone, PipelineRunState, PromptHistoryView, PromptModelView,
    PromptOptionsView, PromptScheduledView, PromptTargetView, PromptTemplateView,
};
use runova_rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttemptDto {
    run_number: Option<u32>,
    next_run_number: Option<u32>,
    commit: Option<String>,
    outcome: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDto {
    id: String,
    workflow_id: i64,
    workflow_name: String,
    branch: String,
    phase: String,
    blocker: Option<String>,
    message: Option<String>,
    max_attempts: u32,
    agent_session: Option<String>,
    attempts: Vec<AttemptDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartedDto {
    session_id: String,
    title: String,
}

#[derive(Deserialize)]
struct ModelDto {
    value: String,
    label: String,
    tier: Option<String>,
    efforts: Vec<String>,
}

#[derive(Deserialize)]
struct TargetDto {
    id: String,
    name: String,
    models: Vec<ModelDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateDto {
    id: String,
    name: String,
    prompt_type: String,
    #[serde(rename = "targetAI")]
    target_ai: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryDto {
    id: String,
    raw_input: String,
    prompt_type: String,
    #[serde(rename = "targetAI")]
    target_ai: String,
    content: String,
    ago_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledDto {
    id: String,
    summary: String,
    runs_in_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionsDto {
    types: Vec<String>,
    targets: Vec<TargetDto>,
    default_target: Option<String>,
}

#[derive(Deserialize)]
struct GeneratedDto {
    ok: bool,
    text: String,
    error: Option<String>,
    cancelled: bool,
}

/// What a phone hands over to schedule a prompt.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PromptScheduleInput {
    pub raw_input: String,
    pub prompt_type: String,
    pub target: String,
    pub content: String,
    pub in_ms: i64,
    pub cli_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

fn with_pick(
    params: &mut Value,
    cli_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) {
    if cli_id.is_some() {
        params["cliId"] = json!(cli_id);
        params["model"] = json!(model);
        params["effort"] = json!(effort);
    }
}

fn when_label(in_ms: i64) -> String {
    let minutes = (in_ms.max(0) + 59_999) / 60_000;
    match minutes {
        0..=1 => "In a minute".to_owned(),
        2..=59 => format!("In {minutes} minutes"),
        60..=119 => "In 1 hour".to_owned(),
        120..=1439 => format!("In {} hours", minutes / 60),
        1440..=2879 => "In 1 day".to_owned(),
        _ => format!("In {} days", minutes / 1440),
    }
}

fn run_name(number: Option<u32>) -> String {
    number.map_or_else(|| "The run".to_owned(), |n| format!("Run #{n}"))
}

fn timeline(attempts: &[AttemptDto]) -> Vec<String> {
    let mut lines = Vec::new();
    for attempt in attempts {
        lines.push(format!("{} failed", run_name(attempt.run_number)));
        match attempt.outcome.as_str() {
            "fixing" => lines.push("The agent is working on it".to_owned()),
            "no-change" => lines.push("The agent changed nothing".to_owned()),
            "cancelled" => lines.push("Stopped".to_owned()),
            outcome => {
                if let Some(commit) = &attempt.commit {
                    lines.push(format!("Pushed {commit}"));
                }
                if outcome == "passed" {
                    lines.push(format!("{} passed", run_name(attempt.next_run_number)));
                }
            }
        }
    }
    lines
}

fn session_view(dto: SessionDto) -> AutoFixSessionView {
    let attempt = dto.attempts.len() as u32;
    let (phase_label, tone) = match dto.phase.as_str() {
        "watching" => ("Watching the run".to_owned(), AutoFixTone::Working),
        "fixing" => (
            format!("Fixing {attempt} of {}", dto.max_attempts),
            AutoFixTone::Working,
        ),
        "committing" => ("Committing the fix".to_owned(), AutoFixTone::Working),
        "waiting-run" => ("Waiting for the next run".to_owned(), AutoFixTone::Working),
        "attention" => ("Needs you".to_owned(), AutoFixTone::Attention),
        "succeeded" => ("Fixed".to_owned(), AutoFixTone::Done),
        "gave-up" => ("Gave up".to_owned(), AutoFixTone::Failed),
        _ => ("Stopped".to_owned(), AutoFixTone::Stopped),
    };
    let finished = matches!(dto.phase.as_str(), "succeeded" | "gave-up" | "stopped");
    AutoFixSessionView {
        timeline: timeline(&dto.attempts),
        can_stop: !finished,
        can_retry: dto.phase == "attention" && dto.blocker.as_deref() != Some("needs-input"),
        can_commit: dto.phase == "fixing",
        can_dismiss: finished,
        id: dto.id,
        workflow_id: dto.workflow_id,
        title: format!("{} on {}", dto.workflow_name, dto.branch),
        phase_label,
        tone,
        message: dto.message,
        agent_session: dto.agent_session,
    }
}

impl Runner {
    pub(crate) fn refresh_auto_fix(&mut self) {
        let Some(project) = self.view.selected_project.clone() else {
            return;
        };
        self.call(
            "autofix.list",
            Some(json!({"projectId": project})),
            |view, sessions: Vec<SessionDto>| {
                view.auto_fix = sessions.into_iter().map(session_view).collect();
            },
            |_| {},
        );
    }

    fn workflow_params(&self, workflow_id: i64) -> Option<(Value, bool)> {
        let project = self.view.selected_project.clone()?;
        let workflow = self
            .view
            .pipelines
            .status
            .as_ref()?
            .workflows
            .iter()
            .find(|one| one.id == workflow_id)?;
        let run = workflow.run.as_ref()?;
        let params = json!({
            "projectId": project, "workflowId": workflow.id, "workflowName": workflow.name,
            "branch": run.branch, "runId": run.id, "runNumber": run.number,
        });
        Some((params, run.state == PipelineRunState::Failed))
    }

    fn auto_fix_op(&mut self, method: &'static str, id: String) {
        self.op(method, Some(json!({"id": id})), Self::refresh_auto_fix);
    }

    /// Starts something that answers with a terminal, and opens it.
    fn start_agent(&mut self, method: &'static str, params: Value) {
        let Some(client) = self.client() else {
            return;
        };
        self.view.busy = true;
        self.view.error = None;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call(method, Some(params)).await;
            let task: Task = Box::new(move |runner| {
                runner.view.busy = false;
                match outcome.map(serde_json::from_value::<StartedDto>) {
                    Ok(Ok(started)) => {
                        runner.open_terminal(started.session_id);
                        if let Some(terminal) = runner.view.terminal.as_mut() {
                            terminal.title = started.title;
                        }
                    }
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => runner.view.error = Some(error.to_string()),
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        });
    }

    pub(crate) fn refresh_prompts(&mut self) {
        if self.view.prompts.options.is_some() {
            return;
        }
        self.call(
            "prompts.options",
            None,
            |view, dto: OptionsDto| {
                view.prompts.options = Some(PromptOptionsView {
                    types: dto.types,
                    targets: dto
                        .targets
                        .into_iter()
                        .map(|target| PromptTargetView {
                            id: target.id,
                            name: target.name,
                            models: target
                                .models
                                .into_iter()
                                .map(|model| PromptModelView {
                                    value: model.value,
                                    label: model.label,
                                    tier: model.tier,
                                    efforts: model.efforts,
                                })
                                .collect(),
                        })
                        .collect(),
                    default_target: dto.default_target,
                });
            },
            |_| {},
        );
    }

    fn load_prompt_library(&mut self, query: Option<String>) {
        self.call(
            "prompts.templates",
            None,
            |view, templates: Vec<TemplateDto>| {
                view.prompts.templates = templates
                    .into_iter()
                    .map(|one| PromptTemplateView {
                        id: one.id,
                        name: one.name,
                        prompt_type: one.prompt_type,
                        target_ai: one.target_ai,
                        content: one.content,
                    })
                    .collect();
            },
            |_| {},
        );
        self.call(
            "prompts.history",
            Some(json!({"query": query})),
            |view, entries: Vec<HistoryDto>| {
                view.prompts.history = entries
                    .into_iter()
                    .map(|one| PromptHistoryView {
                        meta: format!(
                            "{}, for {}, {}",
                            one.prompt_type,
                            one.target_ai,
                            ago_label(one.ago_ms)
                        ),
                        id: one.id,
                        raw_input: one.raw_input,
                        prompt_type: one.prompt_type,
                        target_ai: one.target_ai,
                        content: one.content,
                    })
                    .collect();
            },
            |_| {},
        );
        self.load_scheduled();
    }

    fn load_scheduled(&mut self) {
        let Some(project) = self.view.selected_project.clone() else {
            self.view.prompts.scheduled.clear();
            return;
        };
        self.call(
            "prompts.scheduled",
            Some(json!({"projectId": project})),
            |view, tasks: Vec<ScheduledDto>| {
                view.prompts.scheduled = tasks
                    .into_iter()
                    .map(|one| PromptScheduledView {
                        when_label: when_label(one.runs_in_ms),
                        id: one.id,
                        summary: one.summary,
                    })
                    .collect();
            },
            |_| {},
        );
    }

    fn after_library_change(&mut self) {
        self.load_prompt_library(None);
    }

    fn generate_prompt(&mut self, raw_input: String, prompt_type: String, target: String) {
        let Some(client) = self.client() else {
            return;
        };
        let request = format!(
            "phone-prompt-{}",
            NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)
        );
        self.view.prompts.generating = true;
        self.view.prompts.error = None;
        self.view.prompts.result = None;
        self.ai_request = Some(request.clone());
        let params = json!({
            "rawInput": raw_input, "promptType": prompt_type, "targetAI": target, "requestId": request,
            "projectId": self.view.selected_project,
        });
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call("prompts.generate", Some(params)).await;
            let task: Task = Box::new(move |runner| {
                runner.ai_request = None;
                runner.view.prompts.generating = false;
                match outcome.map(serde_json::from_value::<GeneratedDto>) {
                    Ok(Ok(dto)) if dto.ok => runner.view.prompts.result = Some(dto.text),
                    Ok(Ok(dto)) if dto.cancelled => {}
                    Ok(Ok(dto)) => runner.view.prompts.error = dto.error,
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => runner.view.prompts.error = Some(error.to_string()),
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        });
    }
}

#[uniffi::export]
impl Engine {
    /// The phone's sheet has already said what this does and taken the choice of agent.
    pub fn auto_fix_start(
        &self,
        workflow_id: i64,
        cli_id: Option<String>,
        model: Option<String>,
        effort: Option<String>,
    ) {
        self.run(move |r| {
            let Some((mut params, _)) = r.workflow_params(workflow_id) else {
                return;
            };
            with_pick(&mut params, cli_id, model, effort);
            r.op("autofix.start", Some(params), Runner::refresh_auto_fix);
        });
    }

    pub fn auto_fix_stop(&self, id: String) {
        self.run(move |r| r.auto_fix_op("autofix.stop", id));
    }

    pub fn auto_fix_dismiss(&self, id: String) {
        self.run(move |r| r.auto_fix_op("autofix.dismiss", id));
    }

    pub fn auto_fix_retry(&self, id: String) {
        self.run(move |r| {
            r.ask(
                asking(
                    "Try again?",
                    "Another agent run starts on this computer.".to_owned(),
                    "Try again",
                ),
                move |runner| runner.auto_fix_op("autofix.retry", id),
            );
        });
    }

    pub fn auto_fix_commit(&self, id: String) {
        self.run(move |r| {
            r.ask(
                asking(
                    "Commit the fix now?",
                    "What the agent changed so far is committed and pushed.".to_owned(),
                    "Commit",
                ),
                move |runner| runner.auto_fix_op("autofix.commitNow", id),
            );
        });
    }

    /// The phone's sheet has already said what this does and taken the choice of agent.
    pub fn pipelines_fix_with_ai(
        &self,
        workflow_id: i64,
        cli_id: Option<String>,
        model: Option<String>,
        effort: Option<String>,
    ) {
        self.run(move |r| {
            let Some((mut params, true)) = r.workflow_params(workflow_id) else {
                return;
            };
            with_pick(&mut params, cli_id, model, effort);
            r.start_agent("agents.fixRun", params);
        });
    }

    pub fn prompts_generate(&self, raw_input: String, prompt_type: String, target: String) {
        self.run(move |r| r.generate_prompt(raw_input, prompt_type, target));
    }

    pub fn prompts_cancel(&self) {
        self.run(|r| {
            r.view.prompts.generating = false;
            if let Some(request) = r.ai_request.take() {
                r.call(
                    "prompts.cancel",
                    Some(json!({"requestId": request})),
                    |_, _: Value| {},
                    |_| {},
                );
            }
        });
    }

    /// The field has taken the prompt, so it isn't put back over what is typed next.
    pub fn prompts_taken(&self) {
        self.run(|r| r.view.prompts.result = None);
    }

    pub fn prompts_load_library(&self, query: Option<String>) {
        self.run(move |r| r.load_prompt_library(query));
    }

    pub fn prompts_save_template(
        &self,
        name: String,
        prompt_type: String,
        target: String,
        content: String,
    ) {
        self.run(move |r| {
            r.op(
                "prompts.saveTemplate",
                Some(json!({"name": name, "promptType": prompt_type, "targetAI": target, "content": content})),
                Runner::after_library_change,
            );
        });
    }

    pub fn prompts_delete_template(&self, id: String) {
        self.run(move |r| {
            r.ask(
                asking(
                    "Delete this template?",
                    "It goes from this computer too.".to_owned(),
                    "Delete",
                ),
                move |runner| {
                    runner.op(
                        "prompts.deleteTemplate",
                        Some(json!({"id": id})),
                        Runner::after_library_change,
                    );
                },
            );
        });
    }

    pub fn prompts_schedule(&self, task: PromptScheduleInput) {
        self.run(move |r| {
            let Some(project) = r.view.selected_project.clone() else {
                r.view.prompts.error = Some("Choose a project first.".to_owned());
                return;
            };
            r.ask(
                asking(
                    "Schedule this prompt?",
                    format!(
                        "An agent starts in this project on your computer {}, as long as Runova is running there.",
                        when_label(task.in_ms).to_lowercase(),
                    ),
                    "Schedule",
                ),
                move |runner| {
                    let mut params = json!({
                        "projectId": project, "rawInput": task.raw_input, "promptType": task.prompt_type,
                        "targetAI": task.target, "content": task.content, "inMs": task.in_ms,
                    });
                    with_pick(&mut params, task.cli_id, task.model, task.effort);
                    runner.op("prompts.schedule", Some(params), Runner::after_library_change);
                },
            );
        });
    }

    pub fn prompts_cancel_scheduled(&self, id: String) {
        self.run(move |r| {
            r.op(
                "prompts.cancelScheduled",
                Some(json!({"id": id})),
                Runner::after_library_change,
            );
        });
    }

    pub fn prompts_send(
        &self,
        prompt: String,
        cli_id: Option<String>,
        model: Option<String>,
        effort: Option<String>,
    ) {
        self.run(move |r| {
            let Some(project) = r.view.selected_project.clone() else {
                r.view.prompts.error = Some("Choose a project first.".to_owned());
                return;
            };
            r.ask(
                asking(
                    "Send this to an agent?",
                    "An agent starts in this project on your computer with this prompt. You can follow it here.".to_owned(),
                    "Send",
                ),
                move |runner| {
                    runner.start_agent(
                        "agents.runPrompt",
                        json!({"projectId": project, "prompt": prompt, "cliId": cli_id, "model": model, "effort": effort}),
                    );
                },
            );
        });
    }
}
