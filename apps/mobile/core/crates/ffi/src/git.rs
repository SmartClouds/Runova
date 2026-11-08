//! A project's git, worked out on the computer. Everything here is about the chosen project.

use crate::engine::{Engine, Runner};
use crate::view::{
    AppView, ConfirmView, DiffLineKind, DiffLineView, GitBranchView, GitDiffView, GitFileView,
    GitGroup, GitScreen, GitStashView, GitStateView,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeDto {
    path: String,
    orig_path: Option<String>,
    #[serde(default)]
    status: String,
    conflict: Option<String>,
    additions: Option<u32>,
    deletions: Option<u32>,
    #[serde(default)]
    binary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateDto {
    #[serde(default)]
    is_repo: bool,
    branch: Option<String>,
    #[serde(default)]
    detached: bool,
    upstream: Option<String>,
    #[serde(default)]
    ahead: u32,
    #[serde(default)]
    behind: u32,
    #[serde(default)]
    has_remote: bool,
    operation: Option<String>,
    #[serde(default)]
    conflicts: Vec<ChangeDto>,
    #[serde(default)]
    staged: Vec<ChangeDto>,
    #[serde(default)]
    unstaged: Vec<ChangeDto>,
    #[serde(default)]
    untracked: Vec<ChangeDto>,
    #[serde(default)]
    untracked_truncated: bool,
}

#[derive(Deserialize)]
struct DiffLineDto {
    kind: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffDto {
    #[serde(default)]
    binary: bool,
    #[serde(default)]
    too_large: bool,
    #[serde(default)]
    lines: Vec<DiffLineDto>,
}

#[derive(Deserialize)]
struct BranchDto {
    name: String,
    #[serde(default)]
    current: bool,
    #[serde(default)]
    local: bool,
}

#[derive(Deserialize)]
struct StashDto {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default)]
    message: String,
}

fn file_of(group: GitGroup) -> impl Fn(ChangeDto) -> GitFileView {
    move |change| GitFileView {
        group,
        path: change.path,
        orig_path: change.orig_path,
        status: change.status,
        conflict: change.conflict,
        additions: change.additions,
        deletions: change.deletions,
        binary: change.binary,
    }
}

fn state_of(dto: StateDto) -> GitStateView {
    let files = dto
        .conflicts
        .into_iter()
        .map(file_of(GitGroup::Conflict))
        .chain(dto.staged.into_iter().map(file_of(GitGroup::Staged)))
        .chain(dto.unstaged.into_iter().map(file_of(GitGroup::Unstaged)))
        .chain(dto.untracked.into_iter().map(file_of(GitGroup::Untracked)))
        .collect();
    GitStateView {
        is_repo: dto.is_repo,
        branch: dto.branch,
        detached: dto.detached,
        upstream: dto.upstream,
        ahead: dto.ahead,
        behind: dto.behind,
        has_remote: dto.has_remote,
        operation: dto.operation,
        files,
        truncated: dto.untracked_truncated,
    }
}

fn line_of(dto: DiffLineDto) -> DiffLineView {
    DiffLineView {
        kind: match dto.kind.as_str() {
            "hunk" => DiffLineKind::Hunk,
            "add" => DiffLineKind::Added,
            "del" => DiffLineKind::Removed,
            _ => DiffLineKind::Context,
        },
        text: dto.text,
    }
}

fn side_name(group: GitGroup) -> Option<&'static str> {
    match group {
        GitGroup::Staged => Some("staged"),
        GitGroup::Unstaged => Some("unstaged"),
        GitGroup::Untracked => Some("untracked"),
        GitGroup::Conflict => None,
    }
}

impl Runner {
    fn chosen(&self) -> Option<String> {
        self.view.selected_project.clone()
    }

    pub(crate) fn select_project(&mut self, project_id: Option<String>) {
        if self.view.selected_project == project_id {
            return;
        }
        self.view.selected_project = project_id;
        self.view.git = GitScreen::default();
        self.refresh_section();
    }

    pub(crate) fn load_git(&mut self) {
        let Some(project) = self.chosen() else {
            return;
        };
        self.view.git.loading = self.view.git.state.is_none();
        let asked_for = project.clone();
        self.call(
            "git.state",
            Some(json!({ "projectId": project })),
            move |view: &mut AppView, dto: StateDto| {
                // A slow answer about a project that is no longer the chosen one is not shown.
                if view.selected_project.as_deref() == Some(asked_for.as_str()) {
                    view.git.state = Some(state_of(dto));
                    view.git.loading = false;
                }
            },
            |view| view.git.loading = false,
        );
    }

    fn after_git_change(&mut self) {
        self.load_git();
        if self.view.git.branches_open {
            self.load_branches();
        }
    }

    fn git_op(&mut self, method: &'static str, project: String, mut params: Value) {
        params["projectId"] = Value::String(project);
        self.op(method, Some(params), Self::after_git_change);
    }

    /// Runs a git change on the chosen project, or does nothing with no project chosen.
    fn on_project(&mut self, method: &'static str, params: Value) {
        if let Some(project) = self.chosen() {
            self.git_op(method, project, params);
        }
    }

    fn ask_then_git(&mut self, confirm: ConfirmView, method: &'static str, params: Value) {
        self.ask(confirm, move |runner| runner.on_project(method, params));
    }

    fn open_diff(&mut self, path: String, group: GitGroup) {
        let (Some(project), Some(side)) = (self.chosen(), side_name(group)) else {
            return;
        };
        let orig_path = self
            .view
            .git
            .state
            .as_ref()
            .and_then(|s| s.files.iter().find(|f| f.path == path && f.group == group))
            .and_then(|f| f.orig_path.clone());
        self.view.git.diff = Some(GitDiffView {
            path: path.clone(),
            group,
            loading: true,
            binary: false,
            too_large: false,
            lines: Vec::new(),
        });
        let mut params = json!({ "projectId": project, "path": path, "side": side });
        if let Some(orig_path) = orig_path {
            params["origPath"] = Value::String(orig_path);
        }
        let asked_for = path;
        self.call(
            "git.diff",
            Some(params),
            move |view: &mut AppView, dto: DiffDto| {
                if let Some(diff) = view.git.diff.as_mut()
                    && diff.path == asked_for
                {
                    diff.loading = false;
                    diff.binary = dto.binary;
                    diff.too_large = dto.too_large;
                    diff.lines = dto.lines.into_iter().map(line_of).collect();
                }
            },
            |view| {
                if let Some(diff) = view.git.diff.as_mut() {
                    diff.loading = false;
                }
            },
        );
    }

    fn load_branches(&mut self) {
        let Some(project) = self.chosen() else {
            return;
        };
        self.call(
            "git.branches",
            Some(json!({ "projectId": project })),
            |view: &mut AppView, items: Vec<BranchDto>| {
                view.git.branches = items
                    .into_iter()
                    .map(|b| GitBranchView {
                        name: b.name,
                        current: b.current,
                        local: b.local,
                    })
                    .collect();
            },
            |_| {},
        );
        self.call(
            "git.stashes",
            Some(json!({ "projectId": project })),
            |view: &mut AppView, items: Vec<StashDto>| {
                view.git.stashes = items
                    .into_iter()
                    .map(|s| GitStashView {
                        reference: s.reference,
                        message: s.message,
                    })
                    .collect();
            },
            |_| {},
        );
    }
}

fn danger(title: &str, detail: String, action: &str) -> ConfirmView {
    ConfirmView {
        title: title.to_owned(),
        detail,
        action: action.to_owned(),
        danger: true,
    }
}

#[uniffi::export]
impl Engine {
    pub fn load_git(&self) {
        self.run(Runner::load_git);
    }

    pub fn open_git_diff(&self, path: String, group: GitGroup) {
        self.run(move |r| r.open_diff(path, group));
    }

    pub fn close_git_diff(&self) {
        self.run(|r| r.view.git.diff = None);
    }

    pub fn open_git_branches(&self) {
        self.run(|r| {
            r.view.git.branches_open = true;
            r.load_branches();
        });
    }

    pub fn close_git_branches(&self) {
        self.run(|r| r.view.git.branches_open = false);
    }

    pub fn git_stage(&self, paths: Vec<String>) {
        self.run(move |r| r.on_project("git.stage", json!({ "paths": paths })));
    }

    pub fn git_unstage(&self, paths: Vec<String>) {
        self.run(move |r| r.on_project("git.unstage", json!({ "paths": paths })));
    }

    pub fn git_discard(&self, path: String, group: GitGroup) {
        let Some(side) = side_name(group).filter(|side| *side != "staged") else {
            return;
        };
        self.run(move |r| {
            let detail = if group == GitGroup::Untracked {
                format!("{path} will be deleted from this computer.")
            } else {
                format!("{path} goes back to how it was. You can't undo this from here.")
            };
            r.ask_then_git(
                danger("Discard these changes?", detail, "Discard"),
                "git.discard",
                json!({ "paths": [path], "side": side }),
            );
        });
    }

    pub fn git_commit(&self, message: String, push: bool) {
        self.run(move |r| {
            r.on_project("git.commit", json!({ "message": message, "push": push }));
        });
    }

    pub fn git_fetch(&self) {
        self.run(|r| r.on_project("git.fetch", json!({})));
    }

    pub fn git_pull(&self) {
        self.run(|r| r.on_project("git.pull", json!({})));
    }

    pub fn git_push(&self) {
        self.run(|r| r.on_project("git.push", json!({})));
    }

    pub fn git_checkout(&self, name: String) {
        self.run(move |r| r.on_project("git.checkout", json!({ "name": name })));
    }

    pub fn git_create_branch(&self, name: String) {
        self.run(move |r| r.on_project("git.createBranch", json!({ "name": name })));
    }

    pub fn git_delete_branch(&self, name: String) {
        self.run(move |r| {
            let detail = format!("{name} is deleted on this computer.");
            r.ask_then_git(
                danger("Delete this branch?", detail, "Delete"),
                "git.deleteBranch",
                json!({ "name": name }),
            );
        });
    }

    pub fn git_stash_push(&self, message: Option<String>) {
        self.run(move |r| {
            let params = message.map_or_else(|| json!({}), |m| json!({ "message": m }));
            r.on_project("git.stashPush", params);
        });
    }

    pub fn git_stash_pop(&self, reference: String) {
        self.run(move |r| r.on_project("git.stashPop", json!({ "ref": reference })));
    }

    pub fn git_stash_drop(&self, reference: String) {
        self.run(move |r| {
            r.ask_then_git(
                danger(
                    "Drop this stash?",
                    format!("{reference} is lost for good."),
                    "Drop",
                ),
                "git.stashDrop",
                json!({ "ref": reference }),
            );
        });
    }

    pub fn git_resolve(&self, path: String, pick: String) {
        self.run(move |r| r.on_project("git.resolve", json!({ "path": path, "pick": pick })));
    }

    pub fn git_abort(&self) {
        self.run(|r| {
            r.ask_then_git(
                danger(
                    "Stop this operation?",
                    "The repository goes back to how it was before it started.".to_owned(),
                    "Stop",
                ),
                "git.abort",
                json!({}),
            );
        });
    }
}
