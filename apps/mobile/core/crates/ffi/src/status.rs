//! What the desktop's status bar shows. The computer's numbers refresh often, AI usage rarely.

use crate::engine::{Engine, Runner};
use crate::labels::{bytes_label, percent_label, reset_label, usd_label};
use crate::view::{
    AppView, LimitChipView, LimitState, LimitWindowView, ProviderState, ProviderUsageView,
    SystemStatsView,
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
