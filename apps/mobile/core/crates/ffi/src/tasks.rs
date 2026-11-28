//! The plan and its tasks on the phone (E124). The files live on the computer; the phone reads the
//! views the computer builds, and every change goes back as a method the computer checks, writes
//! with its own writers and commits.

use crate::engine::{Done, Engine, Runner, Task};
use crate::ops::asking;
use crate::view::{
    TaskCheckView, TaskDetailView, TaskEditInput, TaskHandoffView, TaskJournalView,
    TaskMilestoneView, TaskMoveView, TaskRecordView, TaskRefView, TaskRowView, TaskRunView,
    TaskSectionView, TaskSplitView, TasksOverviewView,
};
use runova_rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_SPLIT: AtomicU64 = AtomicU64::new(1);

/// What the runner keeps between calls: the task open, and a planned split until it is added.
#[derive(Default)]
pub(crate) struct TasksState {
    proposal: Option<Value>,
    request: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RowDto {
    id: String,
    title: String,
    status: String,
    status_label: String,
    priority: Option<String>,
    size: Option<String>,
    milestone: Option<String>,
    due: Option<String>,
    #[serde(default)]
    checked: u32,
    #[serde(default)]
    total: u32,
}

#[derive(Deserialize)]
struct PlanDto {
    title: String,
    mode: String,
    goal: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountsDto {
    todo: u32,
    in_progress: u32,
    testing: u32,
    blocked: u32,
}

#[derive(Deserialize)]
struct MilestoneDto {
    id: String,
    title: String,
    status: String,
    target: Option<String>,
    done: u32,
    total: u32,
}

#[derive(Deserialize)]
struct RefDto {
    id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunDto {
    status: String,
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewDto {
    exists: bool,
    plan: Option<PlanDto>,
    done: u32,
    total: u32,
    counts: CountsDto,
    milestones: Vec<MilestoneDto>,
    needs_you: Vec<RowDto>,
    questions: Vec<RefDto>,
    workarounds: u32,
    risks: u32,
    run: Option<RunDto>,
}

#[derive(Deserialize)]
struct SectionDto {
    heading: String,
    text: String,
}

#[derive(Deserialize)]
struct CheckDto {
    text: String,
    checked: bool,
}

#[derive(Deserialize)]
struct HandoffDto {
    outcome: Option<String>,
    tests: Option<String>,
    leg: Option<u32>,
    sections: Vec<SectionDto>,
}

#[derive(Deserialize)]
struct JournalDto {
    heading: String,
    lines: Vec<String>,
}

#[derive(Deserialize)]
struct DetailDto {
    task: Option<RowDto>,
    attempt: Option<u32>,
    sections: Vec<SectionDto>,
    acceptance: Vec<CheckDto>,
    body: String,
    handoff: Option<HandoffDto>,
    journal: Vec<JournalDto>,
}

#[derive(Deserialize)]
struct DetailLineDto {
    label: String,
    value: String,
}

#[derive(Deserialize)]
struct RecordDto {
    id: String,
    title: String,
    status: String,
    statuses: Vec<String>,
    details: Vec<DetailLineDto>,
    sections: Vec<SectionDto>,
}

#[derive(Deserialize)]
struct EntryDto {
    id: String,
    title: String,
}

#[derive(Deserialize)]
struct SplitDto {
    ok: bool,
    error: Option<String>,
    summary: String,
    entries: Vec<EntryDto>,
    extras: Option<String>,
    proposal: Option<Value>,
}

const STATUSES: &[(&str, &str)] = &[
    ("todo", "To do"),
    ("in-progress", "In progress"),
    ("testing", "Testing"),
    ("done", "Done"),
    ("blocked", "Blocked"),
];

fn plural(count: u32, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn percent(done: u32, total: u32) -> u8 {
    if total == 0 {
        0
    } else {
        ((done as f64 / total as f64) * 100.0).round() as u8
    }
}

fn row(dto: RowDto) -> TaskRowView {
    let mut meta = Vec::new();
    if let Some(priority) = &dto.priority {
        meta.push(priority.to_uppercase());
    }
    if let Some(size) = &dto.size {
        meta.push(format!("Size {}", size.to_uppercase()));
    }
    if let Some(milestone) = &dto.milestone {
        meta.push(milestone.clone());
    }
    if let Some(due) = &dto.due {
        meta.push(format!("due {due}"));
    }
    if dto.total > 0 {
        meta.push(format!("{} of {} criteria", dto.checked, dto.total));
    }
    TaskRowView {
        id: dto.id,
        title: dto.title,
        status: dto.status,
        status_label: dto.status_label,
        meta: meta.join(" · "),
    }
}

fn counts_label(counts: &CountsDto) -> String {
    let parts: Vec<String> = [
        (counts.todo, "to do"),
        (counts.in_progress, "in progress"),
        (counts.testing, "testing"),
        (counts.blocked, "blocked"),
    ]
    .into_iter()
    .filter(|(count, _)| *count > 0)
    .map(|(count, word)| format!("{count} {word}"))
    .collect();
    if parts.is_empty() {
        "Nothing left to do".to_owned()
    } else {
        parts.join(", ")
    }
}

fn run_view(run: &RunDto) -> TaskRunView {
    let label = match (run.status.as_str(), &run.task_id) {
        ("running", Some(task)) => format!("Running {task}"),
        ("running", None) => "Running".to_owned(),
        ("paused", _) => "Paused".to_owned(),
        _ => "Waiting to start".to_owned(),
    };
    TaskRunView {
        label,
        can_pause: run.status == "running" || run.status == "waiting",
        can_resume: run.status == "paused",
    }
}

fn overview_view(dto: OverviewDto) -> TasksOverviewView {
    let records: Vec<String> = [
        (dto.workarounds, "open workaround"),
        (dto.risks, "open risk"),
    ]
    .into_iter()
    .filter(|(count, _)| *count > 0)
    .map(|(count, word)| plural(count, word))
    .collect();
    let left = dto.total.saturating_sub(dto.done);
    TasksOverviewView {
        exists: dto.exists,
        title: dto
            .plan
            .as_ref()
            .map_or_else(|| "Tasks".to_owned(), |plan| plan.title.clone()),
        mode_label: match dto.plan.as_ref().map(|plan| plan.mode.as_str()) {
            Some("plan") => "Plan mode, no context budget".to_owned(),
            Some(_) => "Sized to the context budget".to_owned(),
            None => "No plan written yet".to_owned(),
        },
        goal: dto.plan.and_then(|plan| plan.goal),
        progress_label: format!("{} of {} done", dto.done, plural(dto.total, "task")),
        percent: percent(dto.done, dto.total),
        counts_label: counts_label(&dto.counts),
        milestones: dto
            .milestones
            .into_iter()
            .map(|milestone| TaskMilestoneView {
                label: format!("{} of {} done", milestone.done, milestone.total),
                percent: percent(milestone.done, milestone.total),
                id: milestone.id,
                title: milestone.title,
                status: milestone.status,
                target: milestone.target,
            })
            .collect(),
        needs_you: dto.needs_you.into_iter().map(row).collect(),
        questions: dto
            .questions
            .into_iter()
            .map(|question| TaskRefView {
                id: question.id,
                title: question.title,
            })
            .collect(),
        records_label: (!records.is_empty()).then(|| records.join(", ")),
        can_start: dto.run.is_none() && left > 0,
        run: dto.run.as_ref().map(run_view),
    }
}

fn section(dto: SectionDto) -> TaskSectionView {
    TaskSectionView {
        heading: dto.heading,
        text: dto.text,
    }
}

fn handoff_heading(key: &str) -> String {
    match key {
        "purpose" => "Purpose",
        "done" => "Done so far",
        "decisions" => "Decisions",
        "tests" => "Tests run",
        "workarounds" => "Workarounds",
        "rejected" => "Tried and rejected",
        "questions" => "Open questions",
        "next" => "Next step",
        other => other,
    }
    .to_owned()
}

fn handoff_view(dto: HandoffDto) -> TaskHandoffView {
    let outcome = match dto.outcome.as_deref() {
        Some("done") => "Done",
        Some("continue") => "Carries on",
        Some("blocked") => "Blocked",
        _ => "Not finished",
    };
    let tests = match dto.tests.as_deref() {
        Some("passed") => "tests passed",
        Some("failed") => "tests fail",
        _ => "tests not run",
    };
    let leg = dto
        .leg
        .map(|n| format!(", session {n}"))
        .unwrap_or_default();
    TaskHandoffView {
        summary: format!("{outcome}, {tests}{leg}"),
        sections: dto
            .sections
            .into_iter()
            .map(|one| TaskSectionView {
                heading: handoff_heading(&one.heading),
                text: one.text,
            })
            .collect(),
    }
}

fn detail_view(dto: DetailDto) -> Option<TaskDetailView> {
    let task = dto.task?;
    let moves = STATUSES
        .iter()
        .filter(|(status, _)| *status != task.status)
        .map(|(status, label)| TaskMoveView {
            status: (*status).to_owned(),
            label: (*label).to_owned(),
        })
        .collect();
    Some(TaskDetailView {
        priority: task.priority.clone(),
        size: task.size.clone(),
        milestone: task.milestone.clone(),
        due: task.due.clone(),
        row: row(task),
        attempt_label: dto
            .attempt
            .filter(|n| *n > 1)
            .map(|n| format!("Attempt {n}")),
        sections: dto.sections.into_iter().map(section).collect(),
        acceptance: dto
            .acceptance
            .into_iter()
            .enumerate()
            .map(|(index, check)| TaskCheckView {
                index: index as u32,
                text: check.text,
                checked: check.checked,
            })
            .collect(),
        handoff: dto.handoff.map(handoff_view),
        journal: dto
            .journal
            .into_iter()
            .map(|entry| TaskJournalView {
                heading: entry.heading,
                lines: entry.lines,
            })
            .collect(),
        body: dto.body,
        moves,
    })
}

fn record_view(dto: RecordDto) -> TaskRecordView {
    TaskRecordView {
        id: dto.id,
        title: dto.title,
        status: dto.status,
        statuses: dto.statuses,
        details: dto
            .details
            .into_iter()
            .map(|line| TaskSectionView {
                heading: line.label,
                text: line.value,
            })
            .collect(),
        sections: dto.sections.into_iter().map(section).collect(),
    }
}

/// The first section of a new record of this kind, where a phone's one line of text goes.
fn first_section(kind: &str) -> &'static str {
    match kind {
        "milestone" => "Goal",
        "decision" => "Decision",
        "workaround" => "What we did",
        "risk" => "Risk",
        _ => "Question",
    }
}

impl Runner {
    pub(crate) fn refresh_tasks(&mut self) {
        let Some(project) = self.view.selected_project.clone() else {
            self.view.tasks = Default::default();
            return;
        };
        self.view.tasks.loading = self.view.tasks.overview.is_none();
        self.call(
            "tasks.overview",
            Some(json!({"projectId": project})),
            |view, dto: OverviewDto| {
                view.tasks.loading = false;
                view.tasks.overview = Some(overview_view(dto));
            },
            |view| view.tasks.loading = false,
        );
        self.call(
            "tasks.board",
            Some(json!({"projectId": project})),
            |view, rows: Vec<RowDto>| view.tasks.tasks = rows.into_iter().map(row).collect(),
            |_| {},
        );
        if let Some(task) = self.view.tasks.open_task.clone() {
            self.load_task(project.clone(), task);
        }
        if let Some(kind) = self.view.tasks.records_kind.clone() {
            self.load_task_records(project, kind);
        }
    }

    fn load_task(&mut self, project: String, task: String) {
        self.call(
            "tasks.detail",
            Some(json!({"projectId": project, "taskId": task})),
            move |view, dto: DetailDto| {
                let detail = detail_view(dto);
                let still_open = view.tasks.open_task.as_deref() == Some(task.as_str());
                if still_open && detail.as_ref().is_some_and(|one| one.row.id == task) {
                    view.tasks.detail = detail;
                }
            },
            |_| {},
        );
    }

    fn load_task_records(&mut self, project: String, kind: String) {
        self.call(
            "tasks.items",
            Some(json!({"projectId": project, "kind": kind})),
            move |view, records: Vec<RecordDto>| {
                if view.tasks.records_kind.as_deref() == Some(kind.as_str()) {
                    view.tasks.records = records.into_iter().map(record_view).collect();
                }
            },
            |_| {},
        );
    }

    /// Runs a change in the selected project, then reads the plan again.
    fn tasks_op(&mut self, method: &'static str, mut params: Value) {
        let Some(project) = self.view.selected_project.clone() else {
            self.view.error = Some("Choose a project first.".to_owned());
            return;
        };
        params["projectId"] = json!(project);
        self.op(method, Some(params), Runner::refresh_tasks);
    }

    fn split(&mut self, request: String, plan_only: bool) {
        let Some(project) = self.view.selected_project.clone() else {
            self.view.tasks.split.error = Some("Choose a project first.".to_owned());
            return;
        };
        let Some(client) = self.client() else {
            return;
        };
        let request_id = format!("phone-split-{}", NEXT_SPLIT.fetch_add(1, Ordering::Relaxed));
        self.tasks.request = Some(request_id.clone());
        self.tasks.proposal = None;
        self.view.tasks.split = TaskSplitView {
            running: true,
            plan_only,
            ..Default::default()
        };
        let params = json!({
            "projectId": project, "request": request, "requestId": request_id,
            "mode": if plan_only { "plan" } else { "fit" },
        });
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call("tasks.split", Some(params)).await;
            let task: Task = Box::new(move |runner| {
                if runner.tasks.request.as_deref() != Some(request_id.as_str()) {
                    return;
                }
                runner.tasks.request = None;
                runner.view.tasks.split.running = false;
                match outcome.map(serde_json::from_value::<SplitDto>) {
                    Ok(Ok(dto)) if dto.ok => {
                        runner.tasks.proposal = dto.proposal;
                        runner.view.tasks.split.summary = Some(dto.summary);
                        runner.view.tasks.split.entries = dto
                            .entries
                            .into_iter()
                            .map(|entry| format!("{} {}", entry.id, entry.title))
                            .collect();
                        runner.view.tasks.split.extras = dto.extras;
                    }
                    Ok(Ok(dto)) => runner.view.tasks.split.error = dto.error,
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => runner.view.tasks.split.error = Some(error.to_string()),
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        });
    }
}

#[uniffi::export]
impl Engine {
    /// Opens one task with its spec, criteria, handoff and journal.
    pub fn tasks_open_task(&self, task_id: String) {
        self.run(move |r| {
            let Some(project) = r.view.selected_project.clone() else {
                return;
            };
            r.view.tasks.open_task = Some(task_id.clone());
            r.load_task(project, task_id);
        });
    }

    pub fn tasks_close_task(&self) {
        self.run(|r| {
            r.view.tasks.open_task = None;
            r.view.tasks.detail = None;
        });
    }

    pub fn tasks_set_status(&self, task_id: String, status: String) {
        self.run(move |r| {
            r.tasks_op(
                "tasks.setStatus",
                json!({"taskId": task_id, "status": status}),
            )
        });
    }

    pub fn tasks_toggle(&self, task_id: String, index: u32, checked: bool) {
        self.run(move |r| {
            if let Some(detail) = r.view.tasks.detail.as_mut()
                && let Some(check) = detail.acceptance.iter_mut().find(|c| c.index == index)
            {
                check.checked = checked;
            }
            r.tasks_op(
                "tasks.toggleAcceptance",
                json!({"taskId": task_id, "index": index, "checked": checked}),
            );
        });
    }

    pub fn tasks_create(&self, title: String, priority: Option<String>) {
        self.run(move |r| {
            r.tasks_op(
                "tasks.create",
                json!({"title": title, "priority": priority}),
            )
        });
    }

    pub fn tasks_update(&self, task_id: String, edit: TaskEditInput) {
        self.run(move |r| {
            r.tasks_op(
                "tasks.update",
                json!({"taskId": task_id, "patch": {
                    "title": edit.title, "priority": edit.priority, "size": edit.size, "due": edit.due,
                }}),
            )
        });
    }

    pub fn tasks_save_body(&self, task_id: String, body: String) {
        self.run(move |r| r.tasks_op("tasks.saveBody", json!({"taskId": task_id, "body": body})));
    }

    /// Shows the records of one kind, or none.
    pub fn tasks_show_records(&self, kind: Option<String>) {
        self.run(move |r| {
            r.view.tasks.records.clear();
            r.view.tasks.records_kind = kind.clone();
            if let (Some(project), Some(kind)) = (r.view.selected_project.clone(), kind) {
                r.load_task_records(project, kind);
            }
        });
    }

    pub fn tasks_set_record_status(&self, kind: String, id: String, status: String) {
        self.run(move |r| {
            r.tasks_op(
                "tasks.saveItem",
                json!({"item": {"kind": kind, "id": id, "status": status}}),
            )
        });
    }

    /// Answers a question, which also marks it answered.
    pub fn tasks_answer_question(&self, id: String, answer: String) {
        self.run(move |r| {
            r.tasks_op(
                "tasks.saveItem",
                json!({"item": {"kind": "question", "id": id, "status": "answered",
                    "sections": {"Answer": answer}}}),
            )
        });
    }

    pub fn tasks_add_record(&self, kind: String, title: String, text: Option<String>) {
        self.run(move |r| {
            let mut sections = serde_json::Map::new();
            if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
                sections.insert(first_section(&kind).to_owned(), json!(text));
            }
            r.tasks_op(
                "tasks.saveItem",
                json!({"item": {"kind": kind, "title": title, "sections": sections}}),
            );
        });
    }

    pub fn tasks_redo(&self, task_id: String, agent: Option<String>, keep_learnings: bool) {
        self.run(move |r| {
            let detail = if keep_learnings {
                "Its handoff and journal are kept in the archive, and the new session reads what this one learned."
            } else {
                "Its handoff and journal are kept in the archive, and the new session starts from the spec alone."
            };
            r.ask(
                asking(&format!("Redo {task_id}?"), detail.to_owned(), "Redo"),
                move |runner| {
                    runner.tasks_op(
                        "tasks.redo",
                        json!({"taskIds": [task_id], "agent": agent,
                            "keepLearnings": keep_learnings, "start": true}),
                    );
                },
            );
        });
    }

    /// Asks the computer's planner to split a request into tasks, or into a specced plan.
    pub fn tasks_split(&self, request: String, plan_only: bool) {
        self.run(move |r| r.split(request, plan_only));
    }

    pub fn tasks_cancel_split(&self) {
        self.run(|r| {
            r.view.tasks.split.running = false;
            if let Some(request) = r.tasks.request.take() {
                r.call(
                    "tasks.cancelSplit",
                    Some(json!({"requestId": request})),
                    |_, _: Value| {},
                    |_| {},
                );
            }
        });
    }

    /// Writes the planned tasks to the board.
    pub fn tasks_add_split(&self) {
        self.run(|r| {
            let Some(proposal) = r.tasks.proposal.take() else {
                return;
            };
            let mode = if r.view.tasks.split.plan_only {
                "plan"
            } else {
                "fit"
            };
            r.view.tasks.split = TaskSplitView::default();
            r.tasks_op(
                "tasks.applyProposal",
                json!({"proposal": proposal, "mode": mode}),
            );
        });
    }

    pub fn tasks_discard_split(&self) {
        self.run(|r| {
            r.tasks.proposal = None;
            r.view.tasks.split = TaskSplitView::default();
        });
    }

    pub fn tasks_start(&self) {
        self.run(|r| {
            r.ask(
                asking(
                    "Run the tasks?",
                    "Agents start on your computer and work through every task that is not done, one after another.".to_owned(),
                    "Run",
                ),
                |runner| runner.tasks_op("tasks.start", json!({})),
            );
        });
    }

    pub fn tasks_pause(&self) {
        self.run(|r| r.tasks_op("tasks.pause", json!({})));
    }

    pub fn tasks_resume(&self) {
        self.run(|r| {
            r.ask(
                asking(
                    "Go on with the relay?",
                    "The next session starts on your computer.".to_owned(),
                    "Go on",
                ),
                |runner| runner.tasks_op("tasks.resume", json!({})),
            );
        });
    }
}
