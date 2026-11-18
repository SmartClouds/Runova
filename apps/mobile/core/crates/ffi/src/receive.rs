//! Files sent to the phone (E114). The phone goes online on the hub saying it takes files, once the
//! app has said where they go. Only its owner's own computers can send to it, and only a `send`
//! reaches it. A request is said yes to on the hub by the phone's own rules, the link opens over
//! the relay, and the list of files comes over that link: the person here says yes or no, unless
//! files from their own computers come straight in. A send that drops picks up on the next link
//! the computer opens, without asking again.

use crate::engine::{Done, Engine, Runner};
use crate::labels::bytes_label;
use crate::secure::identity_seed;
use crate::send::{Meter, count_label, files_label, percent_of, rate_label, time_left_label};
use crate::view::{
    IncomingOfferView, OfferFileView, ReceivePhase, ReceiveScreen, ReceivedBatchView,
    ReceivedFileView, SendFileState,
};
use runova_protocol::send::{
    AnswerReason, RECEIVE_FILES_FEATURE, SendFile, SendMessage, parse_send_message,
};
use runova_session::connect::accept_send;
use runova_session::hub::IncomingRequest;
use runova_transfer::receiver::{
    ReceiveEvent, ReceiveOutcome, ReceiveState as Received, Waited, receive_batch_observed,
    refuse_batch, wait_for_answer,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::time::{Instant, timeout};

const SETTINGS: &str = "receive-settings";
/// Sends coming in at once. More are said no to on the hub.
const MAX_ACTIVE: usize = 2;
const MAX_KEPT: usize = 20;
const VIEW_FILES: usize = 200;
const OFFER_FILES: usize = 50;
/// How long the list may take to come once the link is open.
const OFFER_WAIT: Duration = Duration::from_secs(30);
/// How long the person here has to answer, as on the desktop.
const ANSWER_WAIT: Duration = Duration::from_secs(60);
/// How long a dropped send waits for its computer to dial again, longer than the computer tries.
const RECONNECT_WAIT: Duration = Duration::from_secs(7 * 60);
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    enabled: bool,
    auto_accept: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_accept: false,
        }
    }
}

/// The person's answer, handed to the link's task.
enum Decision {
    Accept(Box<Received>),
    Decline,
}

struct Row {
    file: SendFile,
    received: u64,
    state: SendFileState,
    path: Option<PathBuf>,
    error: Option<String>,
}

struct Job {
    id: String,
    device: String,
    person: String,
    key: String,
    batch_id: Option<String>,
    rows: Vec<Row>,
    note: Option<String>,
    phase: ReceivePhase,
    reason: Option<String>,
    token: u64,
    answer: Option<oneshot::Sender<Decision>>,
    stop: Option<watch::Sender<bool>>,
    meter: Meter,
}

impl Job {
    fn active(&self) -> bool {
        matches!(
            self.phase,
            ReceivePhase::Connecting
                | ReceivePhase::Asking
                | ReceivePhase::Receiving
                | ReceivePhase::Reconnecting
        )
    }

    /// Bytes are moving, or about to.
    fn moving(&self) -> bool {
        matches!(
            self.phase,
            ReceivePhase::Connecting | ReceivePhase::Asking | ReceivePhase::Receiving
        )
    }

    fn total(&self) -> u64 {
        self.rows.iter().map(|row| row.file.size).sum()
    }

    fn received(&self) -> u64 {
        self.rows.iter().map(|row| row.received).sum()
    }

    fn count(&self, state: SendFileState) -> usize {
        self.rows.iter().filter(|row| row.state == state).count()
    }
}

#[derive(Default)]
pub(crate) struct ReceiveState {
    settings: Settings,
    folder: Option<PathBuf>,
    /// Went online on the hub there is now.
    online: bool,
    jobs: Vec<Job>,
    /// What a dropped send has received so far, by batch and sender, for its next link.
    kept: HashMap<(String, String), Received>,
    tokens: u64,
}

impl ReceiveState {
    pub(crate) fn busy(&self) -> bool {
        self.jobs.iter().any(Job::active)
    }

    fn next_token(&mut self) -> u64 {
        self.tokens += 1;
        self.tokens
    }
}

enum Report {
    Offer {
        batch_id: String,
        files: Vec<SendFile>,
        note: Option<String>,
        answer: oneshot::Sender<Decision>,
    },
    Event(ReceiveEvent),
    Ended(Ended),
}

enum Ended {
    Failed(String),
    Declined,
    NoAnswer,
    GaveUp,
    Received {
        outcome: ReceiveOutcome,
        kept: Box<Received>,
    },
}

#[uniffi::export]
impl Engine {
    /// Where received files go: a folder of the app's own. Until this is known the phone takes none.
    pub fn set_receive_folder(&self, path: String) {
        self.run(move |runner| runner.set_receive_folder(path));
    }

    pub fn set_receive_enabled(&self, on: bool) {
        self.run(move |runner| runner.change_receive(|s| s.enabled = on));
    }

    pub fn set_receive_auto_accept(&self, on: bool) {
        self.run(move |runner| runner.change_receive(|s| s.auto_accept = on));
    }

    pub fn answer_offer(&self, id: String, accept: bool) {
        self.run(move |runner| runner.answer_offer(&id, accept));
    }

    pub fn cancel_receive(&self, id: String) {
        self.run(move |runner| runner.cancel_receive(&id));
    }

    /// Takes a finished send off the list. The files stay where they were saved.
    pub fn dismiss_received(&self, id: String) {
        self.run(move |runner| runner.dismiss_received(&id));
    }

    pub fn clear_received(&self) {
        self.run(Runner::clear_received);
    }
}

fn split_path(path: &str) -> (Option<String>, String) {
    match path.rfind('/') {
        Some(at) => (Some(path[..at].to_owned()), path[at + 1..].to_owned()),
        None => (None, path.to_owned()),
    }
}

fn status_of(job: &Job) -> String {
    match job.phase {
        ReceivePhase::Connecting => format!("{} is connecting…", job.device),
        ReceivePhase::Asking => "Waiting for your answer".to_owned(),
        ReceivePhase::Receiving => {
            let settled = job.count(SendFileState::Done)
                + job.count(SendFileState::Failed)
                + job.count(SendFileState::Skipped);
            let current = (settled + 1).min(job.rows.len());
            let mut parts = vec![format!(
                "Receiving {current} of {}",
                count_label(job.rows.len())
            )];
            if let Some(rate) = job.meter.per_second() {
                parts.push(rate_label(rate));
                let left = job.total().saturating_sub(job.received());
                parts.push(time_left_label((left as f64 / rate).ceil() as u64));
            }
            parts.join(", ")
        }
        ReceivePhase::Reconnecting => "Reconnecting, it picks up where it stopped".to_owned(),
        ReceivePhase::Done => {
            let done = job.count(SendFileState::Done);
            let failed = job.count(SendFileState::Failed);
            if failed > 0 {
                format!(
                    "Received {} of {}, {} failed",
                    count_label(done),
                    files_label(job.rows.len()),
                    count_label(failed)
                )
            } else {
                format!(
                    "Received {}, {}, verified",
                    files_label(done),
                    bytes_label(job.total())
                )
            }
        }
        _ => job
            .reason
            .clone()
            .unwrap_or_else(|| "It did not come through.".to_owned()),
    }
}

fn view_of(job: &Job) -> ReceivedBatchView {
    let total = job.total();
    let received = job.received();
    ReceivedBatchView {
        id: job.id.clone(),
        title: format!("From {}", job.device),
        status: status_of(job),
        phase: job.phase,
        file_count: job.rows.len() as u32,
        files_done: job.count(SendFileState::Done) as u32,
        files_failed: job.count(SendFileState::Failed) as u32,
        total_bytes: total,
        received_bytes: received,
        percent: if job.phase == ReceivePhase::Done {
            100
        } else {
            percent_of(received, total)
        },
        size_label: format!("{}, {}", files_label(job.rows.len()), bytes_label(total)),
        note: job.note.clone(),
        files: job
            .rows
            .iter()
            .take(VIEW_FILES)
            .map(|row| {
                let (folder, name) = split_path(&row.file.path);
                ReceivedFileView {
                    transfer_id: row.file.transfer_id.clone(),
                    name,
                    folder,
                    size_label: bytes_label(row.file.size),
                    state: row.state,
                    percent: if row.state == SendFileState::Done {
                        100
                    } else {
                        percent_of(row.received, row.file.size)
                    },
                    path: row.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
                    error: row.error.clone(),
                }
            })
            .collect(),
        more_files: job.rows.len().saturating_sub(VIEW_FILES) as u32,
        can_cancel: job.active() && job.phase != ReceivePhase::Asking,
        can_dismiss: !job.active(),
    }
}

fn offer_of(job: &Job) -> IncomingOfferView {
    IncomingOfferView {
        id: job.id.clone(),
        from: job.device.clone(),
        person: job.person.clone(),
        title: format!(
            "{} wants to send you {}",
            job.device,
            files_label(job.rows.len())
        ),
        size_label: format!(
            "{}, {}",
            files_label(job.rows.len()),
            bytes_label(job.total())
        ),
        note: job.note.clone(),
        files: job
            .rows
            .iter()
            .take(OFFER_FILES)
            .map(|row| {
                let (folder, name) = split_path(&row.file.path);
                OfferFileView {
                    name,
                    folder,
                    size_label: bytes_label(row.file.size),
                }
            })
            .collect(),
        more_files: job.rows.len().saturating_sub(OFFER_FILES) as u32,
    }
}

impl Runner {
    pub(crate) fn transfers_busy(&self) -> bool {
        self.send.busy() || self.receive.busy()
    }

    /// Lets the hub go once the last send or receive that kept it in the background is over.
    pub(crate) fn release_hub_if_idle(&mut self) {
        if self.send.hold_hub && !self.transfers_busy() {
            self.send.hold_hub = false;
            self.let_go_of_hub();
        }
    }

    pub(crate) fn load_receive_settings(&mut self) {
        if let Some(saved) = self
            .deps
            .secure
            .get(SETTINGS.to_owned())
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        {
            self.receive.settings = saved;
        }
        self.refresh_receive_view();
    }

    fn change_receive(&mut self, change: impl FnOnce(&mut Settings)) {
        change(&mut self.receive.settings);
        if let Ok(text) = serde_json::to_string(&self.receive.settings) {
            self.deps.secure.set(SETTINGS.to_owned(), text);
        }
        self.refresh_receive_view();
        self.go_online_for_files();
    }

    fn set_receive_folder(&mut self, path: String) {
        let folder = PathBuf::from(path);
        let _ = std::fs::create_dir_all(&folder);
        self.receive.folder = Some(folder);
        self.refresh_receive_view();
        self.go_online_for_files();
    }

    /// A new hub, or none: the phone has not said it takes files on it yet.
    pub(crate) fn receive_hub_changed(&mut self) {
        self.receive.online = false;
        self.go_online_for_files();
    }

    /// Says on the hub that the phone takes files, once it can and the person wants it to.
    pub(crate) fn go_online_for_files(&mut self) {
        let settings = self.receive.settings;
        if self.receive.online || !settings.enabled || self.receive.folder.is_none() {
            return;
        }
        let (Some(hub), Some(device_id)) = (self.hub.clone(), self.device_id) else {
            return;
        };
        self.receive.online = true;
        tokio::spawn(async move {
            let _ = hub
                .go_online(device_id, &[RECEIVE_FILES_FEATURE.to_owned()])
                .await;
        });
    }

    fn refresh_receive_view(&mut self) {
        let state = &self.receive;
        let moving: Vec<&Job> = state.jobs.iter().filter(|job| job.moving()).collect();
        let (got, total) = moving
            .iter()
            .fold((0, 0), |(g, t), job| (g + job.received(), t + job.total()));
        let percent = percent_of(got, total);
        let progress_label = match moving.as_slice() {
            [] => None,
            [job] => Some(format!("Receiving from {}, {percent}%", job.device)),
            many => Some(format!(
                "Receiving from {} computers, {percent}%",
                many.len()
            )),
        };
        self.view.receive = ReceiveScreen {
            enabled: state.settings.enabled,
            auto_accept: state.settings.auto_accept,
            ready: state.folder.is_some(),
            offers: state
                .jobs
                .iter()
                .rev()
                .filter(|job| job.phase == ReceivePhase::Asking)
                .map(offer_of)
                .collect(),
            batches: state
                .jobs
                .iter()
                .filter(|job| job.phase != ReceivePhase::Connecting && !job.rows.is_empty())
                .map(view_of)
                .collect(),
            active: state.jobs.iter().filter(|job| job.active()).count() as u32,
            progress_label,
            progress_percent: percent,
        };
    }

    /// Someone asks for this phone on the hub.
    pub(crate) fn on_incoming(&mut self, request: IncomingRequest) {
        let Some(hub) = self.hub.clone() else {
            return;
        };
        let settings = self.receive.settings;
        let busy = self.receive.jobs.iter().filter(|job| job.moving()).count() >= MAX_ACTIVE;
        let (folder, key) = match (&self.receive.folder, &request.identity_key) {
            (Some(folder), Some(key))
                if request.intent == "send"
                    && request.relation == "own"
                    && settings.enabled
                    && !busy =>
            {
                (folder.clone(), key.clone())
            }
            _ => {
                let session = request.session_id;
                tokio::spawn(async move { hub.respond(&session, false).await });
                return;
            }
        };
        let token = self.receive.next_token();
        let id = format!("r{token}");
        let device = request
            .device_name
            .clone()
            .unwrap_or_else(|| request.person.clone());
        let (stop, stop_rx) = watch::channel(false);
        self.receive.jobs.insert(
            0,
            Job {
                id: id.clone(),
                device,
                person: request.person.clone(),
                key: key.clone(),
                batch_id: None,
                rows: Vec::new(),
                note: None,
                phase: ReceivePhase::Connecting,
                reason: None,
                token,
                answer: None,
                stop: Some(stop),
                meter: Meter::default(),
            },
        );
        let seed = identity_seed(self.deps.secure.as_ref());
        let transports = self.deps.transports.clone();
        let done = self.done_tx.clone();
        let session = request.session_id;
        tokio::spawn(async move {
            let last_progress = Mutex::new(None::<Instant>);
            let to_runner = done.clone();
            let job = id.clone();
            let report = move |report: Report| {
                if let Report::Event(ReceiveEvent::Progress { .. }) = report {
                    let mut last = last_progress.lock().expect("the progress clock");
                    if last.is_some_and(|at| at.elapsed() < PROGRESS_EVERY) {
                        return;
                    }
                    *last = Some(Instant::now());
                }
                let job = job.clone();
                let _ = to_runner.send(Done::Local(Box::new(move |runner| {
                    runner.on_receive_report(&job, token, report);
                })));
            };
            hub.respond(&session, true).await;
            let ended = host(
                &session,
                &key,
                seed,
                hub.as_ref(),
                transports.as_ref(),
                folder,
                stop_rx,
                &report,
            )
            .await;
            hub.end(&session).await;
            report(Report::Ended(ended));
        });
        self.refresh_receive_view();
    }

    fn receive_job(&mut self, id: &str) -> Option<&mut Job> {
        self.receive.jobs.iter_mut().find(|job| job.id == id)
    }

    fn on_receive_report(&mut self, id: &str, token: u64, report: Report) {
        match report {
            Report::Offer {
                batch_id,
                files,
                note,
                answer,
            } => self.on_offer(id, token, batch_id, files, note, answer),
            Report::Event(event) => {
                if let Some(job) = self.receive_job(id)
                    && job.token == token
                {
                    on_event(job, event);
                }
            }
            Report::Ended(ended) => self.on_receive_ended(id, token, ended),
        }
        self.refresh_receive_view();
    }

    fn on_offer(
        &mut self,
        id: &str,
        token: u64,
        batch_id: String,
        files: Vec<SendFile>,
        note: Option<String>,
        answer: oneshot::Sender<Decision>,
    ) {
        let auto_accept = self.receive.settings.auto_accept;
        let Some(job) = self.receive_job(id) else {
            return;
        };
        if job.token != token {
            return;
        }
        let kept_key = (batch_id.clone(), job.key.clone());
        job.batch_id = Some(batch_id.clone());
        job.note = note;
        job.rows = files
            .into_iter()
            .map(|file| Row {
                file,
                received: 0,
                state: SendFileState::Queued,
                path: None,
                error: None,
            })
            .collect();
        // The same send on a new link: it picks up where it stopped, without asking again.
        if let Some(kept) = self.receive.kept.remove(&kept_key) {
            let key = kept_key.1;
            self.receive.jobs.retain(|other| {
                other.id == id
                    || !(other.phase == ReceivePhase::Reconnecting
                        && other.batch_id.as_deref() == Some(batch_id.as_str())
                        && other.key == key)
            });
            if let Some(job) = self.receive_job(id) {
                for row in job.rows.iter_mut() {
                    if let Some(path) = kept.saved().get(&row.file.transfer_id) {
                        row.state = SendFileState::Done;
                        row.received = row.file.size;
                        row.path = Some(path.clone());
                    }
                }
                job.phase = ReceivePhase::Receiving;
            }
            let _ = answer.send(Decision::Accept(Box::new(kept)));
            return;
        }
        let Some(job) = self.receive_job(id) else {
            return;
        };
        if auto_accept {
            job.phase = ReceivePhase::Receiving;
            let _ = answer.send(Decision::Accept(Box::default()));
        } else {
            job.phase = ReceivePhase::Asking;
            job.answer = Some(answer);
        }
    }

    fn answer_offer(&mut self, id: &str, accept: bool) {
        if let Some(job) = self.receive_job(id)
            && let Some(answer) = job.answer.take()
        {
            let decision = if accept {
                job.phase = ReceivePhase::Receiving;
                Decision::Accept(Box::default())
            } else {
                Decision::Decline
            };
            let _ = answer.send(decision);
        }
        self.refresh_receive_view();
    }

    fn on_receive_ended(&mut self, id: &str, token: u64, ended: Ended) {
        let Some(job) = self.receive_job(id) else {
            return;
        };
        if job.token != token {
            return;
        }
        job.answer = None;
        job.stop = None;
        let device = job.device.clone();
        let (phase, reason) = match ended {
            Ended::Failed(reason) => (ReceivePhase::Failed, Some(reason)),
            Ended::Declined => (ReceivePhase::Declined, Some("You declined it.".to_owned())),
            Ended::NoAnswer => (
                ReceivePhase::Declined,
                Some("It was not answered in time.".to_owned()),
            ),
            Ended::GaveUp => (
                ReceivePhase::Cancelled,
                Some(format!("{device} stopped waiting.")),
            ),
            Ended::Received { outcome, kept } => match outcome {
                ReceiveOutcome::Done => {
                    for row in job.rows.iter_mut() {
                        if matches!(row.state, SendFileState::Queued | SendFileState::Sending) {
                            row.state = SendFileState::Skipped;
                        }
                    }
                    if job.count(SendFileState::Done) == 0 {
                        (
                            ReceivePhase::Failed,
                            Some("None of the files arrived.".to_owned()),
                        )
                    } else {
                        (ReceivePhase::Done, None)
                    }
                }
                ReceiveOutcome::Cancelled => (
                    ReceivePhase::Cancelled,
                    Some(format!("Stopped on {device}.")),
                ),
                ReceiveOutcome::Stopped | ReceiveOutcome::Declined => (
                    ReceivePhase::Cancelled,
                    Some("You cancelled it.".to_owned()),
                ),
                ReceiveOutcome::Dropped => {
                    // Kept for the next link the computer opens, for a while.
                    if let Some(batch) = job.batch_id.clone() {
                        let key = (batch, job.key.clone());
                        self.receive.kept.insert(key, *kept);
                        self.wait_for_redial(id, token);
                    }
                    (ReceivePhase::Reconnecting, None)
                }
            },
        };
        if let Some(job) = self.receive_job(id) {
            job.phase = phase;
            job.reason = reason;
        }
        self.trim_received();
        self.release_hub_if_idle();
    }

    fn wait_for_redial(&mut self, id: &str, token: u64) {
        let done = self.done_tx.clone();
        let job = id.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(RECONNECT_WAIT).await;
            let _ = done.send(Done::Local(Box::new(move |runner| {
                let Some(found) = runner.receive_job(&job) else {
                    return;
                };
                if found.token != token || found.phase != ReceivePhase::Reconnecting {
                    return;
                }
                found.phase = ReceivePhase::Failed;
                found.reason = Some(format!("The connection to {} was lost.", found.device));
                let key = found
                    .batch_id
                    .clone()
                    .map(|batch| (batch, found.key.clone()));
                if let Some(key) = key {
                    runner.receive.kept.remove(&key);
                }
                runner.refresh_receive_view();
                runner.release_hub_if_idle();
            })));
        });
    }

    fn trim_received(&mut self) {
        let mut kept = 0;
        self.receive.jobs.retain(|job| {
            if job.active() {
                return true;
            }
            kept += 1;
            kept <= MAX_KEPT
        });
    }

    fn cancel_receive(&mut self, id: &str) {
        let token = self.receive.next_token();
        let Some(job) = self.receive_job(id) else {
            return;
        };
        if !job.active() {
            return;
        }
        if let Some(stop) = job.stop.take() {
            let _ = stop.send(true);
        }
        if let Some(answer) = job.answer.take() {
            let _ = answer.send(Decision::Decline);
        }
        job.token = token;
        job.phase = ReceivePhase::Cancelled;
        job.reason = Some("You cancelled it.".to_owned());
        let key = job.batch_id.clone().map(|batch| (batch, job.key.clone()));
        if let Some(key) = key {
            self.receive.kept.remove(&key);
        }
        self.refresh_receive_view();
        self.release_hub_if_idle();
    }

    fn dismiss_received(&mut self, id: &str) {
        self.receive.jobs.retain(|job| job.id != id || job.active());
        self.refresh_receive_view();
    }

    fn clear_received(&mut self) {
        self.receive.jobs.retain(Job::active);
        self.refresh_receive_view();
    }

    /// Signing out stops everything coming in and forgets it.
    pub(crate) fn stop_all_receives(&mut self) {
        for job in &mut self.receive.jobs {
            if let Some(stop) = job.stop.take() {
                let _ = stop.send(true);
            }
            if let Some(answer) = job.answer.take() {
                let _ = answer.send(Decision::Decline);
            }
        }
        self.receive.jobs.clear();
        self.receive.kept.clear();
        self.receive.online = false;
        self.refresh_receive_view();
    }
}

fn on_event(job: &mut Job, event: ReceiveEvent) {
    let at = |job: &Job, id: &str| job.rows.iter().position(|r| r.file.transfer_id == id);
    match event {
        ReceiveEvent::Progress {
            transfer_id,
            received,
        } => {
            if let Some(i) = at(job, &transfer_id) {
                job.rows[i].received = received;
                job.rows[i].state = SendFileState::Sending;
            }
            let total = job.received();
            job.meter.add(total);
        }
        ReceiveEvent::Saved { transfer_id, path } => {
            if let Some(i) = at(job, &transfer_id) {
                let row = &mut job.rows[i];
                row.received = row.file.size;
                row.state = SendFileState::Done;
                row.path = Some(path);
            }
        }
        ReceiveEvent::Failed {
            transfer_id,
            reason,
        } => {
            if let Some(i) = at(job, &transfer_id) {
                job.rows[i].state = SendFileState::Failed;
                job.rows[i].error = Some(reason);
            }
        }
        ReceiveEvent::Skipped { transfer_id } => {
            if let Some(i) = at(job, &transfer_id) {
                job.rows[i].state = SendFileState::Skipped;
            }
        }
    }
}

/// The phone's half of one send: the link over the relay, the list, the answer, the files.
#[allow(clippy::too_many_arguments)]
async fn host(
    session: &str,
    key: &str,
    seed: [u8; 32],
    hub: &dyn runova_session::hub::HubPort,
    transports: &dyn runova_session::connect::Transports,
    folder: PathBuf,
    stop: watch::Receiver<bool>,
    report: &(dyn Fn(Report) + Send + Sync),
) -> Ended {
    let mut link = match accept_send(session, key, seed, hub, transports).await {
        Ok(link) => link,
        Err(error) => return Ended::Failed(error.to_string()),
    };
    let offer = match timeout(OFFER_WAIT, async {
        loop {
            match link.next().await {
                Ok(runova_link::secure::LinkEvent::Text(text)) => {
                    if let Some(offer @ SendMessage::SendOffer { .. }) = parse_send_message(&text) {
                        return Some(offer);
                    }
                }
                Ok(_) => {}
                Err(_) => return None,
            }
        }
    })
    .await
    {
        Ok(Some(offer)) => offer,
        _ => {
            link.close().await;
            return Ended::Failed("Nothing came from the computer.".to_owned());
        }
    };
    let SendMessage::SendOffer {
        batch_id,
        files,
        note,
        ..
    } = &offer
    else {
        return Ended::Failed("Nothing came from the computer.".to_owned());
    };
    let (answer, asked) = oneshot::channel();
    report(Report::Offer {
        batch_id: batch_id.clone(),
        files: files.clone(),
        note: note.clone(),
        answer,
    });
    let ended = match wait_for_answer(&mut link, batch_id, asked, ANSWER_WAIT).await {
        Waited::Answer(Decision::Accept(mut kept)) => {
            let outcome =
                receive_batch_observed(&mut link, &offer, &folder, &mut kept, stop, &|event| {
                    report(Report::Event(event))
                })
                .await;
            Ended::Received { outcome, kept }
        }
        Waited::Answer(Decision::Decline) => {
            refuse_batch(&mut link, batch_id, AnswerReason::Declined).await;
            Ended::Declined
        }
        Waited::Timeout => {
            refuse_batch(&mut link, batch_id, AnswerReason::Timeout).await;
            Ended::NoAnswer
        }
        Waited::Cancelled => Ended::GaveUp,
        Waited::Gone => Ended::Failed("The connection to the computer was lost.".to_owned()),
    };
    link.close().await;
    ended
}
