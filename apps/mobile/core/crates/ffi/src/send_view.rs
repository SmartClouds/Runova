//! What the Send files screen shows (E113): the computers files can go to, and each send with
//! its own line of status, ready to draw.

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct SendScreen {
    pub targets: Vec<SendTargetView>,
    /// Newest first.
    pub batches: Vec<SendBatchView>,
    /// A send that could not start, such as one with too many files.
    pub error: Option<String>,
    /// Sends still going, for the notification that keeps the phone sending in the background.
    pub active: u32,
    /// "Sending to Sam's desk, 46%" while any send is going.
    pub progress_label: Option<String>,
    /// Over every send still going, 0 to 100.
    pub progress_percent: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SendTargetView {
    pub system_id: i64,
    pub name: String,
    pub platform: String,
    /// One of this person's own computers, rather than a teammate's.
    pub own: bool,
    pub online: bool,
    pub can_receive: bool,
    /// Why it can not take files now, when it can not.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SendPhase {
    Connecting,
    /// The list is on the computer, waiting for its person to say yes.
    Waiting,
    Sending,
    /// The link went; the phone is dialing again and picks up where it stopped.
    Reconnecting,
    Done,
    Declined,
    /// No one answered in time.
    Expired,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SendFileState {
    Queued,
    Sending,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SendBatchView {
    pub batch_id: String,
    pub system_id: i64,
    /// "To Sam's desk".
    pub title: String,
    /// What it is doing, in one line: "Sending 3 of 35, 18.2 MB/s, about 1 min left".
    pub status: String,
    pub phase: SendPhase,
    pub file_count: u32,
    pub files_done: u32,
    pub files_failed: u32,
    pub total_bytes: u64,
    pub sent_bytes: u64,
    pub percent: u8,
    /// "35 files, 1.4 GB".
    pub size_label: String,
    pub note: Option<String>,
    /// The first files, in the order they go. `more_files` says how many are not listed.
    pub files: Vec<SendFileView>,
    pub more_files: u32,
    pub can_cancel: bool,
    pub can_retry: bool,
    pub can_dismiss: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SendFileView {
    pub transfer_id: String,
    pub name: String,
    /// The folder it goes in on the other side, when it is in one.
    pub folder: Option<String>,
    pub size_label: String,
    pub state: SendFileState,
    pub percent: u8,
    pub error: Option<String>,
}
