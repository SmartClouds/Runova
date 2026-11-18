//! What the phone shows of files sent to it (E114): the question while someone waits for an
//! answer, each send as it comes in, and whether the phone takes files at all.

use crate::view::SendFileState;

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct ReceiveScreen {
    /// The phone takes files from its owner's computers.
    pub enabled: bool,
    /// Files from those computers come straight in, without asking.
    pub auto_accept: bool,
    /// The app has said where received files go, so the phone can take them.
    pub ready: bool,
    /// Sends waiting for a yes or a no, oldest first.
    pub offers: Vec<IncomingOfferView>,
    /// Newest first.
    pub batches: Vec<ReceivedBatchView>,
    /// Sends coming in now, for the notification that keeps the phone going in the background.
    pub active: u32,
    /// "Receiving from Sam's desk, 46%" while anything is coming in.
    pub progress_label: Option<String>,
    pub progress_percent: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct IncomingOfferView {
    pub id: String,
    /// The computer it comes from.
    pub from: String,
    pub person: String,
    /// "Sam's desk wants to send you 3 files".
    pub title: String,
    /// "3 files, 1.4 MB".
    pub size_label: String,
    pub note: Option<String>,
    pub files: Vec<OfferFileView>,
    pub more_files: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct OfferFileView {
    pub name: String,
    pub folder: Option<String>,
    pub size_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ReceivePhase {
    Connecting,
    /// Waiting for the person here to say yes or no.
    Asking,
    Receiving,
    /// The link went; the computer dials again and it picks up where it stopped.
    Reconnecting,
    Done,
    Declined,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ReceivedBatchView {
    pub id: String,
    /// "From Sam's desk".
    pub title: String,
    pub status: String,
    pub phase: ReceivePhase,
    pub file_count: u32,
    pub files_done: u32,
    pub files_failed: u32,
    pub total_bytes: u64,
    pub received_bytes: u64,
    pub percent: u8,
    pub size_label: String,
    pub note: Option<String>,
    pub files: Vec<ReceivedFileView>,
    pub more_files: u32,
    pub can_cancel: bool,
    pub can_dismiss: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ReceivedFileView {
    pub transfer_id: String,
    pub name: String,
    pub folder: Option<String>,
    pub size_label: String,
    pub state: SendFileState,
    pub percent: u8,
    /// Where it was saved on this phone, once it arrived intact.
    pub path: Option<String>,
    pub error: Option<String>,
}
