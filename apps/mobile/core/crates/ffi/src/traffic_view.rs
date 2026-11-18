//! What the traffic screens show (E111). Re-exported from `view`, with the other screens.

/// The ranges the phone offers, as the desktop's presets without the custom one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum TrafficRange {
    Today,
    #[default]
    Week,
    Month,
    Quarter,
    Year,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum TrafficTab {
    #[default]
    Overview,
    Attacks,
    Blocked,
}

/// Which way a figure moved since the period before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TrafficTrend {
    Up,
    Down,
    Flat,
}

/// Whether that is good news: more visitors is, a higher bounce rate is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TrafficTone {
    Good,
    Bad,
    Neutral,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficChangeView {
    /// "+16%", "-4.5%", "No change" or "New".
    pub text: String,
    pub trend: TrafficTrend,
    pub tone: TrafficTone,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficKpiView {
    pub label: String,
    pub value: String,
    /// "about" before an estimate.
    pub prefix: Option<String>,
    pub change: Option<TrafficChangeView>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrafficPointView {
    /// Under the axis: "14:00", "18 Nov", "Nov 2026".
    pub axis: String,
    pub visitors: f64,
    pub page_views: f64,
    pub previous_visitors: Option<f64>,
    pub previous_page_views: Option<f64>,
    /// What a finger on this point reads out.
    pub readout: String,
    pub previous_readout: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrafficChartView {
    pub points: Vec<TrafficPointView>,
    /// The top of the scale, a round number above every value.
    pub max: f64,
    /// From the top of the scale down to 0.
    pub y_labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrafficRowView {
    pub label: String,
    pub value: String,
    /// Of the breakdown's total, from 0 to 1.
    pub share: f32,
    pub share_label: String,
    /// The country's flag, for a country.
    pub flag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrafficBreakdownView {
    pub dimension: String,
    pub title: String,
    /// What it counts: "page views", "visits", "requests".
    pub unit: String,
    pub rows: Vec<TrafficRowView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficRangeView {
    pub range: TrafficRange,
    pub label: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficSiteView {
    /// None for every site.
    pub id: Option<String>,
    pub label: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficGranularityView {
    pub value: String,
    pub label: String,
    pub enabled: bool,
    pub selected: bool,
    /// Why it cannot be picked.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficAttackView {
    pub id: i64,
    pub site_id: String,
    pub site: String,
    pub kind_label: String,
    pub address: String,
    pub country: Option<String>,
    pub flag: Option<String>,
    pub count_label: String,
    pub when_label: String,
    pub paths: Vec<String>,
    pub blocked: bool,
    /// An Admin may block it, and it is not blocked yet.
    pub can_block: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct TrafficAttacksView {
    pub loading: bool,
    pub problem: Option<String>,
    /// "2 addresses in the last 7 days, 1 blocked", or that there were none.
    pub summary: String,
    pub items: Vec<TrafficAttackView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficBlockedItemView {
    pub id: i64,
    pub network: String,
    pub reason: String,
    /// Who blocked it and when, on which site, and when it is lifted.
    pub detail: String,
    pub can_unblock: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct TrafficBlockedView {
    pub loading: bool,
    pub problem: Option<String>,
    pub items: Vec<TrafficBlockedItemView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrafficSettingsView {
    pub loading: bool,
    pub saving: bool,
    pub problem: Option<String>,
    pub statistics: bool,
    pub countries: bool,
    pub hourly_days: u32,
    pub hourly_choices: Vec<u32>,
    pub daily_days: u32,
    pub daily_choices: Vec<u32>,
    pub detection: bool,
    /// How auto-block stands; it is changed on the computer.
    pub auto_block: String,
    pub storage: String,
    /// Something changed since it was read.
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrafficDimensionView {
    pub dimension: String,
    pub title: String,
    pub loading: bool,
    pub problem: Option<String>,
    pub rows: Vec<TrafficRowView>,
    pub total_label: String,
    pub can_load_more: bool,
}

/// A Deploy server's website traffic and attacks, as the desktop's Traffic section has them.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrafficScreen {
    pub server_id: String,
    pub server_name: String,
    /// Nothing read yet.
    pub loading: bool,
    /// A new range or site is on its way; what is shown is the one before.
    pub refreshing: bool,
    pub problem: Option<String>,
    pub tab: TrafficTab,
    pub site_id: Option<String>,
    pub site_label: String,
    pub sites: Vec<TrafficSiteView>,
    pub range: TrafficRange,
    pub ranges: Vec<TrafficRangeView>,
    pub granularities: Vec<TrafficGranularityView>,
    /// An Admin or Owner: blocks and changes the settings.
    pub can_admin: bool,
    /// Statistics are off, and who can turn them on.
    pub off: Option<String>,
    /// Nothing counted in this range yet.
    pub empty: Option<String>,
    pub kpis: Vec<TrafficKpiView>,
    pub chart: Option<TrafficChartView>,
    pub breakdowns: Vec<TrafficBreakdownView>,
    pub devices: Option<TrafficBreakdownView>,
    pub countries: Option<TrafficBreakdownView>,
    /// "82% from Cloudflare, 18% from DB-IP".
    pub country_sources: Option<String>,
    pub attacks: TrafficAttacksView,
    pub blocked: TrafficBlockedView,
    pub settings: Option<TrafficSettingsView>,
    pub dimension: Option<TrafficDimensionView>,
}
