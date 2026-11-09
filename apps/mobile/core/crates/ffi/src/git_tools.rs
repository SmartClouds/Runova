//! Tags and the AI helpers around git. The CLI runs on the computer; the phone shows its answer.

use crate::engine::{Done, Engine, Runner, Task};
use crate::ops::asking;
use crate::view::{GitAiKind, GitAiView, GitTagOptionView, GitTagSuggestionView, GitTagsView};
use runova_rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

fn request_id() -> String {
    format!("phone-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed))
}

#[derive(Deserialize)]
struct NextDto {
    patch: String,
    minor: String,
    major: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagsDto {
    latest: Option<String>,
    recent: Vec<String>,
    commits_since: u32,
    has_remote: bool,
    next: NextDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagSuggestionDto {
    ok: bool,
    tag: Option<String>,
    reason: Option<String>,
    message: Option<String>,
    cli_name: Option<String>,
    error: Option<String>,
    cancelled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDto {
    ok: bool,
    text: Option<String>,
    cli_name: Option<String>,
    error: Option<String>,
    cancelled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedDto {
    ok: bool,
    message: String,
    summary: Option<String>,
    cancelled: bool,
}

fn written_by(cli: Option<String>) -> Option<String> {
    cli.map(|name| format!("Written by {name} on this computer"))
}

fn commits_label(count: u32, latest: bool) -> String {
    let noun = if count == 1 { "commit" } else { "commits" };
    if latest {
        format!("{count} {noun} since this tag")
    } else {
        format!("{count} {noun}, no tags yet")
    }
}

impl Runner {
    fn git_project(&self) -> Option<String> {
        self.view.selected_project.clone()
    }

    fn git_call(
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

    fn load_tags(&mut self) {
        let Some(project) = self.git_project() else {
            return;
        };
        self.git_call(
            "git.tags",
            json!({"projectId": project}),
            |runner, outcome| {
                let Some(tags) = runner.view.git_tools.tags.as_mut() else {
                    return;
                };
                tags.loading = false;
                match outcome.map(serde_json::from_value::<TagsDto>) {
                    Ok(Ok(dto)) => {
                        tags.commits_label = commits_label(dto.commits_since, dto.latest.is_some());
                        tags.latest = dto.latest;
                        tags.recent = dto.recent;
                        tags.has_remote = dto.has_remote;
                        tags.options = vec![
                            GitTagOptionView {
                                kind: "Patch".to_owned(),
                                tag: dto.next.patch,
                            },
                            GitTagOptionView {
                                kind: "Minor".to_owned(),
                                tag: dto.next.minor,
                            },
                            GitTagOptionView {
                                kind: "Major".to_owned(),
                                tag: dto.next.major,
                            },
                        ];
                    }
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => tags.error = Some(error.to_string()),
                }
            },
        );
    }

    fn suggest_tag(&mut self) {
        let Some(project) = self.git_project() else {
            return;
        };
        let Some(tags) = self.view.git_tools.tags.as_mut() else {
            return;
        };
        let request = request_id();
        tags.suggesting = true;
        tags.error = None;
        tags.suggestion = None;
        self.ai_request = Some(request.clone());
        self.git_call(
            "git.suggestTag",
            json!({"projectId": project, "requestId": request}),
            |runner, outcome| {
                runner.ai_request = None;
                let Some(tags) = runner.view.git_tools.tags.as_mut() else {
                    return;
                };
                tags.suggesting = false;
                match outcome.map(serde_json::from_value::<TagSuggestionDto>) {
                    Ok(Ok(dto)) if dto.ok => {
                        tags.suggestion = dto.tag.map(|tag| GitTagSuggestionView {
                            tag,
                            reason: dto.reason,
                            message: dto.message.unwrap_or_default(),
                            note: written_by(dto.cli_name).unwrap_or_default(),
                        });
                    }
                    Ok(Ok(dto)) if dto.cancelled => {}
                    Ok(Ok(dto)) => tags.error = dto.error,
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => tags.error = Some(error.to_string()),
                }
            },
        );
    }

    fn suggest_text(&mut self, kind: GitAiKind, method: &'static str, params: Value) {
        let Some(project) = self.git_project() else {
            return;
        };
        let request = request_id();
        let mut params = params;
        params["projectId"] = Value::String(project);
        params["requestId"] = Value::String(request.clone());
        self.ai_request = Some(request);
        self.view.git_tools.ai = Some(GitAiView {
            kind,
            loading: true,
            text: None,
            note: None,
            error: None,
        });
        self.git_call(method, params, move |runner, outcome| {
            runner.ai_request = None;
            let parsed = outcome.map(serde_json::from_value::<TextDto>);
            runner.view.git_tools.ai = match parsed {
                Ok(Ok(dto)) if dto.ok => Some(GitAiView {
                    kind,
                    loading: false,
                    text: dto.text,
                    note: written_by(dto.cli_name),
                    error: None,
                }),
                Ok(Ok(dto)) if dto.cancelled => None,
                Ok(Ok(dto)) => Some(GitAiView {
                    kind,
                    loading: false,
                    text: None,
                    note: None,
                    error: dto.error,
                }),
                Ok(Err(_)) | Err(RpcError::Closed) => None,
                Err(error) => Some(GitAiView {
                    kind,
                    loading: false,
                    text: None,
                    note: None,
                    error: Some(error.to_string()),
                }),
            };
        });
    }

    fn resolve_with_ai(&mut self, path: String) {
        let Some(project) = self.git_project() else {
            return;
        };
        let request = request_id();
        self.ai_request = Some(request.clone());
        self.view.git_tools.resolving = Some(path.clone());
        self.view.error = None;
        self.git_call(
            "git.resolveWithAi",
            json!({"projectId": project, "path": path, "requestId": request}),
            |runner, outcome| {
                runner.ai_request = None;
                runner.view.git_tools.resolving = None;
                match outcome.map(serde_json::from_value::<ResolvedDto>) {
                    Ok(Ok(dto)) if dto.ok => {
                        runner.view.notice = Some(dto.summary.unwrap_or(dto.message))
                    }
                    Ok(Ok(dto)) if dto.cancelled => {}
                    Ok(Ok(dto)) => runner.view.error = Some(dto.message),
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => runner.view.error = Some(error.to_string()),
                }
                runner.load_git();
            },
        );
    }

    fn create_tag(&mut self, tag: String, message: String, push: bool) {
        let Some(project) = self.git_project() else {
            return;
        };
        self.op(
            "git.createTag",
            Some(json!({"projectId": project, "tag": tag, "message": message, "push": push})),
            |runner| {
                if runner.view.error.is_none() {
                    runner.view.git_tools.tags = None;
                }
                runner.load_git();
            },
        );
    }
}

#[uniffi::export]
impl Engine {
    pub fn git_open_tags(&self) {
        self.run(|r| {
            r.view.error = None;
            r.view.git_tools.tags = Some(GitTagsView {
                loading: true,
                latest: None,
                commits_label: String::new(),
                has_remote: false,
                recent: Vec::new(),
                options: Vec::new(),
                suggesting: false,
                suggestion: None,
                error: None,
            });
            r.load_tags();
        });
    }

    pub fn git_close_tags(&self) {
        self.run(|r| r.view.git_tools.tags = None);
    }

    pub fn git_suggest_tag(&self) {
        self.run(Runner::suggest_tag);
    }

    pub fn git_create_tag(&self, tag: String, message: String, push: bool) {
        self.run(move |r| {
            if push {
                r.ask(
                    asking(
                        "Push this tag?",
                        format!("{tag} and the current branch go to the remote. A tag can start a release."),
                        "Create and push",
                    ),
                    move |runner| runner.create_tag(tag, message, true),
                );
            } else {
                r.create_tag(tag, message, false);
            }
        });
    }

    pub fn git_suggest_commit_message(&self) {
        self.run(|r| {
            let staged = r.view.git.state.as_ref().is_some_and(|state| {
                state
                    .files
                    .iter()
                    .any(|file| file.group == crate::view::GitGroup::Staged)
            });
            r.suggest_text(
                GitAiKind::Commit,
                "git.suggestCommitMessage",
                json!({"scope": if staged { "staged" } else { "all" }}),
            );
        });
    }

    pub fn git_suggest_branch_name(&self) {
        self.run(|r| r.suggest_text(GitAiKind::Branch, "git.suggestBranchName", json!({})));
    }

    /// The field has taken the answer, so it isn't put back over what is typed next.
    pub fn git_ai_taken(&self) {
        self.run(|r| {
            if let Some(ai) = r.view.git_tools.ai.as_mut() {
                ai.text = None;
            }
        });
    }

    pub fn git_cancel_ai(&self) {
        self.run(|r| {
            r.view.git_tools.ai = None;
            if let Some(tags) = r.view.git_tools.tags.as_mut() {
                tags.suggesting = false;
            }
            if let Some(request) = r.ai_request.take() {
                r.git_call("git.cancelAi", json!({"requestId": request}), |_, _| {});
            }
        });
    }

    pub fn git_resolve_with_ai(&self, path: String) {
        self.run(move |r| {
            r.ask(
                asking(
                    "Fix this conflict with AI?",
                    format!("The AI CLI on this computer edits {path}. If it can't finish, the file goes back as it was."),
                    "Fix it",
                ),
                move |runner| runner.resolve_with_ai(path),
            );
        });
    }
}
