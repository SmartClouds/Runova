//! Sending files from the phone to a computer (E113). Each send dials the computer on its own
//! session with the `send` intent, beside any connection the phone has open, and runs the batch
//! over that link: the list first, the person's answer, then each file in checked parts. A link
//! that drops is dialed again and the computer asks only for what it lacks. Files are read
//! through native code only when their turn comes.

use crate::backend::SystemEntry;
use crate::engine::{Done, Engine, Runner};
use crate::labels::bytes_label;
use crate::secure::{SecurePins, identity_seed};
use crate::view::{
    SendBatchView, SendFileState, SendFileView, SendPhase, SendScreen, SendTargetView,
};
use async_trait::async_trait;
use runova_crypto::handshake::os_random;
use runova_protocol::file::transfer_key;
use runova_protocol::send::{
    AnswerReason, MAX_FILES, MAX_NOTE_CHARS, MAX_OFFER_BYTES, RECEIVE_FILES_FEATURE,
    SEND_PART_BYTES, SendFile, SendMessage, safe_relative_path, send_path_key,
};
use runova_session::connect::{ConnectError, ConnectTarget, Transports, connect_send};
use runova_session::hub::{AccessMode, ConnectResult, HubEvent, HubPort, Intent, RelayTicket};
use runova_transfer::sender::{SendEvent, SendOutcome, SendPlan, send_batch};
use runova_transfer::source::{FileSource, SourceOpener};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

/// Sends going at once. More wait for one of them to finish.
const MAX_ACTIVE: usize = 4;
/// Finished sends kept on screen.
const MAX_KEPT: usize = 20;
/// File rows a send shows.
const VIEW_FILES: usize = 200;
const HUB_EVENT_QUEUE: usize = 64;
/// Seconds between dials after a link drops, the last one repeating.
const REDIAL_SECONDS: [u64; 5] = [1, 2, 4, 8, 15];
/// How long a dropped send keeps trying before it gives up.
const RECONNECT_FOR: Duration = Duration::from_secs(5 * 60);
/// Progress reaches the screen at most this often for each send.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// The speed is the average over this long.
const RATE_WINDOW: Duration = Duration::from_secs(5);

const TOO_MANY: &str = "You can send up to 10,000 files at a time.";
const TOO_LONG_A_LIST: &str = "That list is too long to send at once. Send it in smaller groups.";
const NOTHING_PICKED: &str = "Pick something to send first.";
const NOT_YET: &str = "Not connected to Runova yet. Try again in a moment.";
const GONE_FROM_LIST: &str = "That computer is no longer in your list.";
const ONE_AT_A_TIME: &str = "Wait for a send to finish first.";
const YOU_CANCELLED: &str = "You cancelled it.";
const NONE_ARRIVED: &str = "None of the files arrived.";

/// A file the person picked, as native code hands it over.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PickedFile {
    /// Native code's own name for the file, given back to [`PickedFiles::read`].
    pub handle: String,
    /// Where it goes on the other side: its name, or folders and its name joined by `/`.
    pub path: String,
    pub size: u64,
}

/// The bytes of picked files. Native code opens a file on its first read and keeps it open until
/// `close`, so a pick of thousands never holds thousands open.
#[uniffi::export(with_foreign)]
pub trait PickedFiles: Send + Sync {
    /// Up to `length` bytes from `offset`, fewer only at the end, or `None` when it can not be read.
    fn read(&self, handle: String, offset: u64, length: u32) -> Option<Vec<u8>>;
    /// The core is done with this file for now.
    fn close(&self, handle: String);
}

#[uniffi::export]
impl Engine {
    /// Sends `files` to a computer, with an optional note shown to its person.
    pub fn send_files(
        &self,
        system_id: i64,
        files: Vec<PickedFile>,
        note: Option<String>,
        picked: Arc<dyn PickedFiles>,
    ) {
        self.run(move |runner| runner.send_files(system_id, files, note, picked));
    }

    pub fn cancel_send(&self, batch_id: String) {
        self.run(move |runner| runner.cancel_send(&batch_id));
    }

    /// Sends what did not arrive again, as a new send to the same computer.
    pub fn retry_send(&self, batch_id: String) {
        self.run(move |runner| runner.retry_send(&batch_id));
    }

    pub fn dismiss_send(&self, batch_id: String) {
        self.run(move |runner| runner.dismiss_send(&batch_id));
    }

    pub fn clear_finished_sends(&self) {
        self.run(Runner::clear_finished_sends);
    }

    pub fn dismiss_send_error(&self) {
        self.run(|runner| runner.view.send.error = None);
    }
}

/// A file's size as both apps write it: "1.5 KB".
#[uniffi::export]
pub fn file_size_label(bytes: u64) -> String {
    bytes_label(bytes)
}

/// What is picked and not sent yet: "35 files, 1.4 GB".
#[uniffi::export]
pub fn files_summary(count: u32, bytes: u64) -> String {
    format!("{}, {}", files_label(count as usize), bytes_label(bytes))
}

/// The main button of the Send files screen: "Send 3 files to Sam's desk".
#[uniffi::export]
pub fn send_button_label(count: u32, computer: Option<String>) -> String {
    match (count, computer) {
        (0, _) => "Send".to_owned(),
        (count, Some(name)) => format!("Send {} to {name}", files_label(count as usize)),
        (count, None) => format!("Send {}", files_label(count as usize)),
    }
}

struct PickedSource {
    picked: Arc<dyn PickedFiles>,
    /// Transfer id to native handle.
    handles: HashMap<String, String>,
}

impl SourceOpener for PickedSource {
    fn open(&self, transfer_id: &str) -> Result<Box<dyn FileSource>, String> {
        let handle = self
            .handles
            .get(transfer_id)
            .ok_or_else(|| "That file is not in this send.".to_owned())?;
        Ok(Box::new(PickedReader {
            picked: self.picked.clone(),
            handle: handle.clone(),
        }))
    }
}

struct PickedReader {
    picked: Arc<dyn PickedFiles>,
    handle: String,
}

impl FileSource for PickedReader {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut filled = 0;
        while filled < buf.len() {
            let want = u32::try_from(buf.len() - filled).unwrap_or(u32::MAX);
            let bytes = self
                .picked
                .read(self.handle.clone(), offset + filled as u64, want)
                .ok_or_else(|| std::io::Error::other("it can not be read"))?;
            if bytes.is_empty() {
                break;
            }
            let taken = bytes.len().min(buf.len() - filled);
            buf[filled..filled + taken].copy_from_slice(&bytes[..taken]);
            filled += taken;
        }
        Ok(filled)
    }
}

impl Drop for PickedReader {
    fn drop(&mut self) {
        self.picked.close(self.handle.clone());
    }
}

/// The hub, noting the session a dial got so a send stopped halfway can still end it.
struct NotingHub {
    inner: Arc<dyn HubPort>,
    session: Mutex<Option<String>>,
}

#[async_trait]
impl HubPort for NotingHub {
    async fn request_connect(
        &self,
        remote_id: &str,
        device_id: i64,
        intent: Intent,
        mode: AccessMode,
    ) -> Result<ConnectResult, String> {
        let result = self
            .inner
            .request_connect(remote_id, device_id, intent, mode)
            .await?;
        *self.session.lock().expect("the session") = result.session_id.clone();
        Ok(result)
    }

    async fn signal(&self, session_id: &str, payload: &str) {
        self.inner.signal(session_id, payload).await;
    }

    async fn relay_ticket(&self, session_id: &str) -> Result<RelayTicket, String> {
        self.inner.relay_ticket(session_id).await
    }

    async fn end(&self, session_id: &str) {
        self.inner.end(session_id).await;
    }
}

struct Row {
    file: SendFile,
    sent: u64,
    state: SendFileState,
    error: Option<String>,
}

#[derive(Default)]
struct Meter {
    samples: VecDeque<(Instant, u64)>,
}

impl Meter {
    fn add(&mut self, total: u64) {
        let now = Instant::now();
        self.samples.push_back((now, total));
        while self
            .samples
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > RATE_WINDOW)
        {
            self.samples.pop_front();
        }
    }

    fn per_second(&self) -> Option<f64> {
        let (first, last) = (self.samples.front()?, self.samples.back()?);
        let seconds = last.0.duration_since(first.0).as_secs_f64();
        (seconds >= 0.5 && last.1 > first.1).then(|| (last.1 - first.1) as f64 / seconds)
    }
}

struct Job {
    id: String,
    system_id: i64,
    remote_id: String,
    device_name: String,
    rows: Vec<Row>,
    note: Option<String>,
    source: Arc<PickedSource>,
    /// The batch id on the wire, new for each "send again".
    wire_batch: String,
    finished: HashSet<String>,
    phase: SendPhase,
    reason: Option<String>,
    /// Bumped by every dial and every stop, so word from an older one is ignored.
    token: u64,
    stop: Option<watch::Sender<bool>>,
    /// Hub events for the dial under way.
    events: Option<mpsc::Sender<HubEvent>>,
    dropped_at: Option<Instant>,
    redials: usize,
    meter: Meter,
}

impl Job {
    fn active(&self) -> bool {
        matches!(
            self.phase,
            SendPhase::Connecting
                | SendPhase::Waiting
                | SendPhase::Sending
                | SendPhase::Reconnecting
        )
    }

    fn total(&self) -> u64 {
        self.rows.iter().map(|row| row.file.size).sum()
    }

    fn sent(&self) -> u64 {
        self.rows.iter().map(|row| row.sent).sum()
    }

    fn count(&self, state: SendFileState) -> usize {
        self.rows.iter().filter(|row| row.state == state).count()
    }

    fn plan(&self) -> SendPlan {
        SendPlan {
            batch_id: self.wire_batch.clone(),
            files: self.rows.iter().map(|row| row.file.clone()).collect(),
            note: self.note.clone(),
            part_bytes: SEND_PART_BYTES,
        }
    }
}

#[derive(Default)]
pub(crate) struct SendState {
    jobs: Vec<Job>,
    tokens: u64,
    /// The hub is kept past the background grace because a send is going.
    pub(crate) hold_hub: bool,
}

impl SendState {
    pub(crate) fn busy(&self) -> bool {
        self.jobs.iter().any(Job::active)
    }

    /// Hands a hub event to every dial still waiting on one. Each keeps only its own session's.
    pub(crate) fn forward(&self, event: &HubEvent) {
        for events in self.jobs.iter().filter_map(|job| job.events.as_ref()) {
            let _ = events.try_send(event.clone());
        }
    }

    fn next_token(&mut self) -> u64 {
        self.tokens += 1;
        self.tokens
    }
}

/// Word from a running send.
enum Report {
    /// The link is open, so hub events are no longer needed.
    Linked,
    Event(SendEvent),
    Ended(Ended),
}

enum Ended {
    Sent {
        outcome: SendOutcome,
        finished: HashSet<String>,
    },
    DialFailed(ConnectError),
    Cancelled,
}

/// Each computer from the directory, with whether it takes files and why not.
pub(crate) fn targets(systems: &[SystemEntry]) -> Vec<SendTargetView> {
    systems
        .iter()
        .map(|entry| {
            let reason = if !entry.online {
                Some("Offline".to_owned())
            } else if entry.kind != "app" {
                Some(format!("Open Runova on {} to send it files", entry.name))
            } else {
                match &entry.features {
                    None => Some("The Runova website needs an update for this".to_owned()),
                    Some(features) if !features.iter().any(|f| f == RECEIVE_FILES_FEATURE) => {
                        Some("Needs a newer Runova".to_owned())
                    }
                    Some(_) => None,
                }
            };
            SendTargetView {
                system_id: entry.id,
                name: entry.name.clone(),
                platform: entry.platform.clone(),
                own: entry.own,
                online: entry.online,
                can_receive: reason.is_none(),
                reason,
            }
        })
        .collect()
}

fn random_id(bytes: usize) -> String {
    os_random(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A picked path made safe to offer: folders kept where they can be, else just the name.
fn offer_path(raw: &str) -> String {
    let parts: Vec<&str> = raw
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect();
    if let Some(path) = safe_relative_path(&parts.join("/")) {
        return path;
    }
    let name: String = parts
        .last()
        .copied()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    safe_relative_path(&name).unwrap_or_else(|| "file".to_owned())
}

/// `name (1).ext` for the second file of one name, as the desktop names one.
fn numbered(path: &str, n: usize) -> String {
    let (folder, name) = match path.rfind('/') {
        Some(at) => (&path[..=at], &path[at + 1..]),
        None => ("", path),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    format!("{folder}{stem} ({n}){ext}")
}

fn count_label(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

fn files_label(count: usize) -> String {
    format!(
        "{} {}",
        count_label(count),
        if count == 1 { "file" } else { "files" }
    )
}

fn rate_label(per_second: f64) -> String {
    format!("{}/s", bytes_label(per_second.round() as u64))
}

fn time_left_label(seconds: u64) -> String {
    if seconds < 60 {
        return "less than a minute left".to_owned();
    }
    let minutes = (seconds as f64 / 60.0).round() as u64;
    if minutes < 60 {
        return format!("about {minutes} min left");
    }
    let hours = minutes / 60;
    format!("about {hours} h {} min left", minutes - hours * 60)
}

fn percent_of(part: u64, whole: u64) -> u8 {
    if whole == 0 {
        return 0;
    }
    ((part.min(whole) as f64 / whole as f64) * 100.0).floor() as u8
}

fn declined_reason(reason: Option<AnswerReason>, device: &str) -> String {
    match reason {
        Some(AnswerReason::Busy) => {
            format!("{device} is busy with other files. Try again in a moment.")
        }
        Some(AnswerReason::Timeout) => format!("No one answered on {device}."),
        Some(AnswerReason::NotAllowed) => format!("{device} isn't taking files from this phone."),
        Some(AnswerReason::NoSpace) => format!("{device} doesn't have room for these files."),
        Some(AnswerReason::Declined) | None => format!("Declined on {device}"),
    }
}

fn status_of(job: &Job) -> String {
    match job.phase {
        SendPhase::Connecting => format!("Reaching {}…", job.device_name),
        SendPhase::Waiting => format!("Waiting for {} to accept", job.device_name),
        SendPhase::Sending => {
            let settled = job.count(SendFileState::Done)
                + job.count(SendFileState::Failed)
                + job.count(SendFileState::Skipped);
            let current = (settled + 1).min(job.rows.len());
            let mut parts = vec![format!(
                "Sending {current} of {}",
                count_label(job.rows.len())
            )];
            if let Some(rate) = job.meter.per_second() {
                parts.push(rate_label(rate));
                let left = job.total().saturating_sub(job.sent());
                parts.push(time_left_label((left as f64 / rate).ceil() as u64));
            }
            parts.join(", ")
        }
        SendPhase::Reconnecting => "Reconnecting, it picks up where it stopped".to_owned(),
        SendPhase::Done => {
            let done = job.count(SendFileState::Done);
            let failed = job.count(SendFileState::Failed);
            if failed > 0 {
                format!(
                    "Sent {} of {}, {} failed",
                    count_label(done),
                    files_label(job.rows.len()),
                    count_label(failed)
                )
            } else {
                format!(
                    "Sent {}, {}, verified",
                    files_label(done),
                    bytes_label(job.total())
                )
            }
        }
        _ => job
            .reason
            .clone()
            .unwrap_or_else(|| "It did not go through.".to_owned()),
    }
}

fn view_of(job: &Job) -> SendBatchView {
    let total = job.total();
    let sent = job.sent();
    let files = job
        .rows
        .iter()
        .take(VIEW_FILES)
        .map(|row| {
            let (folder, name) = match row.file.path.rfind('/') {
                Some(at) => (
                    Some(row.file.path[..at].to_owned()),
                    row.file.path[at + 1..].to_owned(),
                ),
                None => (None, row.file.path.clone()),
            };
            SendFileView {
                transfer_id: row.file.transfer_id.clone(),
                name,
                folder,
                size_label: bytes_label(row.file.size),
                state: row.state,
                percent: if row.state == SendFileState::Done {
                    100
                } else {
                    percent_of(row.sent, row.file.size)
                },
                error: row.error.clone(),
            }
        })
        .collect();
    let finished = !job.active();
    SendBatchView {
        batch_id: job.id.clone(),
        system_id: job.system_id,
        title: format!("To {}", job.device_name),
        status: status_of(job),
        phase: job.phase,
        file_count: job.rows.len() as u32,
        files_done: job.count(SendFileState::Done) as u32,
        files_failed: job.count(SendFileState::Failed) as u32,
        total_bytes: total,
        sent_bytes: sent,
        percent: if job.phase == SendPhase::Done {
            100
        } else {
            percent_of(sent, total)
        },
        size_label: format!("{}, {}", files_label(job.rows.len()), bytes_label(total)),
        note: job.note.clone(),
        files,
        more_files: job.rows.len().saturating_sub(VIEW_FILES) as u32,
        can_cancel: !finished,
        can_retry: finished
            && (job.phase != SendPhase::Done || job.count(SendFileState::Failed) > 0),
        can_dismiss: finished,
    }
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    loop {
        if *stop.borrow() {
            return;
        }
        if stop.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// One try: dial the computer, then send whatever it does not have yet.
#[allow(clippy::too_many_arguments)]
async fn attempt(
    hub: Arc<dyn HubPort>,
    transports: Arc<dyn Transports>,
    pins: SecurePins,
    target: ConnectTarget,
    mut events: mpsc::Receiver<HubEvent>,
    plan: SendPlan,
    source: Arc<PickedSource>,
    mut finished: HashSet<String>,
    stop: watch::Receiver<bool>,
    report: &(dyn Fn(Report) + Send + Sync),
) -> Ended {
    let noting = NotingHub {
        inner: hub.clone(),
        session: Mutex::new(None),
    };
    let mut waiting = stop.clone();
    let dialed = tokio::select! {
        dialed = connect_send(target, &noting, transports.as_ref(), &pins, &mut events, &|_| {}) => dialed,
        () = stopped(&mut waiting) => {
            let session = noting.session.lock().expect("the session").take();
            if let Some(session) = session {
                hub.end(&session).await;
            }
            return Ended::Cancelled;
        }
    };
    let mut link = match dialed {
        Ok(link) => link,
        Err(error) => return Ended::DialFailed(error),
    };
    report(Report::Linked);
    let outcome = send_batch(
        &mut link.link,
        &plan,
        source.as_ref(),
        &mut finished,
        &|event| report(Report::Event(event)),
        stop,
    )
    .await;
    link.link.close().await;
    hub.end(&link.session_id).await;
    Ended::Sent { outcome, finished }
}

impl Runner {
    fn refresh_send_view(&mut self) {
        let jobs = &self.send.jobs;
        let active: Vec<&Job> = jobs.iter().filter(|job| job.active()).collect();
        let (sent, total) = active
            .iter()
            .fold((0, 0), |(s, t), job| (s + job.sent(), t + job.total()));
        let percent = percent_of(sent, total);
        let progress_label = match active.as_slice() {
            [] => None,
            [job] => Some(format!("Sending to {}, {percent}%", job.device_name)),
            many => Some(format!("Sending to {} computers, {percent}%", many.len())),
        };
        let screen = &mut self.view.send;
        screen.batches = jobs.iter().map(view_of).collect();
        screen.active = active.len() as u32;
        screen.progress_label = progress_label;
        screen.progress_percent = percent;
    }

    pub(crate) fn refresh_send_targets(&mut self) {
        self.view.send.targets = targets(&self.systems);
    }

    fn send_error(&mut self, message: impl Into<String>) {
        self.view.send.error = Some(message.into());
    }

    pub(crate) fn send_files(
        &mut self,
        system_id: i64,
        picks: Vec<PickedFile>,
        note: Option<String>,
        picked: Arc<dyn PickedFiles>,
    ) {
        self.view.send.error = None;
        if picks.is_empty() {
            return self.send_error(NOTHING_PICKED);
        }
        if picks.len() > MAX_FILES {
            return self.send_error(TOO_MANY);
        }
        let Some(entry) = self.systems.iter().find(|s| s.id == system_id).cloned() else {
            return self.send_error(GONE_FROM_LIST);
        };
        if let Some(reason) = targets(std::slice::from_ref(&entry))
            .into_iter()
            .next()
            .and_then(|target| target.reason)
        {
            return self.send_error(reason);
        }
        if self.hub.is_none() || self.device_id.is_none() {
            return self.send_error(NOT_YET);
        }
        if self.send.jobs.iter().filter(|job| job.active()).count() >= MAX_ACTIVE {
            return self.send_error(ONE_AT_A_TIME);
        }

        let mut taken = HashSet::new();
        let mut ids = HashSet::new();
        let mut keys = HashSet::new();
        let mut handles = HashMap::new();
        let mut rows = Vec::with_capacity(picks.len());
        for pick in picks {
            let path = offer_path(&pick.path);
            let path = (0..)
                .map(|n| {
                    if n == 0 {
                        path.clone()
                    } else {
                        numbered(&path, n)
                    }
                })
                .find(|candidate| taken.insert(send_path_key(candidate)))
                .unwrap_or(path);
            let transfer_id = loop {
                let id = random_id(8);
                if ids.insert(id.clone()) && keys.insert(transfer_key(&id)) {
                    break id;
                }
            };
            handles.insert(transfer_id.clone(), pick.handle);
            rows.push(Row {
                file: SendFile {
                    transfer_id,
                    path,
                    size: pick.size,
                },
                sent: 0,
                state: SendFileState::Queued,
                error: None,
            });
        }
        let note = note
            .map(|note| note.trim().chars().take(MAX_NOTE_CHARS).collect::<String>())
            .filter(|note| !note.is_empty());
        let job = Job {
            id: random_id(8),
            system_id,
            remote_id: entry.remote_id.clone(),
            device_name: entry.name.clone(),
            rows,
            note,
            source: Arc::new(PickedSource { picked, handles }),
            wire_batch: random_id(12),
            finished: HashSet::new(),
            phase: SendPhase::Connecting,
            reason: None,
            token: 0,
            stop: None,
            events: None,
            dropped_at: None,
            redials: 0,
            meter: Meter::default(),
        };
        let offer = SendMessage::SendOffer {
            v: 1,
            batch_id: job.wire_batch.clone(),
            files: job.plan().files,
            note: job.note.clone(),
        };
        if serde_json::to_string(&offer).map_or(true, |text| text.len() > MAX_OFFER_BYTES) {
            return self.send_error(TOO_LONG_A_LIST);
        }
        let id = job.id.clone();
        self.send.jobs.insert(0, job);
        self.trim_sends();
        self.dial_send(&id);
    }

    fn trim_sends(&mut self) {
        let mut kept = 0;
        self.send.jobs.retain(|job| {
            if job.active() {
                return true;
            }
            kept += 1;
            kept <= MAX_KEPT
        });
    }

    fn job(&mut self, id: &str) -> Option<&mut Job> {
        self.send.jobs.iter_mut().find(|job| job.id == id)
    }

    fn dial_send(&mut self, id: &str) {
        let token = self.send.next_token();
        let (Some(hub), Some(device_id)) = (self.hub.clone(), self.device_id) else {
            let reconnecting = self.job(id).is_some_and(|job| job.dropped_at.is_some());
            if reconnecting {
                self.redial_later(id);
            } else {
                self.finish_send(id, SendPhase::Failed, Some(NOT_YET.to_owned()));
            }
            return;
        };
        let seed = identity_seed(self.deps.secure.as_ref());
        let transports = self.deps.transports.clone();
        let pins = SecurePins(self.deps.secure.clone());
        let done = self.done_tx.clone();
        let Some(job) = self.job(id) else {
            return;
        };
        job.token = token;
        if job.phase != SendPhase::Reconnecting {
            job.phase = SendPhase::Connecting;
        }
        let (stop, stop_rx) = watch::channel(false);
        let (events, queue) = mpsc::channel(HUB_EVENT_QUEUE);
        job.stop = Some(stop);
        job.events = Some(events);
        let target = ConnectTarget {
            remote_id: job.remote_id.clone(),
            device_id,
            identity_seed: seed,
        };
        let plan = job.plan();
        let source = job.source.clone();
        let finished = job.finished.clone();
        let job_id = job.id.clone();
        tokio::spawn(async move {
            let last_progress = Mutex::new(None::<Instant>);
            let to_runner = done.clone();
            let id = job_id.clone();
            let report = move |report: Report| {
                if let Report::Event(SendEvent::Progress { .. }) = report {
                    let mut last = last_progress.lock().expect("the progress clock");
                    if last.is_some_and(|at| at.elapsed() < PROGRESS_EVERY) {
                        return;
                    }
                    *last = Some(Instant::now());
                }
                let id = id.clone();
                let _ = to_runner.send(Done::Local(Box::new(move |runner| {
                    runner.on_send_report(&id, token, report);
                })));
            };
            let ended = attempt(
                hub, transports, pins, target, queue, plan, source, finished, stop_rx, &report,
            )
            .await;
            report(Report::Ended(ended));
        });
        self.refresh_send_view();
    }

    fn on_send_report(&mut self, id: &str, token: u64, report: Report) {
        let Some(job) = self.job(id) else {
            return;
        };
        if job.token != token {
            return;
        }
        match report {
            Report::Linked => job.events = None,
            Report::Event(event) => on_event(job, event),
            Report::Ended(ended) => self.on_send_ended(id, ended),
        }
        self.refresh_send_view();
    }

    fn on_send_ended(&mut self, id: &str, ended: Ended) {
        let Some(job) = self.job(id) else {
            return;
        };
        job.stop = None;
        job.events = None;
        let device = job.device_name.clone();
        let reconnecting = job.dropped_at.is_some();
        match ended {
            Ended::Sent { outcome, finished } => {
                job.finished = finished;
                match outcome {
                    SendOutcome::Done { .. } => {
                        for row in job.rows.iter_mut() {
                            if row.state == SendFileState::Queued
                                || row.state == SendFileState::Sending
                            {
                                row.state = SendFileState::Skipped;
                            }
                        }
                        if job.count(SendFileState::Done) == 0 {
                            self.finish_send(id, SendPhase::Failed, Some(NONE_ARRIVED.to_owned()));
                        } else {
                            self.finish_send(id, SendPhase::Done, None);
                        }
                    }
                    SendOutcome::Declined(reason) => self.finish_send(
                        id,
                        SendPhase::Declined,
                        Some(declined_reason(reason, &device)),
                    ),
                    SendOutcome::Expired => self.finish_send(
                        id,
                        SendPhase::Expired,
                        Some(format!("No one answered on {device}.")),
                    ),
                    SendOutcome::Cancelled => {
                        self.finish_send(id, SendPhase::Cancelled, Some(YOU_CANCELLED.to_owned()))
                    }
                    SendOutcome::CancelledByThem => self.finish_send(
                        id,
                        SendPhase::Cancelled,
                        Some(format!("Stopped on {device}.")),
                    ),
                    SendOutcome::Dropped => self.redial_later(id),
                }
            }
            Ended::Cancelled => {
                self.finish_send(id, SendPhase::Cancelled, Some(YOU_CANCELLED.to_owned()))
            }
            Ended::DialFailed(ConnectError::KeyChanged) => self.finish_send(
                id,
                SendPhase::Failed,
                Some(ConnectError::KeyChanged.to_string()),
            ),
            Ended::DialFailed(ConnectError::Declined) => self.finish_send(
                id,
                SendPhase::Declined,
                Some(format!("{device} isn't taking files right now")),
            ),
            Ended::DialFailed(ConnectError::RateLimited) => self.redial_later(id),
            // A computer that was there a moment ago is most likely coming back.
            Ended::DialFailed(_) if reconnecting => self.redial_later(id),
            Ended::DialFailed(ConnectError::Offline) => {
                self.finish_send(id, SendPhase::Failed, Some(format!("{device} is offline.")))
            }
            Ended::DialFailed(ConnectError::NoAnswer) => self.finish_send(
                id,
                SendPhase::Expired,
                Some(format!("No one answered on {device}.")),
            ),
            Ended::DialFailed(ConnectError::Unavailable) => self.finish_send(
                id,
                SendPhase::Failed,
                Some(format!("{device} can't take files from this phone.")),
            ),
            Ended::DialFailed(error) => {
                self.finish_send(id, SendPhase::Failed, Some(error.to_string()))
            }
        }
    }

    fn redial_later(&mut self, id: &str) {
        let token = self.send.next_token();
        let done = self.done_tx.clone();
        let Some(job) = self.job(id) else {
            return;
        };
        let since = *job.dropped_at.get_or_insert_with(Instant::now);
        if since.elapsed() > RECONNECT_FOR {
            let reason = format!("The connection to {} was lost.", job.device_name);
            return self.finish_send(id, SendPhase::Failed, Some(reason));
        }
        job.token = token;
        job.phase = SendPhase::Reconnecting;
        job.meter = Meter::default();
        let wait = REDIAL_SECONDS[job.redials.min(REDIAL_SECONDS.len() - 1)];
        job.redials += 1;
        let job_id = job.id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(wait)).await;
            let _ = done.send(Done::Local(Box::new(move |runner| {
                if runner.job(&job_id).is_some_and(|job| job.token == token) {
                    runner.dial_send(&job_id);
                }
                runner.refresh_send_view();
            })));
        });
        self.refresh_send_view();
    }

    fn finish_send(&mut self, id: &str, phase: SendPhase, reason: Option<String>) {
        let token = self.send.next_token();
        if let Some(job) = self.job(id) {
            job.token = token;
            job.phase = phase;
            job.reason = reason;
            job.stop = None;
            job.events = None;
            job.dropped_at = None;
            job.redials = 0;
        }
        self.trim_sends();
        self.refresh_send_view();
        if self.send.hold_hub && !self.send.busy() {
            self.send.hold_hub = false;
            self.let_go_of_hub();
        }
    }

    pub(crate) fn cancel_send(&mut self, id: &str) {
        let Some(job) = self.job(id) else {
            return;
        };
        if !job.active() {
            return;
        }
        // The running try sees this, tells the computer and ends the session, in its own time.
        if let Some(stop) = job.stop.take() {
            let _ = stop.send(true);
        }
        self.finish_send(id, SendPhase::Cancelled, Some(YOU_CANCELLED.to_owned()));
    }

    pub(crate) fn retry_send(&mut self, id: &str) {
        if self.send.jobs.iter().filter(|job| job.active()).count() >= MAX_ACTIVE {
            return self.send_error(ONE_AT_A_TIME);
        }
        let Some(job) = self.job(id) else {
            return;
        };
        if job.active() {
            return;
        }
        job.rows.retain(|row| row.state != SendFileState::Done);
        if job.rows.is_empty() {
            return;
        }
        for row in job.rows.iter_mut() {
            row.sent = 0;
            row.state = SendFileState::Queued;
            row.error = None;
        }
        job.wire_batch = random_id(12);
        job.finished.clear();
        job.reason = None;
        job.phase = SendPhase::Connecting;
        job.meter = Meter::default();
        self.dial_send(id);
    }

    pub(crate) fn dismiss_send(&mut self, id: &str) {
        self.send.jobs.retain(|job| job.id != id || job.active());
        self.refresh_send_view();
    }

    pub(crate) fn clear_finished_sends(&mut self) {
        self.send.jobs.retain(Job::active);
        self.refresh_send_view();
    }

    /// Signing out stops every send and forgets them.
    pub(crate) fn stop_all_sends(&mut self) {
        for job in &mut self.send.jobs {
            if let Some(stop) = job.stop.take() {
                let _ = stop.send(true);
            }
        }
        self.send.jobs.clear();
        self.send.hold_hub = false;
        self.view.send = SendScreen::default();
    }
}

fn on_event(job: &mut Job, event: SendEvent) {
    let row = |job: &mut Job, id: &str| job.rows.iter_mut().position(|r| r.file.transfer_id == id);
    match event {
        SendEvent::Waiting => job.phase = SendPhase::Waiting,
        SendEvent::Sending => {
            job.phase = SendPhase::Sending;
            job.dropped_at = None;
            job.redials = 0;
        }
        SendEvent::Progress {
            transfer_id,
            transferred,
        } => {
            if let Some(at) = row(job, &transfer_id) {
                job.rows[at].sent = transferred;
                job.rows[at].state = SendFileState::Sending;
            }
            let sent = job.sent();
            job.meter.add(sent);
        }
        SendEvent::FileDone { transfer_id } => {
            if let Some(at) = row(job, &transfer_id) {
                let row = &mut job.rows[at];
                row.sent = row.file.size;
                row.state = SendFileState::Done;
                row.error = None;
            }
        }
        SendEvent::FileFailed {
            transfer_id,
            reason,
        } => {
            if let Some(at) = row(job, &transfer_id) {
                let row = &mut job.rows[at];
                row.state = SendFileState::Failed;
                row.error = Some(reason);
            }
        }
        SendEvent::FileSkipped { transfer_id } => {
            if let Some(at) = row(job, &transfer_id) {
                job.rows[at].state = SendFileState::Skipped;
            }
        }
    }
}
