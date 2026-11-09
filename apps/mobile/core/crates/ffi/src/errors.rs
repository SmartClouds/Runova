//! The issues a computer's Sentry connections report, read through that computer.

use crate::engine::{Engine, Runner};
use crate::labels::ago_label;
use crate::view::{
    AppView, ErrorDetailView, ErrorExceptionView, ErrorIssueView, ErrorLevel, ErrorStatus,
    ProjectView,
};
use serde::Deserialize;
use serde_json::{Value, json};

/// Sentry asks clients to poll lightly and the computer keeps a list for a minute anyway.
const ERRORS_EVERY_TICKS: u32 = 15;
const NO_COMPUTER: &str = "Connect to a computer to see its errors.";
const NOT_LINKED: &str = "No Sentry project is linked on this computer.";
const NOTHING_FOUND: &str = "No unresolved errors in the last 14 days.";
const CUT: &str = "Showing the 50 most recent.";
const NO_WRITE: &str = "The Sentry token on this computer can't change issues.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueDto {
    connection_id: String,
    id: String,
    #[serde(default)]
    short_id: String,
    title: String,
    #[serde(default)]
    culprit: String,
    level: String,
    status: String,
    #[serde(default)]
    count: u64,
    #[serde(default)]
    user_count: u64,
    #[serde(default)]
    is_new: bool,
    #[serde(default)]
    project_id: String,
    #[serde(default)]
    remote_project: String,
    last_seen_ago_ms: Option<i64>,
}

#[derive(Deserialize)]
struct ProblemDto {
    label: String,
    message: String,
}

#[derive(Deserialize)]
struct ListDto {
    #[serde(default)]
    linked: bool,
    #[serde(default)]
    issues: Vec<IssueDto>,
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    problems: Vec<ProblemDto>,
}

#[derive(Deserialize)]
struct FrameDto {
    file: String,
    function: Option<String>,
    line: Option<u32>,
}

#[derive(Deserialize)]
struct ExceptionDto {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    value: String,
    handled: Option<bool>,
    #[serde(default)]
    frames: Vec<FrameDto>,
}

#[derive(Deserialize)]
struct TagDto {
    key: String,
    value: String,
}

#[derive(Deserialize)]
struct EventDto {
    message: Option<String>,
    environment: Option<String>,
    release: Option<String>,
    request: Option<String>,
    #[serde(default)]
    exceptions: Vec<ExceptionDto>,
    #[serde(default)]
    tags: Vec<TagDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailDto {
    issue: IssueDto,
    #[serde(default)]
    can_change: bool,
    event: Option<EventDto>,
}

fn level_of(level: &str) -> (ErrorLevel, &'static str) {
    match level {
        "fatal" => (ErrorLevel::Fatal, "Fatal"),
        "warning" => (ErrorLevel::Warning, "Warning"),
        "info" => (ErrorLevel::Info, "Info"),
        "debug" => (ErrorLevel::Debug, "Debug"),
        _ => (ErrorLevel::Error, "Error"),
    }
}

fn status_of(status: &str) -> (ErrorStatus, &'static str) {
    match status {
        "resolved" => (ErrorStatus::Resolved, "Resolved"),
        "ignored" => (ErrorStatus::Ignored, "Ignored"),
        _ => (ErrorStatus::Unresolved, "Unresolved"),
    }
}

fn counted(count: u64, one: &str) -> String {
    let suffix = if count == 1 { "" } else { "s" };
    format!("{count} {one}{suffix}")
}

fn issue_of(dto: IssueDto, projects: &[ProjectView]) -> ErrorIssueView {
    let (level, level_label) = level_of(&dto.level);
    let (status, status_label) = status_of(&dto.status);
    let project = projects
        .iter()
        .find(|p| p.id == dto.project_id)
        .map_or(dto.remote_project, |p| p.name.clone());
    let seen = dto
        .last_seen_ago_ms
        .map_or_else(|| "unknown".to_owned(), ago_label);
    let counts = format!(
        "{}, {}",
        counted(dto.count, "event"),
        counted(dto.user_count, "user")
    );
    ErrorIssueView {
        detail_label: format!("{project}, {seen}, {counts}"),
        activity_label: format!("{counts}, {seen}"),
        connection_id: dto.connection_id,
        id: dto.id,
        short_id: dto.short_id,
        title: dto.title,
        culprit: Some(dto.culprit).filter(|culprit| !culprit.is_empty()),
        level,
        level_label: level_label.to_owned(),
        status,
        status_label: status_label.to_owned(),
        new_label: dto.is_new.then(|| "New".to_owned()),
    }
}

fn frame_of(frame: FrameDto) -> String {
    let place = match frame.line {
        Some(line) => format!("{}:{line}", frame.file),
        None => frame.file,
    };
    match frame.function {
        Some(function) => format!("{place} in {function}"),
        None => place,
    }
}

fn exception_of(dto: ExceptionDto) -> ErrorExceptionView {
    ErrorExceptionView {
        title: if dto.value.is_empty() {
            dto.kind
        } else {
            format!("{}: {}", dto.kind, dto.value)
        },
        unhandled: dto.handled == Some(false),
        frames: dto.frames.into_iter().map(frame_of).collect(),
    }
}

fn meta_of(event: &EventDto) -> Option<String> {
    let parts: Vec<String> = event
        .environment
        .clone()
        .into_iter()
        .chain(event.release.as_ref().map(|r| format!("release {r}")))
        .collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn apply_detail(detail: &mut ErrorDetailView, dto: DetailDto, projects: &[ProjectView]) {
    let issue = issue_of(dto.issue, projects);
    detail.loading = false;
    let unresolved = issue.status == ErrorStatus::Unresolved;
    detail.can_resolve = dto.can_change && unresolved;
    detail.can_reopen = dto.can_change && !unresolved;
    detail.write_note = (!dto.can_change).then(|| NO_WRITE.to_owned());
    detail.issue = Some(issue);
    match dto.event {
        Some(event) => {
            detail.meta_label = meta_of(&event);
            detail.message = event.message;
            detail.request = event.request;
            detail.exceptions = event.exceptions.into_iter().map(exception_of).collect();
            detail.tags = event
                .tags
                .into_iter()
                .map(|tag| format!("{}: {}", tag.key, tag.value))
                .collect();
        }
        None => {
            detail.meta_label = None;
            detail.message = None;
            detail.request = None;
            detail.exceptions.clear();
            detail.tags.clear();
        }
    }
}

fn apply_list(view: &mut AppView, dto: ListDto) {
    view.errors.loading = false;
    view.errors.issues = dto
        .issues
        .into_iter()
        .map(|issue| issue_of(issue, &view.projects))
        .collect();
    view.errors.problems = dto
        .problems
        .into_iter()
        .map(|p| format!("{}: {}", p.label, p.message))
        .collect();
    view.errors.cut_note = dto.truncated.then(|| CUT.to_owned());
    view.errors.note = if !dto.linked {
        Some(NOT_LINKED.to_owned())
    } else if view.errors.issues.is_empty() {
        Some(NOTHING_FOUND.to_owned())
    } else {
        None
    };
}

impl Runner {
    /// Called on every tick of the Monitoring screen, so only some of them ask.
    pub(crate) fn refresh_errors_on(&mut self, tick: u32) {
        if self.view.errors.open && tick.is_multiple_of(ERRORS_EVERY_TICKS) {
            self.load_errors();
        }
    }

    fn load_errors(&mut self) {
        if self.client().is_none() {
            self.view.errors.loading = false;
            self.view.errors.issues.clear();
            self.view.errors.problems.clear();
            self.view.errors.cut_note = None;
            self.view.errors.note = Some(NO_COMPUTER.to_owned());
            return;
        }
        self.view.errors.loading = self.view.errors.issues.is_empty();
        self.call(
            "errors.list",
            None,
            |view: &mut AppView, dto: ListDto| {
                if view.errors.open {
                    apply_list(view, dto);
                }
            },
            |view| view.errors.loading = false,
        );
    }

    fn open_issue_ref(&self) -> Option<(String, String)> {
        self.view
            .errors
            .detail
            .as_ref()
            .map(|d| (d.connection_id.clone(), d.issue_id.clone()))
    }

    fn load_issue(&mut self) {
        let Some((connection_id, issue_id)) = self.open_issue_ref() else {
            return;
        };
        let params = json!({ "connectionId": connection_id, "issueId": issue_id });
        self.call(
            "errors.show",
            Some(params),
            move |view: &mut AppView, dto: DetailDto| {
                if let Some(detail) = view.errors.detail.as_mut()
                    && detail.connection_id == connection_id
                    && detail.issue_id == issue_id
                {
                    apply_detail(detail, dto, &view.projects);
                }
            },
            |view| {
                if let Some(detail) = view.errors.detail.as_mut() {
                    detail.loading = false;
                }
            },
        );
    }

    fn reload_errors(&mut self) {
        self.load_errors();
        self.load_issue();
    }

    fn set_issue_status(&mut self, status: &'static str) {
        let Some((connection_id, issue_id)) = self.open_issue_ref() else {
            return;
        };
        let params: Value = json!({
            "connectionId": connection_id,
            "issueId": issue_id,
            "status": status,
        });
        self.op("errors.setStatus", Some(params), Self::reload_errors);
    }
}

#[uniffi::export]
impl Engine {
    pub fn errors_open(&self) {
        self.run(|r| {
            r.view.errors.open = true;
            r.load_errors();
        });
    }

    pub fn errors_close(&self) {
        self.run(|r| r.view.errors = Default::default());
    }

    pub fn errors_open_issue(&self, connection_id: String, issue_id: String) {
        self.run(move |r| {
            let issue = r
                .view
                .errors
                .issues
                .iter()
                .find(|i| i.connection_id == connection_id && i.id == issue_id)
                .cloned();
            r.view.errors.detail = Some(ErrorDetailView {
                connection_id,
                issue_id,
                loading: true,
                issue,
                meta_label: None,
                message: None,
                exceptions: Vec::new(),
                request: None,
                tags: Vec::new(),
                can_resolve: false,
                can_reopen: false,
                write_note: None,
            });
            r.load_issue();
        });
    }

    pub fn errors_close_issue(&self) {
        self.run(|r| r.view.errors.detail = None);
    }

    pub fn errors_resolve(&self) {
        self.run(|r| r.set_issue_status("resolved"));
    }

    pub fn errors_reopen(&self) {
        self.run(|r| r.set_issue_status("unresolved"));
    }
}
