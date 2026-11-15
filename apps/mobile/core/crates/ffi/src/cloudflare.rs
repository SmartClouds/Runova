//! Cloudflare through the computer (E98): its connected accounts and their domains, a domain's
//! quick switches and DNS records, adding a domain, and pointing one at a server. Everything goes
//! to the computer's own Cloudflare service; a token pasted here leaves only after the phone's own
//! check, and is wiped from memory once sent.

use crate::engine::{Done, Engine, Runner, Task};
use crate::view::{
    BiometricRequestView, CloudflareAccountView, CloudflareAddDomainView, CloudflareChoiceView,
    CloudflareDnsView, CloudflarePlannedChangeView, CloudflarePointDomainView,
    CloudflarePointPlanView, CloudflareRecordFormView, CloudflareRecordView, CloudflareScreen,
    CloudflareTab, CloudflareTogglesView, CloudflareTokenFormView, CloudflareTone,
    CloudflareZoneRow, CloudflareZoneView, ConfirmView, RecordDraft,
};
use runova_rpc::RpcError;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use zeroize::Zeroizing;

/// Cloudflare is read again every this many ticks while its screen is open.
const RELOAD_EVERY_TICKS: u32 = 8;
const UNREADABLE: &str = "This computer sent something this version of the app can't read.";
const NOT_CONFIRMED: &str = "Couldn't confirm it's you, so the token wasn't sent.";
const DEFAULT_LEVEL: &str = "medium";

/// What the screens don't show but the next step needs.
#[derive(Default)]
pub(crate) struct CloudflareState {
    zones: Vec<ZoneDto>,
    records: Vec<RecordDto>,
    settings: Option<SettingsDto>,
    pending_token: Option<PendingToken>,
    /// The security level before I'm Under Attack went on, per zone.
    level_before_attack: HashMap<String, String>,
    point_input: Option<Value>,
    point_server: String,
}

struct PendingToken {
    token: Zeroizing<String>,
    label: String,
    account_id: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountDto {
    id: String,
    label: String,
    #[serde(default)]
    locked: bool,
    state: Option<String>,
    #[serde(default)]
    missing: Vec<String>,
    #[serde(default)]
    unverified: Vec<String>,
}

#[derive(Deserialize)]
struct StatusDto {
    #[serde(default)]
    configured: bool,
    #[serde(default)]
    accounts: Vec<AccountDto>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ZoneDto {
    id: String,
    account_id: String,
    name: String,
    status: String,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    plan: String,
    #[serde(default)]
    name_servers: Vec<String>,
}

#[derive(Deserialize, Clone, Default)]
struct CaaDto {
    #[serde(default)]
    flags: u8,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    value: String,
}

#[derive(Deserialize, Clone, Default)]
struct SrvDto {
    #[serde(default)]
    priority: u32,
    #[serde(default)]
    weight: u32,
    #[serde(default)]
    port: u32,
    #[serde(default)]
    target: String,
}

#[derive(Deserialize, Clone)]
struct RecordDto {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    name: String,
    #[serde(default)]
    content: String,
    #[serde(default = "auto_ttl")]
    ttl: u32,
    #[serde(default)]
    proxied: bool,
    #[serde(default)]
    proxiable: bool,
    priority: Option<u32>,
    caa: Option<CaaDto>,
    srv: Option<SrvDto>,
    comment: Option<String>,
    #[serde(default)]
    editable: bool,
}

fn auto_ttl() -> u32 {
    1
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ValueSetting {
    value: Value,
    #[serde(default)]
    editable: bool,
    #[serde(default)]
    seconds_remaining: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SettingsDto {
    development_mode: ValueSetting,
    security_level: ValueSetting,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BotsDto {
    ai_bots: String,
}

#[derive(Deserialize)]
struct OkDto {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct ChoiceDto {
    id: String,
    name: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangeDto {
    action: String,
    #[serde(rename = "type")]
    kind: String,
    name: String,
    content: String,
    previous: Option<String>,
    reason: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanDto {
    zone_name: String,
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    changes: Vec<ChangeDto>,
    #[serde(default)]
    up_to_date: bool,
}

#[derive(Deserialize)]
struct PointResultDto {
    plan: PlanDto,
    applied: u32,
}

/// Why the pasted text cannot be a Cloudflare API token, the way the desktop says it.
fn token_problem(token: &str) -> Option<&'static str> {
    let global_key = token.len() == 37
        && token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    if token.is_empty() {
        Some("Paste the token Cloudflare showed you.")
    } else if global_key {
        Some(
            "That looks like your Global API Key, which can do anything on your account. Runova needs an API token limited to the permissions it asks for.",
        )
    } else if token.starts_with("v1.0-") {
        Some("That looks like an Origin CA Key. Runova needs an API token from the same page.")
    } else if token.chars().any(char::is_whitespace) {
        Some("A token has no spaces in it. Copy it again from Cloudflare.")
    } else if token.len() < 20 {
        Some("That is too short to be a Cloudflare API token.")
    } else if token.len() > 512 {
        Some("That is too long to be a Cloudflare API token.")
    } else if !token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        Some("That has characters a Cloudflare API token never has. Copy it again from Cloudflare.")
    } else {
        None
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn account_view(
    dto: &AccountDto,
    previous: Option<&CloudflareAccountView>,
) -> CloudflareAccountView {
    let (status_label, tone, detail) = if dto.locked {
        (
            "Locked".to_owned(),
            CloudflareTone::Warning,
            Some("Unlock Servers on this computer to use this account.".to_owned()),
        )
    } else {
        match dto.state.as_deref() {
            Some("active") if !dto.missing.is_empty() => (
                format!(
                    "Needs {}",
                    plural(dto.missing.len(), "permission", "permissions")
                ),
                CloudflareTone::Warning,
                Some("Add them to the token on Cloudflare, then check it again.".to_owned()),
            ),
            Some("active") => ("Connected".to_owned(), CloudflareTone::Good, None),
            Some("expired") => (
                "Expired".to_owned(),
                CloudflareTone::Bad,
                Some("Connect a new token for this account.".to_owned()),
            ),
            Some("disabled") => (
                "Turned off".to_owned(),
                CloudflareTone::Bad,
                Some("Turn the token back on in Cloudflare, or connect a new one.".to_owned()),
            ),
            _ => (
                "Not checked".to_owned(),
                CloudflareTone::Warning,
                Some("Check the token to see what it may do.".to_owned()),
            ),
        }
    };
    CloudflareAccountView {
        id: dto.id.clone(),
        label: dto.label.clone(),
        status_label,
        tone,
        detail,
        missing: dto.missing.clone(),
        unverified: dto.unverified.clone(),
        locked: dto.locked,
        zones: previous.map(|p| p.zones.clone()).unwrap_or_default(),
        zones_loading: previous.is_none_or(|p| p.zones_loading),
        zones_problem: previous.and_then(|p| p.zones_problem.clone()),
    }
}

fn usable(dto: &AccountDto) -> bool {
    !dto.locked && dto.state.as_deref() == Some("active")
}

fn zone_status(zone: &ZoneDto) -> String {
    if zone.paused {
        return "Paused".to_owned();
    }
    match zone.status.as_str() {
        "active" => "Active",
        "pending" => "Waiting for name servers",
        "initializing" => "Setting up",
        "moved" => "Moved away",
        other => other,
    }
    .to_owned()
}

fn zone_row(zone: &ZoneDto) -> CloudflareZoneRow {
    CloudflareZoneRow {
        id: zone.id.clone(),
        name: zone.name.clone(),
        status_label: zone_status(zone),
        active: zone.status == "active" && !zone.paused,
        plan: zone.plan.clone(),
    }
}

fn zone_view(zone: &ZoneDto) -> CloudflareZoneView {
    CloudflareZoneView {
        id: zone.id.clone(),
        name: zone.name.clone(),
        account_id: zone.account_id.clone(),
        status_label: zone_status(zone),
        active: zone.status == "active" && !zone.paused,
        pending: zone.status == "pending",
        plan: zone.plan.clone(),
        name_servers: zone.name_servers.clone(),
        tab: CloudflareTab::Dns,
        toggles: None,
        dns: CloudflareDnsView {
            loading: true,
            problem: None,
            records: Vec::new(),
        },
    }
}

/// "@" for the domain itself, else the part in front of it.
fn short_name(full: &str, zone: &str) -> String {
    if full == zone {
        "@".to_owned()
    } else {
        full.strip_suffix(&format!(".{zone}"))
            .unwrap_or(full)
            .to_owned()
    }
}

/// The full name from what was typed: "@", "www", or a full name in the domain.
fn full_name(typed: &str, zone: &str) -> String {
    let typed = typed.trim().to_lowercase();
    if typed.is_empty() || typed == "@" {
        return zone.to_owned();
    }
    let name = typed.strip_suffix('.').unwrap_or(&typed);
    if name == zone || name.ends_with(&format!(".{zone}")) {
        name.to_owned()
    } else {
        format!("{name}.{zone}")
    }
}

/// A TTL the way the desktop writes it.
fn ttl_label(ttl: u32) -> String {
    if ttl == 1 {
        "Auto".to_owned()
    } else if ttl.is_multiple_of(86_400) {
        if ttl == 86_400 {
            "1 day".to_owned()
        } else {
            format!("{} days", ttl / 86_400)
        }
    } else if ttl.is_multiple_of(3600) {
        format!("{} hr", ttl / 3600)
    } else if ttl.is_multiple_of(60) {
        format!("{} min", ttl / 60)
    } else {
        format!("{ttl} s")
    }
}

/// Development mode's time left: "3 h left", "2 h 15 min left", "40 min left".
fn remaining(seconds: u32) -> String {
    if seconds == 0 {
        return String::new();
    }
    let minutes = seconds.div_ceil(60);
    let (hours, rest) = (minutes / 60, minutes % 60);
    match (hours, rest) {
        (0, m) => format!("{m} min left"),
        (h, 0) => format!("{h} h left"),
        (h, m) => format!("{h} h {m} min left"),
    }
}

fn level_label(level: &str) -> &str {
    match level {
        "off" => "Off",
        "essentially_off" => "Essentially off",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "under_attack" => "I'm Under Attack",
        other => other,
    }
}

fn record_content(record: &RecordDto) -> String {
    match (record.kind.as_str(), &record.caa, &record.srv) {
        ("CAA", Some(caa), _) => format!("{} {} \"{}\"", caa.flags, caa.tag, caa.value),
        ("SRV", _, Some(srv)) => {
            format!(
                "{} {} {} {}",
                srv.priority, srv.weight, srv.port, srv.target
            )
        }
        _ => record.content.clone(),
    }
}

fn record_view(record: &RecordDto, zone: &str) -> CloudflareRecordView {
    CloudflareRecordView {
        id: record.id.clone(),
        record_type: record.kind.clone(),
        name: short_name(&record.name, zone),
        full_name: record.name.clone(),
        content: record_content(record),
        proxied: record.proxied,
        proxiable: record.proxiable,
        ttl_label: ttl_label(record.ttl),
        editable: record.editable,
        priority: if record.kind == "MX" {
            record.priority
        } else {
            None
        },
        comment: record.comment.clone().unwrap_or_default(),
    }
}

fn new_draft() -> RecordDraft {
    RecordDraft {
        record_type: "A".to_owned(),
        name: String::new(),
        content: String::new(),
        ttl: 1,
        proxied: true,
        priority: 10,
        comment: String::new(),
        caa_flags: 0,
        caa_tag: "issue".to_owned(),
        caa_value: String::new(),
        srv_priority: 0,
        srv_weight: 0,
        srv_port: 0,
        srv_target: String::new(),
    }
}

fn draft_of(record: &RecordDto, zone: &str) -> RecordDraft {
    let caa = record.caa.clone().unwrap_or_default();
    let srv = record.srv.clone().unwrap_or_default();
    RecordDraft {
        record_type: record.kind.clone(),
        name: short_name(&record.name, zone),
        content: record.content.clone(),
        ttl: record.ttl,
        proxied: record.proxied,
        priority: record.priority.unwrap_or(10),
        comment: record.comment.clone().unwrap_or_default(),
        caa_flags: caa.flags,
        caa_tag: if caa.tag.is_empty() {
            "issue".to_owned()
        } else {
            caa.tag
        },
        caa_value: caa.value,
        srv_priority: srv.priority,
        srv_weight: srv.weight,
        srv_port: srv.port,
        srv_target: srv.target,
    }
}

/// The record as the computer's record editor takes it, one shape per type.
fn record_input(draft: &RecordDraft, zone: &str) -> Value {
    let mut input = Map::new();
    input.insert("type".into(), json!(draft.record_type));
    input.insert("name".into(), json!(full_name(&draft.name, zone)));
    match draft.record_type.as_str() {
        "A" | "AAAA" | "CNAME" => {
            input.insert("content".into(), json!(draft.content.trim()));
            input.insert("proxied".into(), json!(draft.proxied));
        }
        "MX" => {
            input.insert("content".into(), json!(draft.content.trim()));
            input.insert("priority".into(), json!(draft.priority));
        }
        "CAA" => {
            input.insert(
                "caa".into(),
                json!({"flags": draft.caa_flags, "tag": draft.caa_tag, "value": draft.caa_value.trim()}),
            );
        }
        "SRV" => {
            input.insert(
                "srv".into(),
                json!({
                    "priority": draft.srv_priority,
                    "weight": draft.srv_weight,
                    "port": draft.srv_port,
                    "target": draft.srv_target.trim(),
                }),
            );
        }
        _ => {
            input.insert("content".into(), json!(draft.content));
        }
    }
    // A proxied record always uses the automatic TTL, as the desktop's editor sends it.
    let ttl = if draft.proxied && matches!(draft.record_type.as_str(), "A" | "AAAA" | "CNAME") {
        1
    } else {
        draft.ttl
    };
    input.insert("ttl".into(), json!(ttl));
    let comment = draft.comment.trim();
    if !comment.is_empty() {
        input.insert("comment".into(), json!(comment));
    }
    Value::Object(input)
}

fn toggles_of(
    settings: &SettingsDto,
    bots: Option<&BotsDto>,
    saving: bool,
) -> CloudflareTogglesView {
    let dev = settings.development_mode.value.as_str() == Some("on");
    let left = remaining(settings.development_mode.seconds_remaining);
    let ai = bots.map(|b| b.ai_bots.as_str());
    CloudflareTogglesView {
        dev_mode: dev,
        dev_mode_detail: match (dev, left.is_empty()) {
            (false, _) => "Off".to_owned(),
            (true, true) => "On".to_owned(),
            (true, false) => format!("On, {left}"),
        },
        dev_mode_editable: settings.development_mode.editable,
        under_attack: settings.security_level.value.as_str() == Some("under_attack"),
        under_attack_editable: settings.security_level.editable,
        ai_bots_blocked: matches!(ai, Some("block" | "only_on_ad_pages")),
        ai_bots_detail: match ai {
            Some("block") => "On, everywhere",
            Some("only_on_ad_pages") => "On, ad pages",
            _ => "Off",
        }
        .to_owned(),
        ai_bots_available: bots.is_some(),
        saving,
    }
}

fn plan_view(plan: &PlanDto, server: &str) -> CloudflarePointPlanView {
    let changes: Vec<CloudflarePlannedChangeView> = plan
        .changes
        .iter()
        .map(|change| {
            let (label, tone) = match change.action.as_str() {
                "create" => ("Add", CloudflareTone::Good),
                "update" => ("Change", CloudflareTone::Warning),
                "delete" => ("Remove", CloudflareTone::Bad),
                _ => ("Keep", CloudflareTone::Good),
            };
            CloudflarePlannedChangeView {
                action_label: label.to_owned(),
                tone,
                record_type: change.kind.clone(),
                name: short_name(&change.name, &plan.zone_name),
                content: change.content.clone(),
                previous: change.previous.clone(),
                reason: change.reason.as_deref().map(|reason| {
                    match reason {
                        "cname-conflict" => "A CNAME can't share its name with other records",
                        "other-address" => "It points somewhere else",
                        "tunnel" => "The server answers through its Cloudflare Tunnel",
                        other => other,
                    }
                    .to_owned()
                }),
            }
        })
        .collect();
    let count = changes.iter().filter(|c| c.action_label != "Keep").count();
    let names = plan.names.join(" and ");
    let summary = if plan.up_to_date {
        format!("{names} already point at {server}.")
    } else {
        format!(
            "{} to point {names} at {server}.",
            plural(count, "change", "changes")
        )
    };
    CloudflarePointPlanView {
        summary,
        changes,
        up_to_date: plan.up_to_date,
    }
}

fn asking(title: String, detail: String, action: &str) -> ConfirmView {
    ConfirmView {
        title,
        detail,
        action: action.to_owned(),
        danger: true,
    }
}

impl Runner {
    pub(crate) fn clear_cloudflare(&mut self) {
        self.view.cloudflare = CloudflareScreen::default();
        self.cloudflare = CloudflareState::default();
    }

    pub(crate) fn refresh_cloudflare(&mut self) {
        let due = self.ticks.is_multiple_of(RELOAD_EVERY_TICKS);
        self.ticks = self.ticks.wrapping_add(1);
        if !due {
            return;
        }
        if self.view.cloudflare.zone.is_some() {
            self.load_zone_data();
        } else {
            self.load_cloudflare_status();
        }
    }

    /// Calls the computer and hands the answer, or the refusal in words, to `done`. Work from a
    /// connection that has since ended is dropped.
    fn cf<T, F>(&mut self, method: &'static str, params: Option<Value>, done: F)
    where
        T: DeserializeOwned + Send + 'static,
        F: FnOnce(&mut Runner, Result<T, String>) + Send + 'static,
    {
        let Some(client) = self.client() else {
            return;
        };
        let attempt = self.attempt;
        let tx = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call(method, params).await;
            let task: Task = Box::new(move |runner| match outcome {
                Ok(value) => match serde_json::from_value::<T>(value) {
                    Ok(parsed) => done(runner, Ok(parsed)),
                    Err(_) => done(runner, Err(UNREADABLE.to_owned())),
                },
                Err(RpcError::Closed) => {}
                Err(error) => done(runner, Err(error.to_string())),
            });
            let _ = tx.send(Done::Run { attempt, task });
        });
    }

    fn load_cloudflare_status(&mut self) {
        let screen = &mut self.view.cloudflare;
        screen.loading = screen.accounts.is_empty() && !screen.configured;
        self.cf(
            "cloudflare.status",
            None,
            |r, result: Result<StatusDto, String>| {
                r.view.cloudflare.loading = false;
                match result {
                    Ok(status) => {
                        r.view.cloudflare.problem = None;
                        r.apply_status(status);
                    }
                    Err(problem) => r.view.cloudflare.problem = Some(problem),
                }
            },
        );
    }

    fn apply_status(&mut self, status: StatusDto) {
        let previous = std::mem::take(&mut self.view.cloudflare.accounts);
        self.view.cloudflare.configured = status.configured;
        self.view.cloudflare.accounts = status
            .accounts
            .iter()
            .map(|dto| {
                let before = previous.iter().find(|a| a.id == dto.id);
                let mut view = account_view(dto, before);
                if !usable(dto) {
                    view.zones.clear();
                    view.zones_loading = false;
                }
                view
            })
            .collect();
        let ids: Vec<String> = status.accounts.iter().map(|a| a.id.clone()).collect();
        self.cloudflare
            .zones
            .retain(|z| ids.contains(&z.account_id));
        for account in status.accounts.iter().filter(|a| usable(a)) {
            self.load_zones(account.id.clone());
        }
    }

    fn load_zones(&mut self, account_id: String) {
        let asked = account_id.clone();
        self.cf(
            "cloudflare.zones",
            Some(json!({ "accountId": account_id })),
            move |r, result: Result<Vec<ZoneDto>, String>| {
                let Some(account) = r
                    .view
                    .cloudflare
                    .accounts
                    .iter_mut()
                    .find(|a| a.id == asked)
                else {
                    return;
                };
                account.zones_loading = false;
                match result {
                    Ok(zones) => {
                        account.zones_problem = None;
                        account.zones = zones.iter().map(zone_row).collect();
                        r.cloudflare.zones.retain(|z| z.account_id != asked);
                        r.cloudflare.zones.extend(zones);
                    }
                    Err(problem) => account.zones_problem = Some(problem),
                }
            },
        );
    }

    fn zone_id(&self) -> Option<String> {
        self.view.cloudflare.zone.as_ref().map(|z| z.id.clone())
    }

    fn zone_name(&self) -> String {
        self.view
            .cloudflare
            .zone
            .as_ref()
            .map_or_else(String::new, |z| z.name.clone())
    }

    fn load_zone_data(&mut self) {
        self.load_records();
        self.load_toggles();
    }

    fn load_records(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let asked = zone.clone();
        self.cf(
            "cloudflare.records",
            Some(json!({ "zoneId": zone })),
            move |r, result: Result<Vec<RecordDto>, String>| {
                let name = r.zone_name();
                let Some(view) = r.view.cloudflare.zone.as_mut().filter(|z| z.id == asked) else {
                    return;
                };
                view.dns.loading = false;
                match result {
                    Ok(records) => {
                        view.dns.problem = None;
                        view.dns.records =
                            records.iter().map(|rec| record_view(rec, &name)).collect();
                        r.cloudflare.records = records;
                    }
                    Err(problem) => view.dns.problem = Some(problem),
                }
            },
        );
    }

    fn load_toggles(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let asked = zone.clone();
        self.cf(
            "cloudflare.zoneSettings",
            Some(json!({ "zoneId": zone.clone() })),
            move |r, result: Result<SettingsDto, String>| {
                if let Ok(settings) = result
                    && r.zone_id().as_deref() == Some(asked.as_str())
                {
                    r.cloudflare.settings = Some(settings);
                    r.show_toggles(None, false);
                }
            },
        );
        let asked = zone.clone();
        self.cf(
            "cloudflare.botSettings",
            Some(json!({ "zoneId": zone })),
            move |r, result: Result<BotsDto, String>| {
                if let Ok(bots) = result
                    && r.zone_id().as_deref() == Some(asked.as_str())
                {
                    r.show_toggles(Some(bots), false);
                }
            },
        );
    }

    /// Redraws the switches from the settings held, with new bot settings when there are some.
    fn show_toggles(&mut self, bots: Option<BotsDto>, saving: bool) {
        let Some(settings) = self.cloudflare.settings.clone() else {
            return;
        };
        let Some(zone) = self.view.cloudflare.zone.as_mut() else {
            return;
        };
        let before = zone.toggles.clone();
        let mut toggles = toggles_of(&settings, bots.as_ref(), saving);
        if bots.is_none()
            && let Some(before) = before
        {
            toggles.ai_bots_blocked = before.ai_bots_blocked;
            toggles.ai_bots_detail = before.ai_bots_detail;
            toggles.ai_bots_available = before.ai_bots_available;
        }
        zone.toggles = Some(toggles);
    }

    fn set_toggles_saving(&mut self, saving: bool) {
        if let Some(toggles) = self
            .view
            .cloudflare
            .zone
            .as_mut()
            .and_then(|z| z.toggles.as_mut())
        {
            toggles.saving = saving;
        }
    }

    fn change_setting(&mut self, change: Value, notice: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        self.set_toggles_saving(true);
        self.view.error = None;
        self.cf(
            "cloudflare.changeSetting",
            Some(json!({ "zoneId": zone, "change": change })),
            move |r, result: Result<SettingsDto, String>| {
                r.set_toggles_saving(false);
                match result {
                    Ok(settings) => {
                        r.cloudflare.settings = Some(settings);
                        r.show_toggles(None, false);
                        r.view.notice = Some(notice);
                    }
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn set_dev_mode(&mut self, on: bool) {
        let value = if on { "on" } else { "off" };
        let notice = if on {
            "Development mode is on for three hours."
        } else {
            "Development mode is off."
        };
        self.change_setting(
            json!({"setting": "developmentMode", "value": value}),
            notice.to_owned(),
        );
    }

    fn set_under_attack(&mut self, on: bool) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        if on {
            let current = self
                .cloudflare
                .settings
                .as_ref()
                .and_then(|s| s.security_level.value.as_str().map(str::to_owned))
                .filter(|level| level != "under_attack")
                .unwrap_or_else(|| DEFAULT_LEVEL.to_owned());
            self.cloudflare.level_before_attack.insert(zone, current);
            self.change_setting(
                json!({"setting": "securityLevel", "value": "under_attack"}),
                "I'm Under Attack is on. Every visitor gets a short check first.".to_owned(),
            );
        } else {
            let level = self
                .cloudflare
                .level_before_attack
                .remove(&zone)
                .unwrap_or_else(|| DEFAULT_LEVEL.to_owned());
            let notice = format!(
                "I'm Under Attack is off. Security level is {} again.",
                level_label(&level)
            );
            self.change_setting(json!({"setting": "securityLevel", "value": level}), notice);
        }
    }

    fn set_ai_bots_blocked(&mut self, on: bool) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        self.set_toggles_saving(true);
        self.view.error = None;
        let value = if on { "block" } else { "disabled" };
        self.cf(
            "cloudflare.changeBotSetting",
            Some(json!({"zoneId": zone, "change": {"setting": "aiBots", "value": value}})),
            move |r, result: Result<BotsDto, String>| {
                r.set_toggles_saving(false);
                match result {
                    Ok(bots) => {
                        r.show_toggles(Some(bots), false);
                        r.view.notice = Some(
                            if on {
                                "AI bots are blocked everywhere on this domain."
                            } else {
                                "AI bots can reach this domain again."
                            }
                            .to_owned(),
                        );
                    }
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn open_zone(&mut self, id: String) {
        let Some(zone) = self.cloudflare.zones.iter().find(|z| z.id == id).cloned() else {
            return;
        };
        self.cloudflare.records.clear();
        self.cloudflare.settings = None;
        self.view.cloudflare.zone = Some(zone_view(&zone));
        self.load_zone_data();
    }

    fn close_zone(&mut self) {
        self.view.cloudflare.zone = None;
        self.view.cloudflare.record_form = None;
        self.view.cloudflare.point_domain = None;
        self.cloudflare.records.clear();
        self.cloudflare.settings = None;
        self.load_cloudflare_status();
    }

    fn open_record_form(&mut self, record_id: Option<String>) {
        let zone = self.zone_name();
        let found = record_id
            .as_ref()
            .and_then(|id| self.cloudflare.records.iter().find(|r| &r.id == id));
        let draft = found.map_or_else(new_draft, |record| draft_of(record, &zone));
        let title = if found.is_some() {
            "Edit record"
        } else {
            "Add a record"
        };
        self.view.cloudflare.record_form = Some(CloudflareRecordFormView {
            record_id: found.map(|r| r.id.clone()),
            title: title.to_owned(),
            zone_name: zone,
            draft,
            problem: None,
            saving: false,
        });
    }

    fn save_record(&mut self, draft: RecordDraft) {
        let (Some(zone), Some(form)) = (self.zone_id(), self.view.cloudflare.record_form.as_mut())
        else {
            return;
        };
        form.saving = true;
        form.problem = None;
        form.draft = draft.clone();
        let record_id = form.record_id.clone();
        let input = record_input(&draft, &self.zone_name());
        let (method, params) = match &record_id {
            Some(id) => (
                "cloudflare.updateRecord",
                json!({"zoneId": zone, "recordId": id, "record": input}),
            ),
            None => (
                "cloudflare.createRecord",
                json!({"zoneId": zone, "record": input}),
            ),
        };
        self.cf(
            method,
            Some(params),
            move |r, result: Result<RecordDto, String>| match result {
                Ok(record) => {
                    r.view.cloudflare.record_form = None;
                    r.view.notice = Some(if record_id.is_some() {
                        format!("Saved {}.", record.name)
                    } else {
                        format!("Added {}.", record.name)
                    });
                    r.keep_record(record);
                }
                Err(problem) => {
                    if let Some(form) = r.view.cloudflare.record_form.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                    }
                }
            },
        );
    }

    /// Puts a record the computer sent back in the list, in place or at the end.
    fn keep_record(&mut self, record: RecordDto) {
        let name = self.zone_name();
        let view = record_view(&record, &name);
        match self
            .cloudflare
            .records
            .iter()
            .position(|r| r.id == record.id)
        {
            Some(index) => self.cloudflare.records[index] = record,
            None => self.cloudflare.records.push(record),
        }
        if let Some(zone) = self.view.cloudflare.zone.as_mut() {
            match zone.dns.records.iter().position(|r| r.id == view.id) {
                Some(index) => zone.dns.records[index] = view,
                None => zone.dns.records.push(view),
            }
        }
    }

    fn set_proxied(&mut self, id: String, proxied: bool) {
        let zone_name = self.zone_name();
        let (Some(zone), Some(record)) = (
            self.zone_id(),
            self.cloudflare.records.iter().find(|r| r.id == id).cloned(),
        ) else {
            return;
        };
        let mut draft = draft_of(&record, &zone_name);
        draft.proxied = proxied;
        let input = record_input(&draft, &zone_name);
        self.view.error = None;
        self.cf(
            "cloudflare.updateRecord",
            Some(json!({"zoneId": zone, "recordId": id, "record": input})),
            move |r, result: Result<RecordDto, String>| match result {
                Ok(record) => {
                    r.view.notice = Some(if proxied {
                        format!("{} goes through Cloudflare's proxy now.", record.name)
                    } else {
                        format!("{} goes straight to its server now.", record.name)
                    });
                    r.keep_record(record);
                }
                Err(problem) => r.view.error = Some(problem),
            },
        );
    }

    fn delete_record(&mut self, id: String) {
        let (Some(zone), Some(record)) = (
            self.zone_id(),
            self.cloudflare.records.iter().find(|r| r.id == id).cloned(),
        ) else {
            return;
        };
        let detail = format!(
            "The {} record {}, pointing at {}.",
            record.kind,
            record.name,
            record_content(&record)
        );
        self.ask(
            asking("Delete this record?".to_owned(), detail, "Delete"),
            move |runner| {
                runner.view.busy = true;
                let asked = id.clone();
                runner.cf(
                    "cloudflare.deleteRecord",
                    Some(json!({"zoneId": zone, "recordId": id})),
                    move |r, result: Result<OkDto, String>| {
                        r.view.busy = false;
                        match result {
                            Ok(done) => {
                                r.cloudflare.records.retain(|rec| rec.id != asked);
                                if let Some(zone) = r.view.cloudflare.zone.as_mut() {
                                    zone.dns.records.retain(|rec| rec.id != asked);
                                }
                                r.view.notice = Some(done.message);
                            }
                            Err(problem) => r.view.error = Some(problem),
                        }
                    },
                );
            },
        );
    }

    fn account_label(&self, id: &str) -> Option<String> {
        self.view
            .cloudflare
            .accounts
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.label.clone())
    }

    fn open_token_form(&mut self, account_id: Option<String>) {
        let account_label = account_id.as_deref().and_then(|id| self.account_label(id));
        self.cloudflare.pending_token = None;
        self.view.cloudflare.biometric = None;
        self.view.cloudflare.token_form = Some(CloudflareTokenFormView {
            account_id,
            account_label,
            problem: None,
            saving: false,
        });
    }

    fn save_token(&mut self, token: String, label: String) {
        let token = Zeroizing::new(token);
        let Some(form) = self.view.cloudflare.token_form.as_mut() else {
            return;
        };
        let trimmed = Zeroizing::new(token.trim().to_owned());
        if let Some(problem) = token_problem(&trimmed) {
            form.problem = Some(problem.to_owned());
            return;
        }
        form.problem = None;
        let reason = match &form.account_label {
            Some(label) => format!("Replace the Cloudflare token for {label}"),
            None => "Connect a Cloudflare account to this computer".to_owned(),
        };
        self.biometric_serial = self.biometric_serial.wrapping_add(1);
        self.view.cloudflare.biometric = Some(BiometricRequestView {
            id: self.biometric_serial,
            reason,
        });
        self.cloudflare.pending_token = Some(PendingToken {
            token: trimmed,
            label: label.trim().to_owned(),
            account_id: form.account_id.clone(),
        });
    }

    pub(crate) fn cloudflare_biometric_result(&mut self, id: u64, confirmed: bool) {
        if self.view.cloudflare.biometric.as_ref().map(|b| b.id) != Some(id) {
            return;
        }
        self.view.cloudflare.biometric = None;
        let pending = self.cloudflare.pending_token.take();
        let Some(form) = self.view.cloudflare.token_form.as_mut() else {
            return;
        };
        let Some(pending) = pending.filter(|_| confirmed) else {
            form.problem = Some(NOT_CONFIRMED.to_owned());
            return;
        };
        form.saving = true;
        let mut params = Map::new();
        params.insert("token".into(), json!(pending.token.as_str()));
        if !pending.label.is_empty() {
            params.insert("label".into(), json!(pending.label));
        }
        if let Some(account) = &pending.account_id {
            params.insert("accountId".into(), json!(account));
        }
        let replaced = form.account_label.clone();
        self.cf(
            "cloudflare.saveToken",
            Some(Value::Object(params)),
            move |r, result: Result<StatusDto, String>| match result {
                Ok(status) => {
                    r.view.cloudflare.token_form = None;
                    r.view.notice = Some(match replaced {
                        Some(label) => format!("Replaced the token for {label}."),
                        None => "Connected. The token is saved on this computer, not on the phone."
                            .to_owned(),
                    });
                    r.apply_status(status);
                }
                Err(problem) => {
                    if let Some(form) = r.view.cloudflare.token_form.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn token_status_op(&mut self, method: &'static str, account_id: String, notice: String) {
        self.view.busy = true;
        self.view.error = None;
        self.cf(
            method,
            Some(json!({ "accountId": account_id })),
            move |r, result: Result<StatusDto, String>| {
                r.view.busy = false;
                match result {
                    Ok(status) => {
                        r.view.notice = Some(notice);
                        r.apply_status(status);
                    }
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn check_token(&mut self, account_id: String) {
        let label = self.account_label(&account_id).unwrap_or_default();
        self.token_status_op(
            "cloudflare.checkToken",
            account_id,
            format!("Checked the token for {label}."),
        );
    }

    fn remove_token(&mut self, account_id: String) {
        let label = self.account_label(&account_id).unwrap_or_default();
        self.ask(
            asking(
                format!("Remove {label} from this computer?"),
                "Runova forgets its token. The domains stay on Cloudflare.".to_owned(),
                "Remove",
            ),
            move |runner| {
                runner.token_status_op(
                    "cloudflare.removeToken",
                    account_id,
                    format!("Removed {label}."),
                );
            },
        );
    }

    fn open_add_domain(&mut self, account_id: String) {
        self.view.cloudflare.add_domain = Some(CloudflareAddDomainView {
            account_id: account_id.clone(),
            choices: Vec::new(),
            loading: true,
            problem: None,
            saving: false,
        });
        self.cf(
            "cloudflare.accounts",
            Some(json!({ "accountId": account_id })),
            |r, result: Result<Vec<ChoiceDto>, String>| {
                let Some(form) = r.view.cloudflare.add_domain.as_mut() else {
                    return;
                };
                form.loading = false;
                match result {
                    Ok(choices) => {
                        form.choices = choices
                            .into_iter()
                            .map(|c| CloudflareChoiceView {
                                id: c.id,
                                name: c.name,
                            })
                            .collect();
                    }
                    Err(problem) => form.problem = Some(problem),
                }
            },
        );
    }

    fn add_domain(&mut self, name: String, cloudflare_account_id: String) {
        let Some(form) = self.view.cloudflare.add_domain.as_mut() else {
            return;
        };
        form.saving = true;
        form.problem = None;
        let account = form.account_id.clone();
        self.cf(
            "cloudflare.createZone",
            Some(json!({
                "accountId": account,
                "name": name.trim(),
                "cloudflareAccountId": cloudflare_account_id,
            })),
            move |r, result: Result<ZoneDto, String>| match result {
                Ok(zone) => {
                    r.view.cloudflare.add_domain = None;
                    if let Some(row) = r
                        .view
                        .cloudflare
                        .accounts
                        .iter_mut()
                        .find(|a| a.id == zone.account_id)
                    {
                        row.zones.retain(|z| z.id != zone.id);
                        row.zones.push(zone_row(&zone));
                    }
                    r.cloudflare.zones.retain(|z| z.id != zone.id);
                    r.view.notice = Some(format!(
                        "Added {}. Set its name servers at your registrar.",
                        zone.name
                    ));
                    let id = zone.id.clone();
                    r.cloudflare.zones.push(zone);
                    r.open_zone(id);
                }
                Err(problem) => {
                    if let Some(form) = r.view.cloudflare.add_domain.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn check_activation(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        self.view.busy = true;
        self.cf(
            "cloudflare.checkActivation",
            Some(json!({ "zoneId": zone })),
            |r, result: Result<OkDto, String>| {
                r.view.busy = false;
                match result {
                    Ok(done) => r.view.notice = Some(done.message),
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn open_point_domain(&mut self) {
        self.cloudflare.point_input = None;
        self.view.cloudflare.point_domain = Some(CloudflarePointDomainView {
            zone_name: self.zone_name(),
            servers: Vec::new(),
            loading: true,
            plan: None,
            problem: None,
            saving: false,
        });
        self.cf(
            "cloudflare.servers",
            None,
            |r, result: Result<Vec<ChoiceDto>, String>| {
                let Some(form) = r.view.cloudflare.point_domain.as_mut() else {
                    return;
                };
                form.loading = false;
                match result {
                    Ok(servers) => {
                        form.servers = servers
                            .into_iter()
                            .map(|s| CloudflareChoiceView {
                                id: s.id,
                                name: s.name,
                            })
                            .collect();
                    }
                    Err(problem) => form.problem = Some(problem),
                }
            },
        );
    }

    fn preview_point_domain(&mut self, name: String, server_id: String, www: bool, proxied: bool) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let Some(form) = self.view.cloudflare.point_domain.as_mut() else {
            return;
        };
        let server = form
            .servers
            .iter()
            .find(|s| s.id == server_id)
            .map_or_else(|| server_id.clone(), |s| s.name.clone());
        form.loading = true;
        form.problem = None;
        form.plan = None;
        let typed = name.trim();
        let input = json!({
            "zoneId": zone,
            "name": if typed.is_empty() { "@" } else { typed },
            "serverId": server_id,
            "includeWww": www,
            "proxied": proxied,
        });
        self.cloudflare.point_input = Some(input.clone());
        self.cloudflare.point_server = server.clone();
        self.cf(
            "cloudflare.planPointDomain",
            Some(input),
            move |r, result: Result<PlanDto, String>| {
                let Some(form) = r.view.cloudflare.point_domain.as_mut() else {
                    return;
                };
                form.loading = false;
                match result {
                    Ok(plan) => form.plan = Some(plan_view(&plan, &server)),
                    Err(problem) => form.problem = Some(problem),
                }
            },
        );
    }

    fn apply_point_domain(&mut self) {
        let Some(input) = self.cloudflare.point_input.clone() else {
            return;
        };
        let Some(form) = self.view.cloudflare.point_domain.as_mut() else {
            return;
        };
        form.saving = true;
        form.problem = None;
        let server = self.cloudflare.point_server.clone();
        self.cf(
            "cloudflare.pointDomain",
            Some(input),
            move |r, result: Result<PointResultDto, String>| match result {
                Ok(done) => {
                    r.view.cloudflare.point_domain = None;
                    let target = done
                        .plan
                        .names
                        .first()
                        .cloned()
                        .unwrap_or(done.plan.zone_name);
                    r.view.notice = Some(format!(
                        "{target} points at {server} now. {} changed.",
                        plural(done.applied as usize, "record", "records")
                    ));
                    r.load_records();
                }
                Err(problem) => {
                    if let Some(form) = r.view.cloudflare.point_domain.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                    }
                }
            },
        );
    }
}

#[uniffi::export]
impl Engine {
    pub fn cloudflare_open_zone(&self, id: String) {
        self.run(move |r| r.open_zone(id));
    }

    pub fn cloudflare_close_zone(&self) {
        self.run(Runner::close_zone);
    }

    pub fn cloudflare_set_dev_mode(&self, on: bool) {
        self.run(move |r| r.set_dev_mode(on));
    }

    pub fn cloudflare_set_under_attack(&self, on: bool) {
        self.run(move |r| r.set_under_attack(on));
    }

    pub fn cloudflare_set_ai_bots_blocked(&self, on: bool) {
        self.run(move |r| r.set_ai_bots_blocked(on));
    }

    pub fn cloudflare_new_record(&self) {
        self.run(|r| r.open_record_form(None));
    }

    pub fn cloudflare_edit_record(&self, id: String) {
        self.run(move |r| r.open_record_form(Some(id)));
    }

    pub fn cloudflare_close_record_form(&self) {
        self.run(|r| r.view.cloudflare.record_form = None);
    }

    pub fn cloudflare_save_record(&self, draft: RecordDraft) {
        self.run(move |r| r.save_record(draft));
    }

    pub fn cloudflare_set_proxied(&self, id: String, proxied: bool) {
        self.run(move |r| r.set_proxied(id, proxied));
    }

    pub fn cloudflare_delete_record(&self, id: String) {
        self.run(move |r| r.delete_record(id));
    }

    pub fn cloudflare_open_token_form(&self, account_id: Option<String>) {
        self.run(move |r| r.open_token_form(account_id));
    }

    pub fn cloudflare_close_token_form(&self) {
        self.run(|r| {
            r.view.cloudflare.token_form = None;
            r.view.cloudflare.biometric = None;
            r.cloudflare.pending_token = None;
        });
    }

    /// The token is checked on the phone first, then waits for the phone's own check.
    pub fn cloudflare_save_token(&self, token: String, label: String) {
        self.run(move |r| r.save_token(token, label));
    }

    pub fn cloudflare_check_token(&self, account_id: String) {
        self.run(move |r| r.check_token(account_id));
    }

    pub fn cloudflare_remove_token(&self, account_id: String) {
        self.run(move |r| r.remove_token(account_id));
    }

    pub fn cloudflare_open_add_domain(&self, account_id: String) {
        self.run(move |r| r.open_add_domain(account_id));
    }

    pub fn cloudflare_close_add_domain(&self) {
        self.run(|r| r.view.cloudflare.add_domain = None);
    }

    pub fn cloudflare_add_domain(&self, name: String, cloudflare_account_id: String) {
        self.run(move |r| r.add_domain(name, cloudflare_account_id));
    }

    pub fn cloudflare_check_activation(&self) {
        self.run(Runner::check_activation);
    }

    pub fn cloudflare_open_point_domain(&self) {
        self.run(Runner::open_point_domain);
    }

    pub fn cloudflare_close_point_domain(&self) {
        self.run(|r| {
            r.view.cloudflare.point_domain = None;
            r.cloudflare.point_input = None;
        });
    }

    pub fn cloudflare_preview_point_domain(
        &self,
        name: String,
        server_id: String,
        include_www: bool,
        proxied: bool,
    ) {
        self.run(move |r| r.preview_point_domain(name, server_id, include_www, proxied));
    }

    pub fn cloudflare_apply_point_domain(&self) {
        self.run(Runner::apply_point_domain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_shortened_and_filled_in_against_the_domain() {
        assert_eq!(short_name("example.com", "example.com"), "@");
        assert_eq!(short_name("app.example.com", "example.com"), "app");
        assert_eq!(short_name("other.org", "example.com"), "other.org");
        assert_eq!(full_name(" @ ", "example.com"), "example.com");
        assert_eq!(full_name("", "example.com"), "example.com");
        assert_eq!(full_name("WWW", "example.com"), "www.example.com");
        assert_eq!(
            full_name("app.example.com.", "example.com"),
            "app.example.com"
        );
    }

    #[test]
    fn ttls_and_time_left_read_like_the_desktop() {
        assert_eq!(ttl_label(1), "Auto");
        assert_eq!(ttl_label(120), "2 min");
        assert_eq!(ttl_label(7200), "2 hr");
        assert_eq!(ttl_label(86_400), "1 day");
        assert_eq!(ttl_label(172_800), "2 days");
        assert_eq!(ttl_label(90), "90 s");
        assert_eq!(remaining(0), "");
        assert_eq!(remaining(10_800), "3 h left");
        assert_eq!(remaining(8100), "2 h 15 min left");
        assert_eq!(remaining(61), "2 min left");
    }

    #[test]
    fn a_token_is_checked_the_way_the_desktop_checks_it() {
        assert!(token_problem("Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M").is_none());
        assert!(token_problem("").is_some());
        assert!(token_problem("short").unwrap().contains("too short"));
        assert!(
            token_problem("0123456789abcdef0123456789abcdef01234")
                .unwrap()
                .contains("Global API Key")
        );
        assert!(
            token_problem("v1.0-abcdefghijklmnopqrstuvwxyz")
                .unwrap()
                .contains("Origin CA")
        );
        assert!(
            token_problem("has a space in it, sadly")
                .unwrap()
                .contains("no spaces")
        );
        assert!(
            token_problem(&"x".repeat(513))
                .unwrap()
                .contains("too long")
        );
        assert!(
            token_problem("abcdefghijklmnopqrstuvwxyzé")
                .unwrap()
                .contains("characters")
        );
    }

    #[test]
    fn a_proxied_record_always_goes_with_the_automatic_ttl() {
        let mut draft = new_draft();
        draft.name = "app".into();
        draft.content = "203.0.113.1".into();
        draft.ttl = 300;
        assert_eq!(record_input(&draft, "example.com")["ttl"], json!(1));
        draft.proxied = false;
        assert_eq!(record_input(&draft, "example.com")["ttl"], json!(300));
    }
}
