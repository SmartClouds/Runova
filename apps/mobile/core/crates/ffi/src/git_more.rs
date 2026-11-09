//! Pull requests and updating the version in files. The CLI and `gh` run on the computer.

use crate::engine::{Done, Engine, Runner, Task};
use crate::ops::asking;
use crate::view::{
    GitPrInfoView, GitPrSuggestionView, GitPrView, GitVersionFileView, GitVersionState,
    GitVersionView,
};
use runova_rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

fn request_id() -> String {
    format!("phone-git-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrDto {
    number: u32,
    title: String,
    url: String,
    state: String,
    is_draft: bool,
    review: Option<String>,
    additions: u32,
    deletions: u32,
    checks_total: u32,
    checks_failed: u32,
    checks_running: u32,
    unresolved: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusDto {
    cli_available: bool,
    authenticated: bool,
    repo: Option<String>,
    branch: Option<String>,
    default_branch: Option<String>,
    on_default_branch: bool,
    ahead: u32,
    dirty: bool,
    pr: Option<PrDto>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDto {
    ok: bool,
    title: Option<String>,
    body: Option<String>,
    text: Option<String>,
    cli_name: Option<String>,
    error: Option<String>,
    cancelled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedDto {
    ok: bool,
    url: Option<String>,
    error: Option<String>,
    used_fallback: bool,
}

#[derive(Deserialize)]
struct FileDto {
    path: String,
    kind: String,
    additions: u32,
    deletions: u32,
    kept: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunDto {
    status: String,
    lines: Vec<String>,
    changes: Vec<FileDto>,
    warning: Option<String>,
    error: Option<String>,
    committed_by_cli: bool,
}

fn checks_label(dto: &PrDto) -> String {
    if dto.checks_total == 0 {
        "No checks".to_owned()
    } else if dto.checks_failed > 0 {
        format!(
            "{} of {} checks failed",
            dto.checks_failed, dto.checks_total
        )
    } else if dto.checks_running > 0 {
        format!("{} checks running", dto.checks_running)
    } else {
        format!("{} checks passed", dto.checks_total)
    }
}

fn pr_info(dto: PrDto) -> GitPrInfoView {
    let state_label = if dto.is_draft {
        "Draft".to_owned()
    } else {
        match dto.state.as_str() {
            "MERGED" => "Merged".to_owned(),
            "CLOSED" => "Closed".to_owned(),
            _ => "Open".to_owned(),
        }
    };
    let review_label = match dto.review.as_deref() {
        Some("APPROVED") => Some("Approved".to_owned()),
        Some("CHANGES_REQUESTED") => Some("Changes requested".to_owned()),
        Some("REVIEW_REQUIRED") => Some("Review needed".to_owned()),
        _ => None,
    };
    GitPrInfoView {
        meta: format!(
            "+{} -{}, {}",
            dto.additions,
            dto.deletions,
            checks_label(&dto)
        ),
        unresolved_label: (dto.unresolved > 0).then(|| {
            format!(
                "{} open review {}",
                dto.unresolved,
                if dto.unresolved == 1 {
                    "thread"
                } else {
                    "threads"
                }
            )
        }),
        checks_failed: dto.checks_failed > 0,
        number: dto.number,
        title: dto.title,
        url: dto.url,
        state_label,
        review_label,
    }
}

fn apply_status(view: &mut GitPrView, dto: StatusDto) {
    view.loading = false;
    let can_read = dto.cli_available && dto.authenticated && dto.repo.is_some();
    view.note = if !dto.cli_available {
        Some("The GitHub CLI isn't installed on this computer.".to_owned())
    } else if !dto.authenticated {
        Some("The GitHub CLI isn't signed in on this computer.".to_owned())
    } else if dto.repo.is_none() {
        Some("This project isn't on GitHub.".to_owned())
    } else if dto.on_default_branch {
        Some("Switch to a branch to open a pull request.".to_owned())
    } else {
        dto.error
    };
    view.branch_label = dto.branch.unwrap_or_else(|| "Detached".to_owned());
    view.base = dto.default_branch.unwrap_or_else(|| "main".to_owned());
    view.ahead_label = format!(
        "{} {} to send",
        dto.ahead,
        if dto.ahead == 1 { "commit" } else { "commits" }
    );
    view.dirty = dto.dirty;
    view.can_create = can_read && !dto.on_default_branch && dto.pr.is_none();
    view.pr = dto.pr.map(pr_info);
}

fn written_by(cli: Option<String>) -> String {
    cli.map_or_else(String::new, |name| {
        format!("Written by {name} on this computer")
    })
}

impl Runner {
    fn more_call(
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

    fn load_pr(&mut self) {
        let Some(project) = self.view.selected_project.clone() else {
            return;
        };
        self.more_call(
            "git.pr",
            json!({"projectId": project}),
            |runner, outcome| {
                let Some(pr) = runner.view.git_more.pr.as_mut() else {
                    return;
                };
                match outcome.map(serde_json::from_value::<StatusDto>) {
                    Ok(Ok(dto)) => apply_status(pr, dto),
                    Ok(Err(_)) | Err(RpcError::Closed) => pr.loading = false,
                    Err(error) => {
                        pr.loading = false;
                        pr.error = Some(error.to_string());
                    }
                }
            },
        );
    }

    fn create_pr(&mut self, title: String, body: String, draft: bool) {
        let (Some(project), Some(base)) = (
            self.view.selected_project.clone(),
            self.view.git_more.pr.as_ref().map(|pr| pr.base.clone()),
        ) else {
            return;
        };
        self.view.busy = true;
        self.more_call(
            "git.createPr",
            json!({"projectId": project, "title": title, "body": body, "base": base, "draft": draft}),
            |runner, outcome| {
                runner.view.busy = false;
                let Some(pr) = runner.view.git_more.pr.as_mut() else {
                    return;
                };
                match outcome.map(serde_json::from_value::<CreatedDto>) {
                    Ok(Ok(dto)) if dto.ok && dto.used_fallback => {
                        pr.fallback_url = dto.url;
                    }
                    Ok(Ok(dto)) if dto.ok => runner.load_pr(),
                    Ok(Ok(dto)) => pr.error = dto.error,
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => pr.error = Some(error.to_string()),
                }
            },
        );
    }

    pub(crate) fn refresh_version_run(&mut self) {
        let Some(version) = self.view.git_more.version.as_ref() else {
            return;
        };
        if version.state != GitVersionState::Running {
            return;
        }
        let request = version.request_id.clone();
        self.load_version_run(request);
    }

    fn load_version_run(&mut self, request: String) {
        self.more_call(
            "git.versionRun",
            json!({"requestId": request}),
            |runner, outcome| {
                let Some(version) = runner.view.git_more.version.as_mut() else {
                    return;
                };
                let Ok(Ok(dto)) = outcome.map(serde_json::from_value::<RunDto>) else {
                    return;
                };
                version.state = match dto.status.as_str() {
                    "running" => GitVersionState::Running,
                    "failed" => GitVersionState::Failed,
                    "cancelled" => GitVersionState::Stopped,
                    _ => GitVersionState::Done,
                };
                version.lines = dto.lines;
                version.warning = dto.warning;
                version.error = dto.error;
                version.committed = dto.committed_by_cli;
                version.files = dto
                    .changes
                    .into_iter()
                    .map(|file| GitVersionFileView {
                        detail: format!("{}, +{} -{}", file.kind, file.additions, file.deletions),
                        path: file.path,
                        kept: file.kept,
                    })
                    .collect();
            },
        );
    }
}

#[uniffi::export]
impl Engine {
    pub fn git_open_pr(&self) {
        self.run(|r| {
            r.view.error = None;
            r.view.git_more.pr = Some(GitPrView {
                loading: true,
                branch_label: String::new(),
                base: String::new(),
                ahead_label: String::new(),
                dirty: false,
                can_create: false,
                note: None,
                pr: None,
                suggesting: false,
                suggestion: None,
                reviewing: false,
                review: None,
                review_note: None,
                fallback_url: None,
                error: None,
            });
            r.load_pr();
        });
    }

    pub fn git_close_pr(&self) {
        self.run(|r| r.view.git_more.pr = None);
    }

    pub fn git_suggest_pr(&self) {
        self.run(|r| {
            let (Some(project), Some(base)) = (
                r.view.selected_project.clone(),
                r.view.git_more.pr.as_ref().map(|pr| pr.base.clone()),
            ) else {
                return;
            };
            let request = request_id();
            r.ai_request = Some(request.clone());
            if let Some(pr) = r.view.git_more.pr.as_mut() {
                pr.suggesting = true;
                pr.error = None;
            }
            r.more_call(
                "git.suggestPrText",
                json!({"projectId": project, "requestId": request, "base": base}),
                |runner, outcome| {
                    runner.ai_request = None;
                    let Some(pr) = runner.view.git_more.pr.as_mut() else {
                        return;
                    };
                    pr.suggesting = false;
                    match outcome.map(serde_json::from_value::<TextDto>) {
                        Ok(Ok(dto)) if dto.ok => {
                            pr.suggestion = Some(GitPrSuggestionView {
                                title: dto.title.unwrap_or_default(),
                                body: dto.body.unwrap_or_default(),
                                note: written_by(dto.cli_name),
                            });
                        }
                        Ok(Ok(dto)) if dto.cancelled => {}
                        Ok(Ok(dto)) => pr.error = dto.error,
                        Ok(Err(_)) | Err(RpcError::Closed) => {}
                        Err(error) => pr.error = Some(error.to_string()),
                    }
                },
            );
        });
    }

    pub fn git_pr_suggestion_taken(&self) {
        self.run(|r| {
            if let Some(pr) = r.view.git_more.pr.as_mut() {
                pr.suggestion = None;
            }
        });
    }

    pub fn git_create_pr(&self, title: String, body: String, draft: bool) {
        self.run(move |r| {
            r.ask(
                asking(
                    "Open this pull request?",
                    "The current branch is pushed first, then the pull request opens on GitHub."
                        .to_owned(),
                    "Open it",
                ),
                move |runner| runner.create_pr(title, body, draft),
            );
        });
    }

    pub fn git_review_pr(&self) {
        self.run(|r| {
            let Some(project) = r.view.selected_project.clone() else {
                return;
            };
            let request = request_id();
            r.ai_request = Some(request.clone());
            if let Some(pr) = r.view.git_more.pr.as_mut() {
                pr.reviewing = true;
                pr.error = None;
            }
            r.more_call(
                "git.reviewPr",
                json!({"projectId": project, "requestId": request}),
                |runner, outcome| {
                    runner.ai_request = None;
                    let Some(pr) = runner.view.git_more.pr.as_mut() else {
                        return;
                    };
                    pr.reviewing = false;
                    match outcome.map(serde_json::from_value::<TextDto>) {
                        Ok(Ok(dto)) if dto.ok => {
                            pr.review = dto.text;
                            pr.review_note = Some(written_by(dto.cli_name));
                        }
                        Ok(Ok(dto)) if dto.cancelled => {}
                        Ok(Ok(dto)) => pr.error = dto.error,
                        Ok(Err(_)) | Err(RpcError::Closed) => {}
                        Err(error) => pr.error = Some(error.to_string()),
                    }
                },
            );
        });
    }

    pub fn git_pr_review_taken(&self) {
        self.run(|r| {
            if let Some(pr) = r.view.git_more.pr.as_mut() {
                pr.review = None;
            }
        });
    }

    pub fn git_post_review(&self, body: String) {
        self.run(move |r| {
            let (Some(project), Some(number)) = (
                r.view.selected_project.clone(),
                r.view
                    .git_more
                    .pr
                    .as_ref()
                    .and_then(|pr| pr.pr.as_ref())
                    .map(|info| info.number),
            ) else {
                return;
            };
            r.ask(
                asking(
                    "Post this review?",
                    format!("It goes on pull request #{number} as a comment everyone can see."),
                    "Post",
                ),
                move |runner| {
                    runner.op(
                        "git.prComment",
                        Some(json!({"projectId": project, "number": number, "body": body})),
                        Runner::load_pr,
                    );
                },
            );
        });
    }

    pub fn git_cancel_pr_ai(&self) {
        self.run(|r| {
            if let Some(pr) = r.view.git_more.pr.as_mut() {
                pr.suggesting = false;
                pr.reviewing = false;
            }
            if let Some(request) = r.ai_request.take() {
                r.more_call("git.cancelAi", json!({"requestId": request}), |_, _| {});
            }
        });
    }

    pub fn git_apply_version(&self, tag: String) {
        self.run(move |r| {
            let Some(project) = r.view.selected_project.clone() else {
                return;
            };
            r.ask(
                asking(
                    "Update the version in files?",
                    format!("The AI CLI on this computer finds where the version is written and changes it to {tag}. You can undo any file afterwards."),
                    "Update",
                ),
                move |runner| {
                    let request = request_id();
                    runner.view.git_more.version = Some(GitVersionView {
                        request_id: request.clone(),
                        tag: tag.clone(),
                        state: GitVersionState::Running,
                        lines: Vec::new(),
                        files: Vec::new(),
                        warning: None,
                        error: None,
                        committed: false,
                    });
                    runner.more_call(
                        "git.applyVersion",
                        json!({"projectId": project, "tag": tag, "requestId": request}),
                        move |runner, outcome| {
                            if let Err(error) = outcome
                                && let Some(version) = runner.view.git_more.version.as_mut()
                            {
                                version.state = GitVersionState::Failed;
                                version.error = Some(error.to_string());
                            }
                        },
                    );
                },
            );
        });
    }

    pub fn git_cancel_version(&self) {
        self.run(|r| {
            if let Some(request) = r
                .view
                .git_more
                .version
                .as_ref()
                .map(|one| one.request_id.clone())
            {
                r.more_call(
                    "git.cancelVersion",
                    json!({"requestId": request}),
                    |_, _| {},
                );
            }
        });
    }

    /// Puts a file back as it was, or brings the run's edit back.
    pub fn git_version_toggle(&self, path: String) {
        self.run(move |r| {
            let (Some(project), Some(request)) = (
                r.view.selected_project.clone(),
                r.view
                    .git_more
                    .version
                    .as_ref()
                    .map(|one| one.request_id.clone()),
            ) else {
                return;
            };
            let refresh = request.clone();
            r.more_call(
                "git.versionToggle",
                json!({"projectId": project, "requestId": request, "path": path}),
                move |runner, outcome| {
                    if let Err(error) = outcome {
                        if !matches!(error, RpcError::Closed) {
                            runner.view.error = Some(error.to_string());
                        }
                        return;
                    }
                    runner.load_version_run(refresh);
                },
            );
        });
    }

    pub fn git_close_version(&self) {
        self.run(|r| r.view.git_more.version = None);
    }
}
