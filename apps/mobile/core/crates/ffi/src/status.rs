//! What the desktop's status bar shows. The computer's numbers refresh often, AI usage rarely.

use crate::engine::{Apply, Done, Engine, Runner};
use crate::labels::{bytes_label, percent_label, reset_label, usd_label};
use crate::view::{
    AppView, ComputerItemView, LimitChipView, LimitState, LimitWindowView, ProviderState,
    ProviderUsageView, SystemStatsView,
};
use serde::Deserialize;

/// Sampled every tick, so at the desktop's own 60 seconds for usage against 4 for the computer.
const USAGE_EVERY_TICKS: u32 = 15;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemDto {
    #[serde(default)]
    cpu_model: String,
    #[serde(default)]
    cpu_core_count: u32,
    #[serde(default)]
    cpu_percent: f64,
    #[serde(default)]
    mem_percent: f64,
    #[serde(default)]
    mem_used_bytes: u64,
    #[serde(default)]
    mem_total_bytes: u64,
    #[serde(default)]
    net_rx_bytes_per_sec: u64,
    #[serde(default)]
    net_tx_bytes_per_sec: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowDto {
    label: String,
    percent: f64,
    reset_in_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitDto {
    provider_id: String,
    name: String,
    plan: Option<String>,
    state: String,
    problem: Option<String>,
    #[serde(default)]
    windows: Vec<WindowDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDto {
    provider_id: String,
    name: String,
    status: String,
    error: Option<String>,
    today_usd: Option<f64>,
    week_usd: Option<f64>,
    month_usd: Option<f64>,
    #[serde(default)]
    series: Vec<f64>,
}

#[derive(Deserialize)]
struct UsageDto {
    #[serde(default)]
    limits: Vec<LimitDto>,
    #[serde(default)]
    providers: Vec<ProviderDto>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct AgentsDto {
    working: u32,
    waiting: u32,
    finished: u32,
    idle: u32,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RelaysDto {
    running: u32,
    paused: u32,
    scheduled: u32,
    needs_you: u32,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SyncDto {
    needs_sign_in: bool,
    conflicts: u32,
    phase: String,
    keys_needed: u32,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct GithubDto {
    login: Option<String>,
    signed_in: bool,
    check_failed: bool,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct DockerDto {
    running: u32,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct AndroidDto {
    running: u32,
    booting: u32,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct KeepAwakeDto {
    mode: String,
    awake: bool,
    busy: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct BarDto {
    agents: AgentsDto,
    terminals: u32,
    relays: RelaysDto,
    transfers: u32,
    sync: Option<SyncDto>,
    github: Option<GithubDto>,
    docker: Option<DockerDto>,
    android: Option<AndroidDto>,
    keep_awake: Option<KeepAwakeDto>,
    /// Missing on a computer too old to say, which must not read as a closed window.
    window_open: Option<bool>,
    runs: Vec<RunDto>,
    plans: Vec<PlanDto>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RunDto {
    id: String,
    title: String,
    state: String,
    cpu_percent: Option<f64>,
    mem_bytes: Option<u64>,
    urls: Vec<String>,
    device: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PlanDto {
    key: String,
    kind: String,
    project_name: String,
    status: String,
    elapsed_ms: u64,
    error: Option<String>,
}

fn item(
    id: &str,
    title: &str,
    value: String,
    detail: Option<String>,
    attention: bool,
) -> ComputerItemView {
    ComputerItemView {
        id: id.to_owned(),
        title: title.to_owned(),
        value,
        detail,
        attention,
    }
}

/// The non-zero parts of a count, joined up, such as "2 working, 1 waiting on you".
fn counts(parts: &[(u32, &str)]) -> String {
    parts
        .iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| format!("{count} {what}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn sync_label(sync: &SyncDto) -> (String, bool) {
    if sync.needs_sign_in {
        ("Sign in again".to_owned(), true)
    } else if sync.conflicts > 0 {
        (format!("{} to review", sync.conflicts), true)
    } else if sync.phase == "syncing" {
        ("Syncing".to_owned(), false)
    } else if sync.phase == "offline" {
        ("Offline".to_owned(), false)
    } else if sync.phase == "error" {
        ("Sync stopped".to_owned(), true)
    } else if sync.keys_needed > 0 {
        ("Key needed".to_owned(), false)
    } else {
        ("Synced".to_owned(), false)
    }
}

fn github_item(github: GithubDto) -> ComputerItemView {
    let (value, detail, attention) = match (github.login, github.signed_in, github.check_failed) {
        (Some(login), true, false) => (format!("@{login}"), None, false),
        (Some(login), true, true) => (
            format!("@{login}"),
            Some("Couldn't check it just now".to_owned()),
            false,
        ),
        (_, _, true) => ("Couldn't check".to_owned(), None, true),
        _ => ("Not signed in".to_owned(), None, false),
    };
    item("github", "GitHub", value, detail, attention)
}

fn keep_awake_item(keep_awake: KeepAwakeDto) -> ComputerItemView {
    let mode = match keep_awake.mode.as_str() {
        "on" => "On",
        "off" => "Off",
        _ => "Agent",
    };
    let busy: Vec<String> = keep_awake
        .busy
        .iter()
        .map(|reason| match reason.as_str() {
            "agents" => "an agent at work".to_owned(),
            "terminals" => "a command in a terminal".to_owned(),
            "ssh" => "an SSH session".to_owned(),
            "sftp" => "file transfers".to_owned(),
            other => other.to_owned(),
        })
        .collect();
    let detail = if keep_awake.mode == "agent" && !busy.is_empty() {
        format!("Set to {mode}, awake for {}", busy.join(", "))
    } else {
        format!("Set to {mode}")
    };
    let value = if keep_awake.awake {
        "Awake now"
    } else {
        "Sleep allowed"
    };
    item(
        "keep-awake",
        "Keep awake",
        value.to_owned(),
        Some(detail),
        false,
    )
}

/// Minutes and seconds, the way the desktop's bar counts them.
fn elapsed_label(ms: u64) -> String {
    let seconds = ms / 1000;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

fn plan_item(plan: PlanDto) -> ComputerItemView {
    let place = if plan.project_name.is_empty() {
        "a project"
    } else {
        plan.project_name.as_str()
    };
    let (value, detail, attention) = match plan.status.as_str() {
        "done" => (
            "Tasks ready".to_owned(),
            format!("The plan for {place} is ready to review on this computer"),
            true,
        ),
        "failed" => (
            "Planning failed".to_owned(),
            format!(
                "Planning for {place} stopped: {}",
                plan.error.as_deref().unwrap_or("no answer")
            ),
            true,
        ),
        _ => {
            let word = match plan.kind.as_str() {
                "split" => "Splitting",
                "revise" => "Revising",
                _ => "Planning",
            };
            (
                format!("{word} {}", elapsed_label(plan.elapsed_ms)),
                format!("Planning tasks for {place} in the background"),
                false,
            )
        }
    };
    item(
        &format!("plan:{}", plan.key),
        "Relay plan",
        value,
        Some(detail),
        attention,
    )
}

/// An address without what every local one has in common.
fn short_url(url: &str) -> &str {
    let bare = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url);
    bare.strip_suffix('/').unwrap_or(bare)
}

fn run_item(run: RunDto) -> ComputerItemView {
    let value = match run.state.as_str() {
        "starting" => "Starting",
        "idle" => "Finished",
        "paused" => "Paused",
        _ => "Running",
    };
    let mut parts = Vec::new();
    if let Some(cpu) = run.cpu_percent {
        parts.push(format!("{} CPU", percent_label(cpu)));
    }
    if let Some(memory) = run.mem_bytes {
        parts.push(bytes_label(memory));
    }
    if let Some(url) = run.urls.first() {
        parts.push(short_url(url).to_owned());
    }
    if let Some(device) = run.device {
        parts.push(device);
    }
    let title = if run.title.is_empty() {
        "Run"
    } else {
        run.title.as_str()
    };
    item(
        &format!("run:{}", run.id),
        title,
        value.to_owned(),
        (!parts.is_empty()).then(|| parts.join(", ")),
        false,
    )
}

/// What the desktop's bar would show, in its order, without what it would hide.
fn items_of(bar: BarDto) -> Vec<ComputerItemView> {
    let mut items = Vec::new();
    let agents = &bar.agents;
    let doing = counts(&[
        (agents.waiting, "waiting on you"),
        (agents.working, "working"),
        (agents.finished, "finished"),
        (agents.idle, "idle"),
    ]);
    items.push(item(
        "agents",
        "Agents",
        if doing.is_empty() {
            "None running".to_owned()
        } else {
            doing
        },
        None,
        agents.waiting > 0,
    ));
    let relays = &bar.relays;
    let relay = counts(&[
        (relays.needs_you, "needs you"),
        (relays.running, "running"),
        (relays.paused, "paused"),
        (relays.scheduled, "scheduled"),
    ]);
    if !relay.is_empty() {
        items.push(item("relay", "Relay", relay, None, relays.needs_you > 0));
    }
    items.extend(bar.plans.into_iter().map(plan_item));
    items.extend(bar.runs.into_iter().map(run_item));
    if bar.window_open == Some(false) {
        items.push(item(
            "window",
            "Runs and plans",
            "No window open".to_owned(),
            Some("Open Runova on this computer to see them".to_owned()),
            false,
        ));
    }
    if bar.transfers > 0 {
        items.push(item(
            "transfers",
            "File transfers",
            format!("{} running", bar.transfers),
            None,
            false,
        ));
    }
    if bar.terminals > 0 {
        items.push(item(
            "terminals",
            "Terminals",
            format!("{} running", bar.terminals),
            None,
            false,
        ));
    }
    if let Some(sync) = &bar.sync {
        let (value, attention) = sync_label(sync);
        items.push(item("sync", "Cloud sync", value, None, attention));
    }
    if let Some(github) = bar.github {
        items.push(github_item(github));
    }
    if let Some(docker) = &bar.docker {
        items.push(item(
            "docker",
            "Docker",
            format!("{} running", docker.running),
            None,
            false,
        ));
    }
    if let Some(android) = &bar.android {
        items.push(item(
            "android",
            "Android emulators",
            format!("{} running", android.running),
            (android.booting > 0).then(|| format!("{} starting", android.booting)),
            false,
        ));
    }
    if let Some(keep_awake) = bar.keep_awake {
        items.push(keep_awake_item(keep_awake));
    }
    items
}

fn system_of(dto: SystemDto) -> SystemStatsView {
    SystemStatsView {
        cpu_percent: dto.cpu_percent,
        cpu_label: percent_label(dto.cpu_percent),
        cpu_detail: format!("{}, {} cores", dto.cpu_model, dto.cpu_core_count),
        mem_percent: dto.mem_percent,
        mem_label: format!(
            "{} of {}",
            bytes_label(dto.mem_used_bytes),
            bytes_label(dto.mem_total_bytes)
        ),
        net_down_label: format!("{}/s", bytes_label(dto.net_rx_bytes_per_sec)),
        net_up_label: format!("{}/s", bytes_label(dto.net_tx_bytes_per_sec)),
    }
}

fn limit_of(dto: LimitDto) -> LimitChipView {
    LimitChipView {
        state: match dto.state.as_str() {
            "ok" => LimitState::Ok,
            "estimate" => LimitState::Estimate,
            "stale" => LimitState::Stale,
            _ => LimitState::Unavailable,
        },
        provider_id: dto.provider_id,
        name: dto.name,
        plan: dto.plan,
        problem: dto.problem,
        windows: dto
            .windows
            .into_iter()
            .map(|w| LimitWindowView {
                percent_label: format!("{:.0}%", w.percent),
                resets_label: w.reset_in_ms.map(reset_label),
                label: w.label,
                percent: w.percent,
            })
            .collect(),
    }
}

fn provider_of(dto: ProviderDto) -> ProviderUsageView {
    ProviderUsageView {
        state: match dto.status.as_str() {
            "ok" => ProviderState::Ok,
            "connect" => ProviderState::Connect,
            _ => ProviderState::Error,
        },
        provider_id: dto.provider_id,
        name: dto.name,
        error: dto.error,
        today_label: dto.today_usd.map(usd_label),
        week_label: dto.week_usd.map(usd_label),
        month_label: dto.month_usd.map(usd_label),
        series: dto.series,
    }
}

impl Runner {
    pub(crate) fn refresh_status(&mut self) {
        let usage_due = self.ticks.is_multiple_of(USAGE_EVERY_TICKS);
        self.ticks = self.ticks.wrapping_add(1);
        self.view.status.loading = self.view.status.system.is_none();
        self.call(
            "status.system",
            None,
            |view: &mut AppView, dto: SystemDto| {
                view.status.system = Some(system_of(dto));
                view.status.loading = false;
            },
            |view| view.status.loading = false,
        );
        self.load_bar();
        if usage_due {
            self.call(
                "status.usage",
                None,
                |view: &mut AppView, dto: UsageDto| {
                    view.status.limits = dto.limits.into_iter().map(limit_of).collect();
                    view.status.providers = dto.providers.into_iter().map(provider_of).collect();
                },
                |_| {},
            );
        }
    }

    /// Goes around `call` because this list is extra: a computer too old to answer, or one source
    /// that fails, shouldn't put an error over numbers that are fine.
    fn load_bar(&mut self) {
        let Some(client) = self.client() else {
            return;
        };
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let Ok(value) = client.call("status.bar", None).await else {
                return;
            };
            let Ok(bar) = serde_json::from_value::<BarDto>(value) else {
                return;
            };
            let apply: Apply = Box::new(move |view| view.status.computer = items_of(bar));
            let _ = done.send(Done::Apply { attempt, apply });
        });
    }
}

#[uniffi::export]
impl Engine {
    pub fn open_usage_provider(&self, provider_id: String) {
        self.run(move |r| r.view.status.detail = Some(provider_id));
    }

    pub fn close_usage_provider(&self) {
        self.run(|r| r.view.status.detail = None);
    }
}
