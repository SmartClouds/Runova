//! A Deploy server's website traffic and attacks (E111), as the desktop's Traffic section has them.
//! The computer works out each range in the report's time zone and names the buckets; this keeps
//! the range, the site and the tab, and writes every number the way the desktop does, so both apps
//! say the same thing. Blocking sends only an address; the computer checks it and the core writes
//! the nginx side. Auto-block and deleting statistics stay on the computer.

use crate::engine::{Engine, Runner};
use crate::labels::ago_label;
use crate::view::{
    ConfirmView, TrafficAttackView, TrafficAttacksView, TrafficBlockedItemView, TrafficBlockedView,
    TrafficBreakdownView, TrafficChangeView, TrafficChartView, TrafficDimensionView,
    TrafficGranularityView, TrafficKpiView, TrafficPointView, TrafficRange, TrafficRangeView,
    TrafficRowView, TrafficScreen, TrafficSettingsView, TrafficSiteView, TrafficTab, TrafficTone,
    TrafficTrend,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

/// Reports refresh once a minute, as on the desktop; the attack and blocked lists twice as often.
const REPORT_EVERY_TICKS: u32 = 15;
const LIST_EVERY_TICKS: u32 = 8;
const DIMENSION_PAGE: u32 = 50;
const HOURLY_CHOICES: [u32; 5] = [7, 30, 90, 180, 365];
const DAILY_CHOICES: [u32; 4] = [30, 365, 730, 1825];
/// A change smaller than this reads as no change at all.
const FLAT: f64 = 0.005;
const RANGES: [TrafficRange; 5] = [
    TrafficRange::Today,
    TrafficRange::Week,
    TrafficRange::Month,
    TrafficRange::Quarter,
    TrafficRange::Year,
];
const ALL_SITES: &str = "All websites";
const OFF_ADMIN: &str = "Turn them on in the settings and the server reads the access logs nginx already writes for each website. It reads a little every few seconds, so the sites do not slow down, and you can turn it off again at any time.";
const OFF_VIEWER: &str = "An Admin or Owner can turn traffic statistics on for this server.";
const EMPTY: &str = "Nothing in this range yet. Visits show up here within a minute of happening; statistics count from when they were turned on.";

#[derive(Default)]
pub(crate) struct TrafficState {
    report: Option<ReportDto>,
    granularity: Option<String>,
    /// Bumped by every new question, so the answer to an older one is dropped.
    asked: u64,
    status: Option<StatusDto>,
    dimension_offset: u32,
    /// Where a notification asked to go, before there was a computer to ask.
    pub(crate) pending: Option<(String, Option<String>)>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct TotalsDto {
    visitors: f64,
    visits: f64,
    page_views: f64,
    requests: f64,
    bot_requests: f64,
    bytes: f64,
    bounces: f64,
    visit_seconds: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PointDto {
    #[serde(default)]
    axis: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    visitors: f64,
    #[serde(default)]
    page_views: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreviousPointDto {
    #[serde(default)]
    visitors: f64,
    #[serde(default)]
    page_views: f64,
}

#[derive(Deserialize, Clone)]
struct ChoiceDto {
    value: String,
    label: String,
    #[serde(default)]
    enabled: bool,
    reason: Option<String>,
}

#[derive(Deserialize, Clone)]
struct SiteDto {
    id: String,
    label: String,
}

#[derive(Deserialize, Clone)]
struct CountDto {
    value: String,
    #[serde(default)]
    count: f64,
    name: Option<String>,
}

#[derive(Deserialize, Clone)]
struct BreakdownDto {
    dimension: String,
    #[serde(default)]
    total: f64,
    #[serde(default)]
    top: Vec<CountDto>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReportDto {
    role: Option<String>,
    granularity: String,
    #[serde(default)]
    granularities: Vec<ChoiceDto>,
    from_unix_ms: i64,
    to_unix_ms: i64,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    sites: Vec<SiteDto>,
    #[serde(default)]
    totals: TotalsDto,
    previous: Option<TotalsDto>,
    /// The period before started before statistics were counted, so there is nothing to compare.
    #[serde(default)]
    no_earlier_data: bool,
    #[serde(default)]
    series: Vec<PointDto>,
    /// None for the buckets of the period before that were not counted.
    #[serde(default)]
    previous_series: Vec<Option<PreviousPointDto>>,
    #[serde(default)]
    breakdowns: Vec<BreakdownDto>,
    country_sources: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PageDto {
    #[serde(default)]
    total: f64,
    #[serde(default)]
    total_items: u32,
    #[serde(default)]
    items: Vec<CountDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttackDto {
    id: i64,
    site_id: String,
    kind_label: String,
    address: String,
    country_name: Option<String>,
    country: Option<String>,
    last_seen: i64,
    #[serde(default)]
    count: u64,
    #[serde(default)]
    sample_paths: Vec<String>,
    #[serde(default)]
    blocked: bool,
}

#[derive(Deserialize)]
struct AttacksDto {
    #[serde(default)]
    events: Vec<AttackDto>,
    #[serde(default)]
    addresses: u32,
    #[serde(default)]
    blocked: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockedDto {
    id: i64,
    network: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    automatic: bool,
    created_at: i64,
    site_id: Option<String>,
    created_by: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatisticsDto {
    enabled: bool,
    countries: bool,
    hourly_retention_days: u32,
    daily_retention_days: u32,
}

#[derive(Deserialize, Clone)]
struct DetectionDto {
    enabled: bool,
}

#[derive(Deserialize, Clone)]
struct AutoBlockDto {
    enabled: bool,
    #[serde(default)]
    kinds: Vec<String>,
    #[serde(default)]
    minutes: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusDto {
    statistics: StatisticsDto,
    detection: DetectionDto,
    auto_block: AutoBlockDto,
    #[serde(default)]
    storage_bytes: f64,
}

#[derive(Deserialize)]
struct OkDto {
    #[serde(default)]
    message: String,
}

impl TrafficState {
    /// A fresh state that still knows where a notification asked to go.
    pub(crate) fn keeping_target(old: &mut TrafficState) -> Self {
        Self {
            pending: old.pending.take(),
            ..Self::default()
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

// ---- Numbers, written as the desktop's `trafficFormat` writes them ----

pub(crate) fn grouped(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if value < 0 { format!("-{out}") } else { out }
}

fn one_decimal(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.1}")
    }
}

/// In full under 10,000 (1,284) and short above (12.9K, 3.4M).
pub(crate) fn compact(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_owned();
    }
    let rounded = value.round();
    if rounded.abs() < 10_000.0 {
        return grouped(rounded as i64);
    }
    const UNITS: [(f64, &str); 4] = [(1e3, "K"), (1e6, "M"), (1e9, "B"), (1e12, "T")];
    let mut unit = UNITS
        .iter()
        .rposition(|(size, _)| rounded.abs() >= *size)
        .unwrap_or(0);
    let mut shown = (rounded / UNITS[unit].0 * 10.0).round() / 10.0;
    if shown.abs() >= 1000.0 && unit + 1 < UNITS.len() {
        unit += 1;
        shown = (rounded / UNITS[unit].0 * 10.0).round() / 10.0;
    }
    format!("{}{}", one_decimal(shown), UNITS[unit].1)
}

/// A share from 0 to 1 as a percentage, with a decimal only under 10%.
pub(crate) fn share_label(ratio: f64) -> String {
    if !ratio.is_finite() || ratio <= 0.0 {
        return "0%".to_owned();
    }
    let percent = ratio * 100.0;
    if percent < 10.0 {
        format!("{}%", one_decimal(percent))
    } else {
        format!("{}%", grouped(percent.round() as i64))
    }
}

pub(crate) fn bytes_label(bytes: f64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 B".to_owned();
    }
    let (mut value, mut unit) = (bytes, 0);
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        return format!("{} B", value.round());
    }
    let shown = if value < 10.0 {
        one_decimal(value)
    } else {
        format!("{}", value.round())
    };
    format!("{shown} {}", UNITS[unit])
}

pub(crate) fn duration_label(seconds: f64) -> String {
    let whole = seconds.round().max(0.0) as i64;
    if whole < 60 {
        format!("{whole}s")
    } else if whole < 3600 {
        format!("{}m {:02}s", whole / 60, whole % 60)
    } else {
        format!("{}h {:02}m", whole / 3600, (whole % 3600) / 60)
    }
}

/// The flag of a country from its ISO code, or None for Unknown, Tor and anything else.
pub(crate) fn flag(code: &str) -> Option<String> {
    let upper = code.to_ascii_uppercase();
    if upper.len() != 2 || upper == "XX" || !upper.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    upper
        .bytes()
        .map(|b| char::from_u32(0x1F1E6 + u32::from(b - b'A')))
        .collect()
}

/// A round number at or above `value`: 1, 2 or 5 times a power of ten.
pub(crate) fn nice_max(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return 1.0;
    }
    let power = 10f64.powf(value.log10().floor());
    [1.0, 2.0, 5.0, 10.0]
        .iter()
        .map(|step| step * power)
        .find(|top| *top >= value)
        .unwrap_or(10.0 * power)
}

fn change_of(current: f64, previous: f64, good_when_up: Option<bool>) -> TrafficChangeView {
    let (trend, text) = if previous == 0.0 {
        if current > 0.0 {
            (TrafficTrend::Up, "New".to_owned())
        } else {
            (TrafficTrend::Flat, "No change".to_owned())
        }
    } else {
        let ratio = (current - previous) / previous;
        if ratio.abs() < FLAT {
            (TrafficTrend::Flat, "No change".to_owned())
        } else {
            let sign = if ratio > 0.0 { '+' } else { '-' };
            let trend = if ratio > 0.0 {
                TrafficTrend::Up
            } else {
                TrafficTrend::Down
            };
            (trend, format!("{sign}{}", share_label(ratio.abs())))
        }
    };
    let tone = match (trend, good_when_up) {
        (TrafficTrend::Flat, _) | (_, None) => TrafficTone::Neutral,
        (TrafficTrend::Up, Some(good)) | (TrafficTrend::Down, Some(good))
            if (trend == TrafficTrend::Up) == good =>
        {
            TrafficTone::Good
        }
        _ => TrafficTone::Bad,
    };
    TrafficChangeView { text, trend, tone }
}

fn ratio(top: f64, bottom: f64) -> f64 {
    if bottom > 0.0 { top / bottom } else { 0.0 }
}

struct Kpi {
    label: &'static str,
    good_when_up: Option<bool>,
    of: fn(&TotalsDto) -> f64,
    format: fn(f64) -> String,
    about: bool,
}

const KPIS: [Kpi; 8] = [
    Kpi {
        label: "Unique visitors",
        good_when_up: Some(true),
        of: |t| t.visitors,
        format: compact,
        about: true,
    },
    Kpi {
        label: "Visits",
        good_when_up: Some(true),
        of: |t| t.visits,
        format: compact,
        about: false,
    },
    Kpi {
        label: "Page views",
        good_when_up: Some(true),
        of: |t| t.page_views,
        format: compact,
        about: false,
    },
    Kpi {
        label: "Bounce rate",
        good_when_up: Some(false),
        of: |t| ratio(t.bounces, t.visits),
        format: share_label,
        about: false,
    },
    Kpi {
        label: "Pages per visit",
        good_when_up: Some(true),
        of: |t| ratio(t.page_views, t.visits),
        format: |v| format!("{v:.1}"),
        about: false,
    },
    Kpi {
        label: "Visit length",
        good_when_up: Some(true),
        of: |t| ratio(t.visit_seconds, t.visits),
        format: duration_label,
        about: false,
    },
    Kpi {
        label: "Bandwidth",
        // More bandwidth is neither good nor bad news.
        good_when_up: None,
        of: |t| t.bytes,
        format: bytes_label,
        about: false,
    },
    Kpi {
        label: "Bot share",
        good_when_up: Some(false),
        of: |t| ratio(t.bot_requests, t.requests),
        format: share_label,
        about: false,
    },
];

fn kpis(report: &ReportDto) -> Vec<TrafficKpiView> {
    KPIS.iter()
        .map(|kpi| {
            let current = (kpi.of)(&report.totals);
            TrafficKpiView {
                label: kpi.label.to_owned(),
                value: (kpi.format)(current),
                prefix: kpi.about.then(|| "about".to_owned()),
                change: match &report.previous {
                    Some(p) => Some(change_of(current, (kpi.of)(p), kpi.good_when_up)),
                    None => report.no_earlier_data.then(|| TrafficChangeView {
                        text: "No earlier data".to_owned(),
                        trend: TrafficTrend::Flat,
                        tone: TrafficTone::Neutral,
                    }),
                },
            }
        })
        .collect()
}

fn counted(value: f64, one: &str, many: &str) -> String {
    let n = value.round() as i64;
    format!("{} {}", grouped(n), if n == 1 { one } else { many })
}

fn chart(report: &ReportDto) -> Option<TrafficChartView> {
    if report.series.is_empty() {
        return None;
    }
    let mut top: f64 = 0.0;
    let points = report
        .series
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let before = report.previous_series.get(i).and_then(Option::as_ref);
            top = top.max(p.visitors).max(p.page_views);
            if let Some(b) = before {
                top = top.max(b.visitors).max(b.page_views);
            }
            TrafficPointView {
                axis: p.axis.clone(),
                visitors: p.visitors,
                page_views: p.page_views,
                previous_visitors: before.map(|b| b.visitors),
                previous_page_views: before.map(|b| b.page_views),
                readout: format!(
                    "{}: {}, {}",
                    p.label,
                    counted(p.visitors, "visitor", "visitors"),
                    counted(p.page_views, "page view", "page views")
                ),
                previous_readout: before.map(|b| {
                    format!(
                        "Period before: {}, {}",
                        counted(b.visitors, "visitor", "visitors"),
                        counted(b.page_views, "page view", "page views")
                    )
                }),
            }
        })
        .collect();
    let max = nice_max(top);
    Some(TrafficChartView {
        points,
        max,
        y_labels: vec![compact(max), compact(max / 2.0), "0".to_owned()],
    })
}

fn dimension_title(dimension: &str) -> &str {
    match dimension {
        "page" => "Pages",
        "entryPage" => "Entry pages",
        "referrer" => "Referrers",
        "browser" => "Browsers",
        "operatingSystem" => "Operating systems",
        "device" => "Devices",
        "country" => "Countries",
        "city" => "Cities",
        "statusCode" => "Status codes",
        "bot" => "Bots",
        other => other,
    }
}

fn dimension_unit(dimension: &str) -> &str {
    match dimension {
        "entryPage" => "visits",
        "statusCode" => "requests",
        "bot" => "bot requests",
        _ => "page views",
    }
}

fn row_label(dimension: &str, count: &CountDto) -> String {
    match (dimension, count.value.as_str()) {
        ("country", value) => count.name.clone().unwrap_or_else(|| value.to_owned()),
        ("device", "desktop") => "Desktop".to_owned(),
        ("device", "mobile") => "Mobile".to_owned(),
        ("device", "tablet") => "Tablet".to_owned(),
        ("referrer", "") => "Direct or unknown".to_owned(),
        (_, "") => "Unknown".to_owned(),
        (_, value) => value.to_owned(),
    }
}

fn row(dimension: &str, count: &CountDto, total: f64) -> TrafficRowView {
    let share = ratio(count.count, total);
    TrafficRowView {
        label: row_label(dimension, count),
        value: compact(count.count),
        share: share as f32,
        share_label: share_label(share),
        flag: if dimension == "country" {
            flag(&count.value)
        } else {
            None
        },
    }
}

fn breakdown(b: &BreakdownDto) -> TrafficBreakdownView {
    TrafficBreakdownView {
        dimension: b.dimension.clone(),
        title: dimension_title(&b.dimension).to_owned(),
        unit: dimension_unit(&b.dimension).to_owned(),
        rows: b
            .top
            .iter()
            .map(|c| row(&b.dimension, c, b.total))
            .collect(),
    }
}

pub(crate) fn range_code(range: TrafficRange) -> &'static str {
    match range {
        TrafficRange::Today => "today",
        TrafficRange::Week => "7d",
        TrafficRange::Month => "30d",
        TrafficRange::Quarter => "90d",
        TrafficRange::Year => "12m",
    }
}

fn range_label(range: TrafficRange) -> &'static str {
    match range {
        TrafficRange::Today => "Today",
        TrafficRange::Week => "7 days",
        TrafficRange::Month => "30 days",
        TrafficRange::Quarter => "90 days",
        TrafficRange::Year => "12 months",
    }
}

fn kind_words(kind: &str) -> &str {
    match kind {
        "scan" => "scans",
        "bruteForce" => "password guessing",
        "flood" => "floods",
        "injection" => "injection probes",
        other => other,
    }
}

fn and_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn minutes_label(minutes: u32) -> String {
    if minutes >= 1440 && minutes.is_multiple_of(1440) {
        format!("{}d", minutes / 1440)
    } else if minutes >= 60 && minutes.is_multiple_of(60) {
        format!("{}h", minutes / 60)
    } else if minutes > 60 {
        format!("{}h {}m", minutes / 60, minutes % 60)
    } else {
        format!("{minutes}m")
    }
}

/// How long until a moment, in its biggest unit, counting a part as a whole.
fn in_label(ms: i64) -> String {
    let minutes = ((ms.max(0) + 59_999) / 60_000).max(1);
    let (days, hours) = (minutes / 1440, minutes / 60);
    if days > 0 {
        format!("{days}d")
    } else if hours > 0 {
        format!("{hours}h")
    } else {
        format!("{minutes}m")
    }
}

fn auto_block_text(auto: &AutoBlockDto) -> String {
    if !auto.enabled {
        return "Auto-block is off. An Owner can turn it on on the computer.".to_owned();
    }
    let kinds: Vec<&str> = auto.kinds.iter().map(|k| kind_words(k)).collect();
    let length = if auto.minutes == 0 {
        "for good".to_owned()
    } else {
        format!("for {}", minutes_label(auto.minutes))
    };
    format!(
        "Auto-block is on for {}, {length}. Change it on the computer.",
        and_list(&kinds)
    )
}

fn settings_view(status: &StatusDto) -> TrafficSettingsView {
    TrafficSettingsView {
        loading: false,
        saving: false,
        problem: None,
        statistics: status.statistics.enabled,
        countries: status.statistics.countries,
        hourly_days: status.statistics.hourly_retention_days,
        hourly_choices: HOURLY_CHOICES.to_vec(),
        daily_days: status.statistics.daily_retention_days,
        daily_choices: DAILY_CHOICES.to_vec(),
        detection: status.detection.enabled,
        auto_block: auto_block_text(&status.auto_block),
        storage: format!(
            "{} of statistics on the server",
            bytes_label(status.storage_bytes)
        ),
        dirty: false,
    }
}

impl Runner {
    fn traffic_server(&self) -> Option<String> {
        self.view
            .deploy
            .traffic
            .as_ref()
            .map(|t| t.server_id.clone())
    }

    fn traffic_site_label(&self, site: Option<&str>) -> String {
        let Some(site) = site else {
            return ALL_SITES.to_owned();
        };
        self.traffic
            .report
            .as_ref()
            .and_then(|r| r.sites.iter().find(|s| s.id == site))
            .map_or_else(|| site.to_owned(), |s| s.label.clone())
    }

    /// The server and site every question is about.
    fn traffic_params(&self) -> Option<Map<String, Value>> {
        let traffic = self.view.deploy.traffic.as_ref()?;
        let mut params = Map::new();
        params.insert("serverId".into(), Value::String(traffic.server_id.clone()));
        if let Some(site) = &traffic.site_id {
            params.insert("siteId".into(), Value::String(site.clone()));
        }
        Some(params)
    }

    pub(crate) fn open_traffic(&mut self, site: Option<String>, tab: TrafficTab) {
        let Some(server) = self.view.deploy.server.as_ref() else {
            return;
        };
        let (id, name) = (server.id.clone(), server.name.clone());
        self.traffic = TrafficState::keeping_target(&mut self.traffic);
        let site_label = site.clone().unwrap_or_else(|| ALL_SITES.to_owned());
        self.view.deploy.traffic = Some(TrafficScreen {
            server_id: id,
            server_name: name,
            loading: true,
            refreshing: false,
            problem: None,
            tab,
            site_id: site,
            site_label,
            sites: Vec::new(),
            range: TrafficRange::Week,
            ranges: Vec::new(),
            granularities: Vec::new(),
            can_admin: false,
            off: None,
            empty: None,
            kpis: Vec::new(),
            chart: None,
            breakdowns: Vec::new(),
            devices: None,
            countries: None,
            country_sources: None,
            attacks: TrafficAttacksView {
                loading: true,
                ..TrafficAttacksView::default()
            },
            blocked: TrafficBlockedView {
                loading: true,
                ..TrafficBlockedView::default()
            },
            settings: None,
            dimension: None,
        });
        self.redraw_traffic();
        self.tr_load_report();
        self.tr_load_tab();
    }

    pub(crate) fn refresh_traffic(&mut self) {
        let tick = self.ticks;
        self.ticks = self.ticks.wrapping_add(1);
        if tick == 0 {
            return;
        }
        if tick.is_multiple_of(REPORT_EVERY_TICKS) {
            self.tr_load_report();
        }
        if tick.is_multiple_of(LIST_EVERY_TICKS) {
            self.tr_load_tab();
        }
    }

    fn tr_load_tab(&mut self) {
        match self.view.deploy.traffic.as_ref().map(|t| t.tab) {
            Some(TrafficTab::Attacks) => self.tr_load_attacks(),
            Some(TrafficTab::Blocked) => self.tr_load_blocked(),
            _ => {}
        }
    }

    fn tr_load_report(&mut self) {
        let (Some(mut params), Some(range)) = (
            self.traffic_params(),
            self.view.deploy.traffic.as_ref().map(|t| t.range),
        ) else {
            return;
        };
        params.insert("range".into(), Value::String(range_code(range).to_owned()));
        if let Some(granularity) = &self.traffic.granularity {
            params.insert("granularity".into(), Value::String(granularity.clone()));
        }
        self.traffic.asked += 1;
        let asked = self.traffic.asked;
        self.cf(
            "deploy.traffic",
            Some(Value::Object(params)),
            move |r, result: Result<ReportDto, String>| {
                if r.traffic.asked != asked {
                    return;
                }
                match result {
                    Ok(report) => {
                        r.traffic.report = Some(report);
                        if let Some(view) = r.view.deploy.traffic.as_mut() {
                            view.problem = None;
                        }
                        r.redraw_traffic();
                    }
                    Err(problem) => {
                        if let Some(view) = r.view.deploy.traffic.as_mut() {
                            view.loading = false;
                            view.refreshing = false;
                            view.problem = Some(problem);
                        }
                    }
                }
            },
        );
    }

    fn redraw_traffic(&mut self) {
        let report = self.traffic.report.clone();
        let site_label = {
            let site = self
                .view
                .deploy
                .traffic
                .as_ref()
                .and_then(|t| t.site_id.clone());
            self.traffic_site_label(site.as_deref())
        };
        let Some(view) = self.view.deploy.traffic.as_mut() else {
            return;
        };
        view.site_label = site_label;
        view.ranges = RANGES
            .iter()
            .map(|r| TrafficRangeView {
                range: *r,
                label: range_label(*r).to_owned(),
                selected: *r == view.range,
            })
            .collect();
        let Some(report) = report else {
            return;
        };
        view.loading = false;
        view.refreshing = false;
        let role = report.role.as_deref().unwrap_or_default();
        view.can_admin = matches!(role, "owner" | "admin");
        view.sites = std::iter::once(TrafficSiteView {
            id: None,
            label: ALL_SITES.to_owned(),
            selected: view.site_id.is_none(),
        })
        .chain(report.sites.iter().map(|s| TrafficSiteView {
            id: Some(s.id.clone()),
            label: s.label.clone(),
            selected: view.site_id.as_deref() == Some(s.id.as_str()),
        }))
        .collect();
        view.granularities = report
            .granularities
            .iter()
            .map(|g| TrafficGranularityView {
                value: g.value.clone(),
                label: g.label.clone(),
                enabled: g.enabled,
                selected: g.value == report.granularity,
                reason: g.reason.clone(),
            })
            .collect();
        view.off = (!report.enabled).then(|| {
            if view.can_admin {
                OFF_ADMIN
            } else {
                OFF_VIEWER
            }
            .to_owned()
        });
        let t = &report.totals;
        view.empty =
            (report.enabled && t.page_views == 0.0 && t.visits == 0.0 && t.requests == 0.0)
                .then(|| EMPTY.to_owned());
        view.kpis = kpis(&report);
        view.chart = chart(&report);
        view.breakdowns = report
            .breakdowns
            .iter()
            .filter(|b| b.dimension != "device" && b.dimension != "country")
            .map(breakdown)
            .collect();
        view.devices = report
            .breakdowns
            .iter()
            .find(|b| b.dimension == "device")
            .map(breakdown);
        view.countries = report
            .breakdowns
            .iter()
            .find(|b| b.dimension == "country")
            .map(breakdown);
        view.country_sources = report.country_sources.clone();
    }

    fn tr_load_attacks(&mut self) {
        let Some(params) = self.traffic_params() else {
            return;
        };
        self.cf(
            "deploy.trafficAttacks",
            Some(Value::Object(params)),
            |r, result: Result<AttacksDto, String>| {
                let can_admin = r.view.deploy.traffic.as_ref().is_some_and(|t| t.can_admin);
                let now = now_ms();
                let sites: Vec<(String, String)> = r
                    .traffic
                    .report
                    .as_ref()
                    .map(|rep| {
                        rep.sites
                            .iter()
                            .map(|s| (s.id.clone(), s.label.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                let Some(view) = r.view.deploy.traffic.as_mut() else {
                    return;
                };
                let attacks = &mut view.attacks;
                attacks.loading = false;
                match result {
                    Ok(dto) => {
                        attacks.problem = None;
                        attacks.summary = if dto.addresses == 0 {
                            "No attacks in the last 7 days.".to_owned()
                        } else {
                            format!(
                                "{} {} in the last 7 days, {} blocked",
                                grouped(i64::from(dto.addresses)),
                                if dto.addresses == 1 {
                                    "address"
                                } else {
                                    "addresses"
                                },
                                grouped(i64::from(dto.blocked))
                            )
                        };
                        attacks.items = dto
                            .events
                            .into_iter()
                            .map(|e| TrafficAttackView {
                                site: sites
                                    .iter()
                                    .find(|(id, _)| *id == e.site_id)
                                    .map_or_else(|| e.site_id.clone(), |(_, label)| label.clone()),
                                flag: e.country.as_deref().and_then(flag),
                                count_label: counted(e.count as f64, "request", "requests"),
                                when_label: ago_label(now - e.last_seen),
                                can_block: can_admin && !e.blocked,
                                id: e.id,
                                site_id: e.site_id,
                                kind_label: e.kind_label,
                                address: e.address,
                                country: e.country_name,
                                paths: e.sample_paths,
                                blocked: e.blocked,
                            })
                            .collect();
                    }
                    Err(problem) => attacks.problem = Some(problem),
                }
            },
        );
    }

    fn tr_load_blocked(&mut self) {
        let Some(id) = self.traffic_server() else {
            return;
        };
        self.cf(
            "deploy.trafficBlocked",
            Some(json!({ "serverId": id })),
            |r, result: Result<Vec<BlockedDto>, String>| {
                let now = now_ms();
                let labels: Vec<(String, String)> = r
                    .traffic
                    .report
                    .as_ref()
                    .map(|rep| {
                        rep.sites
                            .iter()
                            .map(|s| (s.id.clone(), s.label.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                let Some(view) = r.view.deploy.traffic.as_mut() else {
                    return;
                };
                let can_admin = view.can_admin;
                let list = &mut view.blocked;
                list.loading = false;
                match result {
                    Ok(items) => {
                        list.problem = None;
                        list.items = items
                            .into_iter()
                            .map(|b| {
                                let who = if b.automatic {
                                    "Automatic".to_owned()
                                } else {
                                    b.created_by.as_ref().map_or_else(
                                        || "By hand".to_owned(),
                                        |by| format!("By {by}"),
                                    )
                                };
                                let site = b.site_id.as_ref().map_or_else(
                                    || "every site".to_owned(),
                                    |s| {
                                        let label = labels
                                            .iter()
                                            .find(|(id, _)| id == s)
                                            .map_or(s.as_str(), |(_, l)| l.as_str());
                                        format!("on {label}")
                                    },
                                );
                                let until = b.expires_at.map_or_else(
                                    || "For good.".to_owned(),
                                    |at| format!("Lifted in {}.", in_label(at - now)),
                                );
                                TrafficBlockedItemView {
                                    detail: format!(
                                        "{who}, {}, {site}. {until}",
                                        ago_label(now - b.created_at)
                                    ),
                                    id: b.id,
                                    network: b.network,
                                    reason: b.reason,
                                    can_unblock: can_admin,
                                }
                            })
                            .collect();
                    }
                    Err(problem) => list.problem = Some(problem),
                }
            },
        );
    }

    fn tr_after_block(&mut self) {
        self.tr_load_attacks();
        self.tr_load_blocked();
    }

    fn tr_block(&mut self, event_id: i64) {
        let Some(view) = self.view.deploy.traffic.as_ref() else {
            return;
        };
        let Some(event) = view
            .attacks
            .items
            .iter()
            .find(|e| e.id == event_id && e.can_block)
        else {
            return;
        };
        let (address, site) = (event.address.clone(), event.site_id.clone());
        let server = view.server_id.clone();
        self.ask(
            ConfirmView {
                title: format!("Block {address}?"),
                detail: format!(
                    "nginx will refuse {address} on every site on this server, answering nothing at all. Pending site changes are not applied. You can unblock it here at any time."
                ),
                action: "Block".to_owned(),
                danger: true,
            },
            move |runner| {
                runner.op(
                    "deploy.trafficBlock",
                    Some(json!({"serverId": server, "network": address, "siteId": site})),
                    Runner::tr_after_block,
                );
            },
        );
    }

    fn tr_unblock(&mut self, block_id: i64) {
        let Some(view) = self.view.deploy.traffic.as_ref() else {
            return;
        };
        let Some(item) = view
            .blocked
            .items
            .iter()
            .find(|b| b.id == block_id && b.can_unblock)
        else {
            return;
        };
        let network = item.network.clone();
        let server = view.server_id.clone();
        self.ask(
            ConfirmView {
                title: format!("Let {network} back in?"),
                detail: "nginx answers it again on every site within a few seconds.".to_owned(),
                action: "Unblock".to_owned(),
                danger: true,
            },
            move |runner| {
                runner.op(
                    "deploy.trafficUnblock",
                    Some(json!({"serverId": server, "blockId": block_id})),
                    Runner::tr_after_block,
                );
            },
        );
    }

    fn tr_set_range(&mut self, range: TrafficRange) {
        let Some(view) = self.view.deploy.traffic.as_mut() else {
            return;
        };
        view.range = range;
        view.refreshing = true;
        // A range picks its own bucket, as on the desktop.
        self.traffic.granularity = None;
        self.redraw_traffic();
        self.tr_load_report();
    }

    fn tr_set_site(&mut self, site: Option<String>) {
        let label = self.traffic_site_label(site.as_deref());
        let Some(view) = self.view.deploy.traffic.as_mut() else {
            return;
        };
        view.site_id = site;
        view.site_label = label;
        view.refreshing = true;
        self.redraw_traffic();
        self.tr_load_report();
        self.tr_load_tab();
    }

    fn tr_set_granularity(&mut self, value: String) {
        if let Some(view) = self.view.deploy.traffic.as_mut() {
            view.refreshing = true;
        }
        self.traffic.granularity = Some(value);
        self.tr_load_report();
    }

    fn tr_set_tab(&mut self, tab: TrafficTab) {
        let Some(view) = self.view.deploy.traffic.as_mut() else {
            return;
        };
        view.tab = tab;
        self.tr_load_tab();
    }

    fn tr_open_settings(&mut self) {
        let Some(id) = self.traffic_server() else {
            return;
        };
        if let Some(view) = self.view.deploy.traffic.as_mut() {
            view.settings = Some(TrafficSettingsView {
                loading: true,
                saving: false,
                problem: None,
                statistics: false,
                countries: false,
                hourly_days: 0,
                hourly_choices: HOURLY_CHOICES.to_vec(),
                daily_days: 0,
                daily_choices: DAILY_CHOICES.to_vec(),
                detection: false,
                auto_block: String::new(),
                storage: String::new(),
                dirty: false,
            });
        }
        self.cf(
            "deploy.trafficStatus",
            Some(json!({ "serverId": id })),
            |r, result: Result<StatusDto, String>| {
                let Some(settings) = r
                    .view
                    .deploy
                    .traffic
                    .as_mut()
                    .and_then(|t| t.settings.as_mut())
                else {
                    return;
                };
                match result {
                    Ok(status) => {
                        *settings = settings_view(&status);
                        r.traffic.status = Some(status);
                    }
                    Err(problem) => {
                        settings.loading = false;
                        settings.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn tr_edit_settings(&mut self, change: impl FnOnce(&mut TrafficSettingsView)) {
        if let Some(settings) = self
            .view
            .deploy
            .traffic
            .as_mut()
            .and_then(|t| t.settings.as_mut())
            .filter(|s| !s.loading && !s.saving)
        {
            change(settings);
            settings.dirty = true;
            settings.problem = None;
        }
    }

    fn tr_save_settings(&mut self) {
        let (Some(id), Some(status)) = (self.traffic_server(), self.traffic.status.clone()) else {
            return;
        };
        let Some(settings) = self
            .view
            .deploy
            .traffic
            .as_mut()
            .and_then(|t| t.settings.as_mut())
        else {
            return;
        };
        let was = &status.statistics;
        let mut statistics = Map::new();
        if settings.statistics != was.enabled {
            statistics.insert("enabled".into(), json!(settings.statistics));
        }
        if settings.countries != was.countries {
            statistics.insert("countries".into(), json!(settings.countries));
        }
        if settings.hourly_days != was.hourly_retention_days {
            statistics.insert("hourlyRetentionDays".into(), json!(settings.hourly_days));
        }
        if settings.daily_days != was.daily_retention_days {
            statistics.insert("dailyRetentionDays".into(), json!(settings.daily_days));
        }
        let mut params = Map::new();
        params.insert("serverId".into(), Value::String(id));
        if !statistics.is_empty() {
            params.insert("statistics".into(), Value::Object(statistics));
        }
        if settings.detection != status.detection.enabled {
            params.insert("detection".into(), json!({ "enabled": settings.detection }));
        }
        if params.len() == 1 {
            if let Some(view) = self.view.deploy.traffic.as_mut() {
                view.settings = None;
            }
            return;
        }
        settings.saving = true;
        self.cf(
            "deploy.trafficSaveSettings",
            Some(Value::Object(params)),
            |r, result: Result<OkDto, String>| match result {
                Ok(done) => {
                    r.view.notice = Some(done.message);
                    if let Some(view) = r.view.deploy.traffic.as_mut() {
                        view.settings = None;
                        view.refreshing = true;
                    }
                    r.tr_load_report();
                }
                Err(problem) => {
                    if let Some(settings) = r
                        .view
                        .deploy
                        .traffic
                        .as_mut()
                        .and_then(|t| t.settings.as_mut())
                    {
                        settings.saving = false;
                        settings.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn tr_open_dimension(&mut self, dimension: String) {
        let Some(view) = self.view.deploy.traffic.as_mut() else {
            return;
        };
        view.dimension = Some(TrafficDimensionView {
            title: dimension_title(&dimension).to_owned(),
            dimension,
            loading: true,
            problem: None,
            rows: Vec::new(),
            total_label: String::new(),
            can_load_more: false,
        });
        self.traffic.dimension_offset = 0;
        self.tr_load_dimension();
    }

    fn tr_more_dimension(&mut self) {
        let Some(dimension) = self
            .view
            .deploy
            .traffic
            .as_mut()
            .and_then(|t| t.dimension.as_mut())
            .filter(|d| d.can_load_more && !d.loading)
        else {
            return;
        };
        dimension.loading = true;
        self.traffic.dimension_offset += DIMENSION_PAGE;
        self.tr_load_dimension();
    }

    fn tr_load_dimension(&mut self) {
        let (Some(mut params), Some(report)) =
            (self.traffic_params(), self.traffic.report.as_ref())
        else {
            return;
        };
        let Some(dimension) = self
            .view
            .deploy
            .traffic
            .as_ref()
            .and_then(|t| t.dimension.as_ref())
            .map(|d| d.dimension.clone())
        else {
            return;
        };
        params.insert("fromUnixMs".into(), json!(report.from_unix_ms));
        params.insert("toUnixMs".into(), json!(report.to_unix_ms));
        params.insert("dimension".into(), Value::String(dimension.clone()));
        params.insert("offset".into(), json!(self.traffic.dimension_offset));
        let first = self.traffic.dimension_offset == 0;
        self.cf(
            "deploy.trafficDimension",
            Some(Value::Object(params)),
            move |r, result: Result<PageDto, String>| {
                let Some(view) = r
                    .view
                    .deploy
                    .traffic
                    .as_mut()
                    .and_then(|t| t.dimension.as_mut())
                    .filter(|d| d.dimension == dimension)
                else {
                    return;
                };
                view.loading = false;
                match result {
                    Ok(page) => {
                        let rows = page.items.iter().map(|c| row(&dimension, c, page.total));
                        if first {
                            view.rows = rows.collect();
                        } else {
                            view.rows.extend(rows);
                        }
                        view.total_label =
                            format!("{} in all", grouped(i64::from(page.total_items)));
                        view.can_load_more = (view.rows.len() as u32) < page.total_items;
                    }
                    Err(problem) => view.problem = Some(problem),
                }
            },
        );
    }
}

#[uniffi::export]
impl Engine {
    /// The open server's website traffic, every site, the last 7 days.
    pub fn deploy_open_traffic(&self) {
        self.run(|r| r.open_traffic(None, TrafficTab::Overview));
    }

    pub fn traffic_close(&self) {
        self.run(|r| {
            r.view.deploy.traffic = None;
            r.traffic = TrafficState::default();
        });
    }

    pub fn traffic_set_tab(&self, tab: TrafficTab) {
        self.run(move |r| r.tr_set_tab(tab));
    }

    pub fn traffic_set_range(&self, range: TrafficRange) {
        self.run(move |r| r.tr_set_range(range));
    }

    /// None for every site.
    pub fn traffic_set_site(&self, site_id: Option<String>) {
        self.run(move |r| r.tr_set_site(site_id));
    }

    pub fn traffic_set_granularity(&self, value: String) {
        self.run(move |r| r.tr_set_granularity(value));
    }

    /// Asks first, then blocks the attack's address on every site of the server.
    pub fn traffic_block(&self, event_id: i64) {
        self.run(move |r| r.tr_block(event_id));
    }

    pub fn traffic_unblock(&self, block_id: i64) {
        self.run(move |r| r.tr_unblock(block_id));
    }

    pub fn traffic_open_settings(&self) {
        self.run(Runner::tr_open_settings);
    }

    pub fn traffic_close_settings(&self) {
        self.run(|r| {
            if let Some(view) = r.view.deploy.traffic.as_mut() {
                view.settings = None;
            }
        });
    }

    pub fn traffic_settings_statistics(&self, on: bool) {
        self.run(move |r| r.tr_edit_settings(|s| s.statistics = on));
    }

    pub fn traffic_settings_countries(&self, on: bool) {
        self.run(move |r| r.tr_edit_settings(|s| s.countries = on));
    }

    pub fn traffic_settings_hourly(&self, days: u32) {
        self.run(move |r| r.tr_edit_settings(|s| s.hourly_days = days));
    }

    pub fn traffic_settings_daily(&self, days: u32) {
        self.run(move |r| r.tr_edit_settings(|s| s.daily_days = days));
    }

    pub fn traffic_settings_detection(&self, on: bool) {
        self.run(move |r| r.tr_edit_settings(|s| s.detection = on));
    }

    pub fn traffic_settings_save(&self) {
        self.run(Runner::tr_save_settings);
    }

    /// "See all" for one breakdown, a page at a time.
    pub fn traffic_open_dimension(&self, dimension: String) {
        self.run(move |r| r.tr_open_dimension(dimension));
    }

    pub fn traffic_dimension_more(&self) {
        self.run(Runner::tr_more_dimension);
    }

    pub fn traffic_close_dimension(&self) {
        self.run(|r| {
            if let Some(view) = r.view.deploy.traffic.as_mut() {
                view.dimension = None;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_read_in_full_under_ten_thousand_and_short_above() {
        assert_eq!(compact(0.0), "0");
        assert_eq!(compact(1284.0), "1,284");
        assert_eq!(compact(9_999.4), "9,999");
        assert_eq!(compact(10_000.0), "10K");
        assert_eq!(compact(12_900.0), "12.9K");
        assert_eq!(compact(999_960.0), "1M");
        assert_eq!(compact(3_420_000.0), "3.4M");
        assert_eq!(compact(f64::NAN), "0");
    }

    #[test]
    fn shares_bytes_and_durations_read_like_the_desktop() {
        assert_eq!(share_label(0.0), "0%");
        assert_eq!(share_label(0.045), "4.5%");
        assert_eq!(share_label(0.05), "5%");
        assert_eq!(share_label(0.42), "42%");
        assert_eq!(bytes_label(0.0), "0 B");
        assert_eq!(bytes_label(900.0), "900 B");
        assert_eq!(bytes_label(1536.0), "1.5 KB");
        assert_eq!(bytes_label(1024.0 * 1024.0 * 12.0), "12 MB");
        assert_eq!(duration_label(45.0), "45s");
        assert_eq!(duration_label(185.0), "3m 05s");
        assert_eq!(duration_label(3900.0), "1h 05m");
    }

    #[test]
    fn a_change_says_which_way_and_whether_that_is_good() {
        let up = change_of(116.0, 100.0, Some(true));
        assert_eq!(
            (up.text.as_str(), up.trend, up.tone),
            ("+16%", TrafficTrend::Up, TrafficTone::Good)
        );
        let worse = change_of(116.0, 100.0, Some(false));
        assert_eq!(worse.tone, TrafficTone::Bad);
        let down = change_of(95.5, 100.0, Some(true));
        assert_eq!((down.text.as_str(), down.tone), ("-4.5%", TrafficTone::Bad));
        assert_eq!(change_of(100.2, 100.0, Some(true)).text, "No change");
        assert_eq!(change_of(5.0, 0.0, Some(true)).text, "New");
        assert_eq!(change_of(0.0, 0.0, Some(true)).trend, TrafficTrend::Flat);
        assert_eq!(change_of(2.0, 1.0, None).tone, TrafficTone::Neutral);
    }

    #[test]
    fn countries_get_flags_and_the_rest_none() {
        assert_eq!(flag("us").as_deref(), Some("\u{1F1FA}\u{1F1F8}"));
        assert_eq!(flag("XX"), None);
        assert_eq!(flag("T1"), None);
        assert_eq!(flag("USA"), None);
    }

    #[test]
    fn the_scale_tops_out_at_a_round_number() {
        assert_eq!(nice_max(0.0), 1.0);
        assert_eq!(nice_max(7.0), 10.0);
        assert_eq!(nice_max(1500.0), 2000.0);
        assert_eq!(nice_max(4100.0), 5000.0);
        assert_eq!(nice_max(5000.0), 5000.0);
    }

    #[test]
    fn lengths_and_lists_read_as_people_say_them() {
        assert_eq!(minutes_label(45), "45m");
        assert_eq!(minutes_label(60), "1h");
        assert_eq!(minutes_label(90), "1h 30m");
        assert_eq!(minutes_label(2880), "2d");
        assert_eq!(in_label(3 * 3_600_000 - 5), "3h");
        assert_eq!(in_label(0), "1m");
        assert_eq!(and_list(&["a", "b", "c"]), "a, b and c");
        assert_eq!(grouped(-1_234_567), "-1,234,567");
    }
}
