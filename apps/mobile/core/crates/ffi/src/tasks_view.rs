//! What the phone's Tasks screens draw (E124): the plan at a glance, the tasks, one task, the
//! records, and a split into tasks. Every label is written here, so the screens only lay it out.

/// The Tasks section.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct TasksScreen {
    pub overview: Option<TasksOverviewView>,
    pub tasks: Vec<TaskRowView>,
    pub loading: bool,
    /// The id of the task opened, while its detail loads and after.
    pub open_task: Option<String>,
    /// The task opened, with everything about it.
    pub detail: Option<TaskDetailView>,
    /// The kind of record on screen (`decision`, `workaround`, `risk`, `question`, `milestone`).
    pub records_kind: Option<String>,
    pub records: Vec<TaskRecordView>,
    pub split: TaskSplitView,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TasksOverviewView {
    /// The project has a tasks folder at all.
    pub exists: bool,
    pub title: String,
    pub mode_label: String,
    pub goal: Option<String>,
    /// `3 of 7 tasks done`.
    pub progress_label: String,
    pub percent: u8,
    /// `2 to do, 1 in progress, 1 blocked`.
    pub counts_label: String,
    pub milestones: Vec<TaskMilestoneView>,
    pub needs_you: Vec<TaskRowView>,
    pub questions: Vec<TaskRefView>,
    /// `2 open workarounds, 1 open risk`, or none when both are zero.
    pub records_label: Option<String>,
    pub run: Option<TaskRunView>,
    /// No relay runs on the project, and there is a task to run.
    pub can_start: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskMilestoneView {
    pub id: String,
    pub title: String,
    pub status: String,
    pub target: Option<String>,
    /// `1 of 2 done`.
    pub label: String,
    pub percent: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskRowView {
    pub id: String,
    pub title: String,
    /// `todo`, `in-progress`, `testing`, `done` or `blocked`.
    pub status: String,
    pub status_label: String,
    /// `P1 · M001 · due 2026-12-01 · 1 of 2 criteria`, the parts the task has.
    pub meta: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskRefView {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskRunView {
    /// `Running T003`, `Paused`, `Waiting to start`.
    pub label: String,
    pub can_pause: bool,
    pub can_resume: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskDetailView {
    pub row: TaskRowView,
    pub priority: Option<String>,
    pub size: Option<String>,
    pub milestone: Option<String>,
    pub due: Option<String>,
    /// `Attempt 2`, when the task was ever redone.
    pub attempt_label: Option<String>,
    pub sections: Vec<TaskSectionView>,
    pub acceptance: Vec<TaskCheckView>,
    pub handoff: Option<TaskHandoffView>,
    pub journal: Vec<TaskJournalView>,
    /// The spec as Markdown, for editing.
    pub body: String,
    /// The statuses the task can move to.
    pub moves: Vec<TaskMoveView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskMoveView {
    pub status: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskSectionView {
    pub heading: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskCheckView {
    pub index: u32,
    pub text: String,
    pub checked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskHandoffView {
    /// `Carries on, tests passed, session 2`.
    pub summary: String,
    pub sections: Vec<TaskSectionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskJournalView {
    pub heading: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskRecordView {
    pub id: String,
    pub title: String,
    pub status: String,
    pub statuses: Vec<String>,
    /// Its fields as label and value, such as `Waits on` and `zod`.
    pub details: Vec<TaskSectionView>,
    pub sections: Vec<TaskSectionView>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct TaskSplitView {
    pub running: bool,
    pub plan_only: bool,
    pub summary: Option<String>,
    /// `T014 Search API`, one per task the plan adds.
    pub entries: Vec<String>,
    pub extras: Option<String>,
    pub error: Option<String>,
}

/// What the phone's edit sheet hands over for a task.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TaskEditInput {
    pub title: String,
    pub priority: Option<String>,
    pub size: Option<String>,
    pub due: Option<String>,
}
