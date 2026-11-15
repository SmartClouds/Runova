//! A domain's Access tab (E100): the email code gate on each of its names (Cloudflare Access with
//! the one-time PIN login), and the names and paths only listed addresses can open. People and
//! addresses are read here the way the desktop reads them, so a list typed or pasted on the phone
//! means the same as on the computer.

use super::{OkDto, asking};
use crate::engine::{Engine, Runner};
use crate::view::{
    CloudflareEmailGateFormView, CloudflareGateHostView, CloudflareGateState,
    CloudflareIpLimitFormView, CloudflareIpLimitView, CloudflareOptionView, CloudflarePersonView,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::net::IpAddr;

/// Kept well under what one Access policy holds, as on the desktop.
const MAX_PEOPLE: usize = 100;
const MAX_ADDRESSES: usize = 100;
const MAX_PATH: usize = 512;
const EVERY_NAME: &str = "*";
const DEFAULT_SESSION: &str = "24h";
const NOT_PERSON: &str =
    "Type an email address, or a domain like @company.com to let in everyone there.";
const NOT_ADDRESS: &str = "This is not an IP address or a range like 203.0.113.0/24.";

const SESSIONS: [(&str, &str, &str); 5] = [
    ("30m", "30 min", "30 minutes"),
    ("6h", "6 hours", "6 hours"),
    ("24h", "24 hours", "24 hours"),
    ("168h", "7 days", "7 days"),
    ("720h", "30 days", "30 days"),
];

/// What the Access tab needs that the screens do not show.
#[derive(Default)]
pub(super) struct AccessState {
    hosts: Vec<HostDto>,
    limits: Vec<IpLimitDto>,
    public_ip: Option<String>,
    /// The people of the last gate saved, to start the next new one from.
    last_people: Option<(Vec<String>, Vec<String>)>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReadinessDto {
    #[serde(default)]
    organization: bool,
    team_domain: Option<String>,
    #[serde(default)]
    one_time_pin: bool,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GateDto {
    kind: String,
    #[serde(default)]
    emails: Vec<String>,
    #[serde(default)]
    email_domains: Vec<String>,
    #[serde(default)]
    session: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostDto {
    hostname: String,
    #[serde(default)]
    proxied: bool,
    record_id: Option<String>,
    #[serde(default)]
    role: String,
    site_name: Option<String>,
    gate: GateDto,
    #[serde(default)]
    this_computer_pass: bool,
}

#[derive(Deserialize)]
struct PlanDto {
    readiness: ReadinessDto,
    #[serde(default)]
    hosts: Vec<HostDto>,
}

#[derive(Deserialize, Clone)]
struct IpLimitDto {
    id: String,
    #[serde(default = "yes")]
    enabled: bool,
    hostname: Option<String>,
    path: Option<String>,
    #[serde(rename = "match", default = "prefix_match")]
    matching: String,
    #[serde(default)]
    ips: Vec<String>,
}

#[derive(Deserialize)]
struct AddressDto {
    ip: Option<String>,
}

fn yes() -> bool {
    true
}

fn prefix_match() -> String {
    "prefix".to_owned()
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn session_words(session: &str) -> &str {
    SESSIONS
        .iter()
        .find(|(value, ..)| *value == session)
        .map_or(session, |(_, _, words)| words)
}

fn is_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

fn is_domain(text: &str) -> bool {
    let labels: Vec<&str> = text.split('.').collect();
    let Some(last) = labels.last() else {
        return false;
    };
    labels.len() >= 2
        && labels.iter().all(|l| is_label(l))
        && (2..=63).contains(&last.len())
        && last.bytes().all(|b| b.is_ascii_lowercase())
}

fn is_email(text: &str) -> bool {
    let Some(at) = text.rfind('@') else {
        return false;
    };
    let local = &text[..at];
    at > 0
        && text.find('@') == Some(at)
        && local.len() <= 64
        && local.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$%&'*+/=?^_`{|}~.-".contains(&b)
        })
        && is_domain(&text[at + 1..])
}

enum Entry {
    Email(String),
    Domain(String),
    Invalid(String, String),
}

/// One typed or pasted entry: an address, a whole domain (with or without @), or why neither.
fn person(raw: &str) -> Entry {
    let typed = raw.trim();
    let value = typed.to_lowercase();
    if value.contains('@') && !value.starts_with('@') {
        return if is_email(&value) {
            Entry::Email(value)
        } else {
            Entry::Invalid(typed.to_owned(), "This is not an email address.".to_owned())
        };
    }
    let domain = value.trim_start_matches('@');
    if is_domain(domain) {
        Entry::Domain(domain.to_owned())
    } else {
        Entry::Invalid(typed.to_owned(), NOT_PERSON.to_owned())
    }
}

/// Pasted text split on commas, semicolons, spaces and new lines. A "Name <address>" entry from a
/// mail app gives its address, and a display name never holds an @, so a bare address next to one
/// still counts on its own.
fn people(text: &str) -> Vec<Entry> {
    let mut pieces: Vec<String> = Vec::new();
    for part in text.split([',', ';', '\n']) {
        let mut rest = part;
        while let Some(open) = rest.find('<') {
            let Some(close) = rest[open..].find('>') else {
                break;
            };
            for word in rest[..open].split_whitespace() {
                if word.contains('@') {
                    pieces.push(word.to_owned());
                }
            }
            pieces.push(rest[open + 1..open + close].to_owned());
            rest = &rest[open + close + 1..];
        }
        pieces.extend(rest.split_whitespace().map(str::to_owned));
    }
    pieces
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| person(p))
        .collect()
}

/// An address in the spelling Cloudflare uses, or a range that starts at its own first address.
fn address(text: &str) -> Result<String, String> {
    if let Ok(ip) = text.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let Some((host, bits)) = text.split_once('/') else {
        return Err(NOT_ADDRESS.to_owned());
    };
    let not_range = format!("{text} is not a range like 203.0.113.0/24.");
    let (Ok(ip), true) = (
        host.parse::<IpAddr>(),
        !bits.is_empty()
            && bits.len() <= 3
            && bits.bytes().all(|b| b.is_ascii_digit())
            && (bits == "0" || !bits.starts_with('0')),
    ) else {
        return Err(not_range);
    };
    let prefix: u32 = bits.parse().map_err(|_| not_range.clone())?;
    let (max, version) = if ip.is_ipv4() { (32, 4) } else { (128, 6) };
    if prefix > max {
        return Err(format!("IPv{version} ranges go up to /{max}."));
    }
    let network = masked(ip, prefix);
    if network != ip {
        return Err(format!(
            "{text} is not the start of its range. Use {network}/{prefix}."
        ));
    }
    Ok(format!("{network}/{prefix}"))
}

fn masked(ip: IpAddr, prefix: u32) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => {
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            IpAddr::V4((u32::from(v4) & mask).into())
        }
        IpAddr::V6(v6) => {
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            IpAddr::V6((u128::from(v6) & mask).into())
        }
    }
}

/// Whether an address is one of the list, or inside one of its ranges. IPv4 never matches IPv6.
fn address_in_list(ip: &str, list: &[String]) -> bool {
    let Ok(ip) = ip.parse::<IpAddr>() else {
        return false;
    };
    list.iter().any(|entry| {
        let (host, prefix) = entry
            .split_once('/')
            .map_or((entry.as_str(), None), |(h, p)| (h, p.parse::<u32>().ok()));
        let Ok(other) = host.parse::<IpAddr>() else {
            return false;
        };
        if ip.is_ipv4() != other.is_ipv4() {
            return false;
        }
        let bits = prefix.unwrap_or(if ip.is_ipv4() { 32 } else { 128 });
        masked(ip, bits) == masked(other, bits)
    })
}

/// Why a path cannot go into a rule, or None when it can.
fn path_problem(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return Some("A path starts with a slash, like /wp-login.php.".to_owned());
    }
    if path.len() > MAX_PATH {
        return Some(format!("Keep the path under {MAX_PATH} characters."));
    }
    let bad = path
        .chars()
        .any(|c| (c as u32) <= 0x20 || c as u32 == 0x7f || c == '"' || c == '\\');
    bad.then(|| "A path cannot hold spaces, quotes or backslashes.".to_owned())
}

/// "app.example.com/admin and below", or "every name in example.com".
fn limit_target(hostname: Option<&str>, path: Option<&str>, prefix: bool, zone: &str) -> String {
    let path = path.map_or_else(String::new, |p| {
        format!("{p}{}", if prefix { " and below" } else { "" })
    });
    match hostname {
        None => {
            let everywhere = format!("every name in {zone}");
            if path.is_empty() {
                everywhere
            } else {
                format!("{path}, on {everywhere}")
            }
        }
        Some(name) => format!("{name}{path}"),
    }
}

fn limit_view(limit: &IpLimitDto, zone: &str) -> CloudflareIpLimitView {
    CloudflareIpLimitView {
        id: limit.id.clone(),
        target: limit_target(
            limit.hostname.as_deref(),
            limit.path.as_deref(),
            limit.matching == "prefix",
            zone,
        ),
        ips: limit.ips.clone(),
        enabled: limit.enabled,
    }
}

fn gate_summary(gate: &GateDto) -> String {
    format!(
        "Email code, {}, {}",
        plural(
            gate.emails.len() + gate.email_domains.len(),
            "person",
            "people"
        ),
        session_words(&gate.session)
    )
}

fn host_view(host: &HostDto) -> CloudflareGateHostView {
    let state = match host.gate.kind.as_str() {
        "on" => CloudflareGateState::On,
        "elsewhere" => CloudflareGateState::Elsewhere,
        _ => CloudflareGateState::Off,
    };
    let summary = match state {
        CloudflareGateState::On => gate_summary(&host.gate),
        CloudflareGateState::Elsewhere => {
            let name = if host.gate.name.is_empty() {
                "An Access application"
            } else {
                &host.gate.name
            };
            format!("{name}, set up in Cloudflare")
        }
        CloudflareGateState::Off if !host.proxied => {
            "Cloudflare's proxy is off for it, so a gate cannot go on it yet".to_owned()
        }
        CloudflareGateState::Off => "Open to everyone".to_owned(),
    };
    CloudflareGateHostView {
        hostname: host.hostname.clone(),
        role_label: match host.role.as_str() {
            "core" => Some("Core server".to_owned()),
            "site" => Some(
                host.site_name
                    .as_ref()
                    .map_or_else(|| "Site".to_owned(), |name| format!("Site {name}")),
            ),
            "ssh" => Some("SSH".to_owned()),
            _ => None,
        },
        proxied: host.proxied,
        can_proxy: !host.proxied && host.record_id.is_some(),
        state,
        summary,
        core: host.role == "core",
        this_computer_pass: host.this_computer_pass,
    }
}

/// Who can open the name and for how long, as the desktop's dialog says it.
fn gate_preview(people: &[CloudflarePersonView], session: &str, hostname: &str) -> String {
    let named: Vec<String> = people
        .iter()
        .filter(|p| p.domain)
        .map(|p| format!("Anyone at @{}", p.value))
        .chain(people.iter().filter(|p| !p.domain).map(|p| p.value.clone()))
        .collect();
    let who = match named.as_slice() {
        [] => return format!("Add at least one email or domain to say who can open {hostname}."),
        [one] => one.clone(),
        [first, second] => format!("{first} and {second}"),
        [first, rest @ ..] => format!(
            "{first} and {}",
            plural(rest.len(), "more person", "more people")
        ),
    };
    format!(
        "{who} can open {hostname} for {} after typing a code.",
        session_words(session)
    )
}

/// Domains first, then addresses, as the dialog lists them.
fn people_view(emails: &[String], domains: &[String]) -> Vec<CloudflarePersonView> {
    domains
        .iter()
        .map(|d| CloudflarePersonView {
            value: d.clone(),
            domain: true,
        })
        .chain(emails.iter().map(|e| CloudflarePersonView {
            value: e.clone(),
            domain: false,
        }))
        .collect()
}

fn refresh_gate_form(form: &mut CloudflareEmailGateFormView) {
    let domains: Vec<CloudflarePersonView> =
        form.people.iter().filter(|p| p.domain).cloned().collect();
    let emails: Vec<CloudflarePersonView> =
        form.people.iter().filter(|p| !p.domain).cloned().collect();
    form.people = domains.into_iter().chain(emails).collect();
    form.preview = gate_preview(&form.people, &form.session, &form.hostname);
}

fn refresh_limit_form(form: &mut CloudflareIpLimitFormView, zone: &str) {
    let path = form.path.trim();
    form.path_problem = if form.whole_site || path.is_empty() {
        None
    } else {
        path_problem(path)
    };
    let inside = form
        .this_computer
        .as_deref()
        .is_some_and(|ip| address_in_list(ip, &form.ips));
    form.can_add_this_computer = form.this_computer.is_some() && !inside;
    form.shut_out = form.this_computer.is_some() && !form.ips.is_empty() && !inside;
    form.can_save = !form.hostname.is_empty()
        && !form.ips.is_empty()
        && form.path_problem.is_none()
        && (form.whole_site || !path.is_empty())
        && !form.saving;
    if form.hostname.is_empty() {
        form.preview = "Pick a name, then add the addresses that get in.".to_owned();
        return;
    }
    let target = form_target(form, zone);
    form.preview = match form.ips.as_slice() {
        [] => format!("Add at least one address to say who can open {target}."),
        [one] => {
            format!("Only {one} can open {target}. Everyone else gets Cloudflare's block page.")
        }
        [first, second] => format!(
            "Only {first} and {second} can open {target}. Everyone else gets Cloudflare's block page."
        ),
        [first, rest @ ..] => format!(
            "Only {first} and {} more addresses can open {target}. Everyone else gets Cloudflare's block page.",
            rest.len()
        ),
    };
}

fn form_target(form: &CloudflareIpLimitFormView, zone: &str) -> String {
    let hostname = (form.hostname != EVERY_NAME).then_some(form.hostname.as_str());
    let path = (!form.whole_site && !form.path.trim().is_empty()).then_some(form.path.trim());
    limit_target(hostname, path, form.whole_site || form.prefix, zone)
}

impl Runner {
    pub(super) fn load_access(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        if let Some(view) = self.view.cloudflare.zone.as_mut()
            && view.access.hosts.is_empty()
        {
            view.access.loading = true;
        }
        self.load_gate_plan();
        self.load_limits();
        // The names a limit can go on are the zone's records behind the proxy.
        self.load_records();
        if self.cloudflare.access.public_ip.is_none() {
            let asked = zone;
            self.cf(
                "cloudflare.publicAddress",
                None,
                move |r, result: Result<AddressDto, String>| {
                    if let Ok(found) = result
                        && r.zone_id().as_deref() == Some(asked.as_str())
                    {
                        r.cloudflare.access.public_ip = found.ip;
                    }
                },
            );
        }
    }

    fn load_gate_plan(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let asked = zone.clone();
        self.cf(
            "cloudflare.emailGatePlan",
            Some(json!({ "zoneId": zone })),
            move |r, result: Result<PlanDto, String>| {
                if r.zone_id().as_deref() != Some(asked.as_str()) {
                    return;
                }
                let Some(view) = r.view.cloudflare.zone.as_mut() else {
                    return;
                };
                view.access.loading = false;
                match result {
                    Ok(plan) => {
                        let ready = plan.readiness.organization && plan.readiness.one_time_pin;
                        view.access.problem = None;
                        view.access.ready = ready;
                        view.access.needs_team = !plan.readiness.organization;
                        view.access.team_domain = plan.readiness.team_domain.clone();
                        view.access.hosts = plan.hosts.iter().map(host_view).collect();
                        r.cloudflare.access.hosts = plan.hosts;
                    }
                    Err(problem) => view.access.problem = Some(problem),
                }
            },
        );
    }

    fn load_limits(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let asked = zone.clone();
        self.cf(
            "cloudflare.ipLimits",
            Some(json!({ "zoneId": zone })),
            move |r, result: Result<Vec<IpLimitDto>, String>| {
                if r.zone_id().as_deref() != Some(asked.as_str()) {
                    return;
                }
                match result {
                    Ok(limits) => r.keep_limits(limits),
                    Err(problem) => {
                        if let Some(view) = r.view.cloudflare.zone.as_mut() {
                            view.access.limits_problem = Some(problem);
                        }
                    }
                }
            },
        );
    }

    fn keep_limits(&mut self, limits: Vec<IpLimitDto>) {
        let zone = self.zone_name();
        if let Some(view) = self.view.cloudflare.zone.as_mut() {
            view.access.limits_problem = None;
            view.access.limits = limits.iter().map(|l| limit_view(l, &zone)).collect();
        }
        self.cloudflare.access.limits = limits;
    }

    fn gate_op(&mut self, method: &'static str, hostname: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        self.view.busy = true;
        self.view.error = None;
        self.cf(
            method,
            Some(json!({"zoneId": zone, "hostname": hostname})),
            |r, result: Result<OkDto, String>| {
                r.view.busy = false;
                match result {
                    Ok(done) => {
                        r.view.notice = Some(done.message);
                        r.view.cloudflare.email_gate_form = None;
                        r.load_gate_plan();
                    }
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn gate_prepare(&mut self, team: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let mut params = Map::new();
        params.insert("zoneId".into(), json!(zone));
        let team = team.trim();
        if !team.is_empty() {
            params.insert("teamName".into(), json!(team));
        }
        self.view.busy = true;
        self.view.error = None;
        self.cf(
            "cloudflare.emailGatePrepare",
            Some(Value::Object(params)),
            |r, result: Result<ReadinessDto, String>| {
                r.view.busy = false;
                match result {
                    Ok(_) => {
                        r.view.notice =
                            Some("Email codes are on for this Cloudflare account.".to_owned());
                        r.load_gate_plan();
                    }
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn host(&self, hostname: &str) -> Option<HostDto> {
        self.cloudflare
            .access
            .hosts
            .iter()
            .find(|h| h.hostname == hostname)
            .cloned()
    }

    fn open_gate_form(&mut self, hostname: String) {
        let Some(host) = self.host(&hostname) else {
            return;
        };
        let existing = host.gate.kind == "on";
        let (emails, domains, from_last) = if existing {
            (
                host.gate.emails.clone(),
                host.gate.email_domains.clone(),
                false,
            )
        } else if let Some((emails, domains)) = self.cloudflare.access.last_people.clone() {
            (emails, domains, true)
        } else {
            (Vec::new(), Vec::new(), false)
        };
        let session = if existing && !host.gate.session.is_empty() {
            host.gate.session.clone()
        } else {
            DEFAULT_SESSION.to_owned()
        };
        let core_note = (host.role == "core").then(|| {
            format!(
                "{} Another computer gets one with Let this computer through.",
                if host.this_computer_pass {
                    "This computer has its own pass, so the app keeps reaching the core without a code."
                } else {
                    "This computer gets its own pass, so the app keeps reaching the core without a code."
                }
            )
        });
        let mut form = CloudflareEmailGateFormView {
            hostname,
            existing,
            people: people_view(&emails, &domains),
            invalid: Vec::new(),
            session,
            sessions: SESSIONS
                .iter()
                .map(|(value, label, _)| CloudflareOptionView {
                    value: (*value).to_owned(),
                    label: (*label).to_owned(),
                })
                .collect(),
            preview: String::new(),
            core_note,
            from_last,
            saving: false,
            problem: None,
        };
        refresh_gate_form(&mut form);
        self.view.cloudflare.email_gate_form = Some(form);
    }

    fn gate_switch(&mut self, hostname: String, on: bool) {
        if on {
            self.open_gate_form(hostname);
        } else {
            self.gate_turn_off(hostname);
        }
    }

    fn gate_turn_off(&mut self, hostname: String) {
        let core = self.host(&hostname).is_some_and(|h| h.role == "core");
        let detail = format!(
            "Anyone can open {hostname} again, without a code.{}",
            if core {
                " Every computer's pass through it goes too."
            } else {
                ""
            }
        );
        self.ask(
            asking(
                format!("Turn the email code off for {hostname}?"),
                detail,
                "Turn off",
            ),
            move |runner| runner.gate_op("cloudflare.emailGateRemove", hostname),
        );
    }

    fn gate_add_people(&mut self, text: String) {
        let Some(form) = self.view.cloudflare.email_gate_form.as_mut() else {
            return;
        };
        form.invalid.clear();
        for entry in people(&text) {
            if form.people.len() >= MAX_PEOPLE {
                break;
            }
            let (value, domain) = match entry {
                Entry::Email(value) => (value, false),
                Entry::Domain(value) => (value, true),
                Entry::Invalid(value, reason) => {
                    let line = format!("{value}: {reason}");
                    if !form.invalid.contains(&line) {
                        form.invalid.push(line);
                    }
                    continue;
                }
            };
            if !form
                .people
                .iter()
                .any(|p| p.value == value && p.domain == domain)
            {
                form.people.push(CloudflarePersonView { value, domain });
            }
        }
        form.from_last = false;
        refresh_gate_form(form);
    }

    fn gate_remove_person(&mut self, value: String, domain: bool) {
        if let Some(form) = self.view.cloudflare.email_gate_form.as_mut() {
            form.people
                .retain(|p| !(p.value == value && p.domain == domain));
            form.from_last = false;
            refresh_gate_form(form);
        }
    }

    fn gate_set_session(&mut self, session: String) {
        if let Some(form) = self.view.cloudflare.email_gate_form.as_mut()
            && SESSIONS.iter().any(|(value, ..)| *value == session)
        {
            form.session = session;
            refresh_gate_form(form);
        }
    }

    fn gate_save(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let Some(form) = self.view.cloudflare.email_gate_form.as_mut() else {
            return;
        };
        if form.people.is_empty() || form.saving {
            return;
        }
        form.saving = true;
        form.problem = None;
        let emails: Vec<String> = form
            .people
            .iter()
            .filter(|p| !p.domain)
            .map(|p| p.value.clone())
            .collect();
        let domains: Vec<String> = form
            .people
            .iter()
            .filter(|p| p.domain)
            .map(|p| p.value.clone())
            .collect();
        let hostname = form.hostname.clone();
        let existing = form.existing;
        let remembered = (emails.clone(), domains.clone());
        let params = json!({
            "zoneId": zone, "hostname": hostname,
            "emails": emails, "emailDomains": domains, "session": form.session,
        });
        self.cf(
            "cloudflare.emailGateSave",
            Some(params),
            move |r, result: Result<GateDto, String>| match result {
                Ok(_) => {
                    r.cloudflare.access.last_people = Some(remembered);
                    r.view.cloudflare.email_gate_form = None;
                    r.view.notice = Some(if existing {
                        format!("Saved the email code for {hostname}.")
                    } else {
                        format!("{hostname} now asks for an email code.")
                    });
                    r.load_gate_plan();
                }
                Err(problem) => {
                    if let Some(form) = r.view.cloudflare.email_gate_form.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn limit_names(&self) -> Vec<CloudflareOptionView> {
        let mut names: Vec<String> = self
            .cloudflare
            .records
            .iter()
            .filter(|r| r.proxied && matches!(r.kind.as_str(), "A" | "AAAA" | "CNAME"))
            .map(|r| r.name.to_lowercase())
            .filter(|n| !n.starts_with('*'))
            .collect();
        names.sort();
        names.dedup();
        std::iter::once(CloudflareOptionView {
            value: EVERY_NAME.to_owned(),
            label: format!("Every name in {}", self.zone_name()),
        })
        .chain(names.into_iter().map(|n| CloudflareOptionView {
            value: n.clone(),
            label: n,
        }))
        .collect()
    }

    fn open_ip_limit(&mut self, rule_id: Option<String>) {
        let zone = self.zone_name();
        let existing = rule_id.as_ref().and_then(|id| {
            self.cloudflare
                .access
                .limits
                .iter()
                .find(|l| &l.id == id)
                .cloned()
        });
        let mut names = self.limit_names();
        if let Some(name) = existing.as_ref().and_then(|l| l.hostname.clone())
            && !names.iter().any(|n| n.value == name)
        {
            names.push(CloudflareOptionView {
                value: name.clone(),
                label: name,
            });
        }
        let mut form = CloudflareIpLimitFormView {
            rule_id: existing.as_ref().map(|l| l.id.clone()),
            names,
            hostname: existing.as_ref().map_or_else(String::new, |l| {
                l.hostname.clone().unwrap_or_else(|| EVERY_NAME.to_owned())
            }),
            whole_site: existing.as_ref().is_none_or(|l| l.path.is_none()),
            path: existing
                .as_ref()
                .and_then(|l| l.path.clone())
                .unwrap_or_default(),
            prefix: existing.as_ref().is_none_or(|l| l.matching == "prefix"),
            path_problem: None,
            ips: existing.as_ref().map(|l| l.ips.clone()).unwrap_or_default(),
            invalid: Vec::new(),
            this_computer: self.cloudflare.access.public_ip.clone(),
            can_add_this_computer: false,
            shut_out: false,
            preview: String::new(),
            can_save: false,
            saving: false,
            problem: None,
        };
        refresh_limit_form(&mut form, &zone);
        self.view.cloudflare.ip_limit_form = Some(form);
    }

    /// Changes the open limit's form, then works out again what it says.
    fn edit_limit(&mut self, change: impl FnOnce(&mut CloudflareIpLimitFormView)) {
        let zone = self.zone_name();
        if let Some(form) = self.view.cloudflare.ip_limit_form.as_mut() {
            change(form);
            form.problem = None;
            refresh_limit_form(form, &zone);
        }
    }

    fn limit_add_addresses(&mut self, text: String) {
        self.edit_limit(|form| {
            form.invalid.clear();
            for piece in text.split(|c: char| c.is_whitespace() || c == ',' || c == ';') {
                if piece.is_empty() {
                    continue;
                }
                match address(piece) {
                    Ok(value) => {
                        if !form.ips.contains(&value) && form.ips.len() < MAX_ADDRESSES {
                            form.ips.push(value);
                        }
                    }
                    Err(reason) => {
                        let line = format!("{piece}: {reason}");
                        if !form.invalid.contains(&line) {
                            form.invalid.push(line);
                        }
                    }
                }
            }
        });
    }

    fn limit_target_of(&self, id: &str) -> String {
        let zone = self.zone_name();
        self.cloudflare
            .access
            .limits
            .iter()
            .find(|l| l.id == id)
            .map_or_else(|| "this name".to_owned(), |l| limit_view(l, &zone).target)
    }

    fn limit_save(&mut self) {
        let (Some(zone_id), zone) = (self.zone_id(), self.zone_name()) else {
            return;
        };
        let Some(form) = self.view.cloudflare.ip_limit_form.as_mut() else {
            return;
        };
        if !form.can_save {
            return;
        }
        form.saving = true;
        form.can_save = false;
        let target = form_target(form, &zone);
        let spec = json!({
            "kind": "ip-lock",
            "hostname": if form.hostname == EVERY_NAME { Value::Null } else { json!(form.hostname) },
            "path": if form.whole_site { Value::Null } else { json!(form.path.trim()) },
            "match": if form.whole_site || form.prefix { "prefix" } else { "exact" },
            "ips": form.ips,
        });
        let mut params = Map::new();
        params.insert("zoneId".into(), json!(zone_id));
        if let Some(id) = &form.rule_id {
            params.insert("ruleId".into(), json!(id));
        }
        params.insert("spec".into(), spec);
        let existing = form.rule_id.is_some();
        self.cf(
            "cloudflare.saveIpLimit",
            Some(Value::Object(params)),
            move |r, result: Result<Vec<IpLimitDto>, String>| match result {
                Ok(limits) => {
                    r.view.cloudflare.ip_limit_form = None;
                    r.view.notice = Some(if existing {
                        format!("Saved the IP limit for {target}.")
                    } else {
                        format!("Only the listed addresses can open {target} now.")
                    });
                    r.keep_limits(limits);
                }
                Err(problem) => {
                    let zone = r.zone_name();
                    if let Some(form) = r.view.cloudflare.ip_limit_form.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                        refresh_limit_form(form, &zone);
                    }
                }
            },
        );
    }

    fn limit_set_enabled(&mut self, id: String, enabled: bool) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let target = self.limit_target_of(&id);
        self.view.error = None;
        self.cf(
            "cloudflare.setCustomRuleEnabled",
            Some(json!({"zoneId": zone, "ruleId": id, "enabled": enabled})),
            move |r, result: Result<Value, String>| match result {
                Ok(_) => {
                    r.view.notice = Some(if enabled {
                        format!("Only the listed addresses can open {target} again.")
                    } else {
                        format!("{target} is open to every address again.")
                    });
                    r.load_limits();
                }
                Err(problem) => r.view.error = Some(problem),
            },
        );
    }

    fn limit_delete(&mut self, id: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let target = self.limit_target_of(&id);
        self.ask(
            asking(
                format!("Delete the IP limit for {target}?"),
                "Every address can open it again. To pause the limit instead, switch it off."
                    .to_owned(),
                "Delete limit",
            ),
            move |runner| {
                runner.view.busy = true;
                runner.cf(
                    "cloudflare.deleteCustomRule",
                    Some(json!({"zoneId": zone, "ruleId": id})),
                    move |r, result: Result<Value, String>| {
                        r.view.busy = false;
                        match result {
                            Ok(_) => {
                                r.view.notice = Some(format!("Deleted the IP limit for {target}."));
                                r.load_limits();
                            }
                            Err(problem) => r.view.error = Some(problem),
                        }
                    },
                );
            },
        );
    }
}

#[uniffi::export]
impl Engine {
    /// Turns email codes on for the account; a team name is needed only on an account without one.
    pub fn cloudflare_gate_prepare(&self, team_name: String) {
        self.run(move |r| r.gate_prepare(team_name));
    }

    /// On opens the form for who can get a code; off asks, then takes the gate off.
    pub fn cloudflare_gate_switch(&self, hostname: String, on: bool) {
        self.run(move |r| r.gate_switch(hostname, on));
    }

    pub fn cloudflare_gate_edit(&self, hostname: String) {
        self.run(move |r| r.open_gate_form(hostname));
    }

    pub fn cloudflare_gate_close(&self) {
        self.run(|r| r.view.cloudflare.email_gate_form = None);
    }

    /// Typed or pasted addresses and domains, read the way the desktop reads them.
    pub fn cloudflare_gate_add_people(&self, text: String) {
        self.run(move |r| r.gate_add_people(text));
    }

    pub fn cloudflare_gate_remove_person(&self, value: String, domain: bool) {
        self.run(move |r| r.gate_remove_person(value, domain));
    }

    pub fn cloudflare_gate_set_session(&self, session: String) {
        self.run(move |r| r.gate_set_session(session));
    }

    pub fn cloudflare_gate_save(&self) {
        self.run(Runner::gate_save);
    }

    pub fn cloudflare_gate_turn_off(&self, hostname: String) {
        self.run(move |r| r.gate_turn_off(hostname));
    }

    pub fn cloudflare_gate_proxy(&self, hostname: String) {
        self.run(move |r| r.gate_op("cloudflare.emailGateProxy", hostname));
    }

    pub fn cloudflare_gate_let_through(&self, hostname: String) {
        self.run(move |r| r.gate_op("cloudflare.emailGateLetThrough", hostname));
    }

    pub fn cloudflare_open_ip_limit(&self, rule_id: Option<String>) {
        self.run(move |r| r.open_ip_limit(rule_id));
    }

    pub fn cloudflare_close_ip_limit(&self) {
        self.run(|r| r.view.cloudflare.ip_limit_form = None);
    }

    /// A name of the zone, or "*" for every name.
    pub fn cloudflare_ip_limit_set_name(&self, hostname: String) {
        self.run(move |r| r.edit_limit(|form| form.hostname = hostname));
    }

    pub fn cloudflare_ip_limit_set_scope(&self, whole_site: bool) {
        self.run(move |r| r.edit_limit(|form| form.whole_site = whole_site));
    }

    pub fn cloudflare_ip_limit_set_path(&self, path: String) {
        self.run(move |r| r.edit_limit(|form| form.path = path));
    }

    pub fn cloudflare_ip_limit_set_prefix(&self, prefix: bool) {
        self.run(move |r| r.edit_limit(|form| form.prefix = prefix));
    }

    pub fn cloudflare_ip_limit_add_addresses(&self, text: String) {
        self.run(move |r| r.limit_add_addresses(text));
    }

    pub fn cloudflare_ip_limit_remove_address(&self, address: String) {
        self.run(move |r| r.edit_limit(|form| form.ips.retain(|ip| *ip != address)));
    }

    pub fn cloudflare_ip_limit_add_this_computer(&self) {
        self.run(|r| {
            r.edit_limit(|form| {
                if let Some(ip) = form.this_computer.clone()
                    && !form.ips.contains(&ip)
                {
                    form.ips.push(ip);
                }
            });
        });
    }

    pub fn cloudflare_ip_limit_save(&self) {
        self.run(Runner::limit_save);
    }

    pub fn cloudflare_ip_limit_set_enabled(&self, id: String, enabled: bool) {
        self.run(move |r| r.limit_set_enabled(id, enabled));
    }

    pub fn cloudflare_ip_limit_delete(&self, id: String) {
        self.run(move |r| r.limit_delete(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<String> {
        people(text)
            .into_iter()
            .map(|entry| match entry {
                Entry::Email(v) => format!("email {v}"),
                Entry::Domain(v) => format!("domain {v}"),
                Entry::Invalid(v, _) => format!("invalid {v}"),
            })
            .collect()
    }

    #[test]
    fn people_are_read_the_way_the_desktop_reads_them() {
        assert_eq!(
            kinds("a@x.io Ana <b@y.io>, @Company.com; team.org\nnot-one x@"),
            [
                "email a@x.io",
                "email b@y.io",
                "domain company.com",
                "domain team.org",
                "invalid not-one",
                "invalid x@"
            ]
        );
        assert!(!is_email("a@b@c.io"));
        assert!(!is_email("@c.io"));
        assert!(!is_domain("-x.io"));
        assert!(!is_domain("x.i0"));
    }

    #[test]
    fn addresses_are_written_as_cloudflare_writes_them() {
        assert_eq!(address("203.0.113.10"), Ok("203.0.113.10".to_owned()));
        assert_eq!(address("2001:DB8:0:0::1"), Ok("2001:db8::1".to_owned()));
        assert_eq!(address("198.51.100.0/24"), Ok("198.51.100.0/24".to_owned()));
        assert_eq!(
            address("203.0.113.5/24"),
            Err("203.0.113.5/24 is not the start of its range. Use 203.0.113.0/24.".to_owned())
        );
        assert_eq!(
            address("10.0.0.0/33"),
            Err("IPv4 ranges go up to /32.".to_owned())
        );
        assert_eq!(
            address("10.0.0.0/024"),
            Err("10.0.0.0/024 is not a range like 203.0.113.0/24.".to_owned())
        );
        assert_eq!(address("office"), Err(NOT_ADDRESS.to_owned()));
    }

    #[test]
    fn an_address_is_found_alone_or_inside_a_range() {
        let list = vec!["203.0.113.0/24".to_owned(), "2001:db8::/32".to_owned()];
        assert!(address_in_list("203.0.113.77", &list));
        assert!(address_in_list("2001:db8::9", &list));
        assert!(!address_in_list("203.0.114.1", &list));
        assert!(!address_in_list(
            "::ffff:203.0.113.1",
            &["0.0.0.0/0".to_owned()]
        ));
        assert!(!address_in_list("nowhere", &list));
    }

    #[test]
    fn paths_and_targets_read_like_the_desktop() {
        assert_eq!(
            path_problem("/a b").as_deref(),
            Some("A path cannot hold spaces, quotes or backslashes.")
        );
        assert!(path_problem("/admin").is_none());
        assert_eq!(
            limit_target(None, None, true, "example.com"),
            "every name in example.com"
        );
        assert_eq!(
            limit_target(None, Some("/admin"), true, "example.com"),
            "/admin and below, on every name in example.com"
        );
        assert_eq!(
            limit_target(
                Some("app.example.com"),
                Some("/login"),
                false,
                "example.com"
            ),
            "app.example.com/login"
        );
    }
}
