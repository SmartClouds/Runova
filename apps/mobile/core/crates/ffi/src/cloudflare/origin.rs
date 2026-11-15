//! A server's Cloudflare-only origin (E102): the origin lock (ports 80 and 443 answer Cloudflare's
//! addresses only) and the Cloudflare Tunnel (no open web ports at all), as the desktop's Firewall
//! section has them. Every change is previewed first and made by the computer over its own link to
//! the server; a firewall change then waits to be kept, here or on the computer, or it rolls back.

use super::{OkDto, asking};
use crate::engine::{Engine, Runner};
use crate::labels::ago_label;
use crate::view::{
    CloudflareCheckedRowView, CloudflareChoiceView, CloudflareFactView, CloudflareOriginDialogKind,
    CloudflareOriginDialogView, CloudflareOriginLockView, CloudflareOriginMode,
    CloudflareOriginView, CloudflarePendingChangeView, CloudflareSshModeView, CloudflareStepState,
    CloudflareStepView, CloudflareTone, CloudflareTunnelView,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

/// How long the tunnel gets for its first connection to Cloudflare, as on the desktop.
const CONNECT_WITHIN: Duration = Duration::from_secs(180);
/// While something is under way the origin is read on every tick, otherwise every this many.
const QUIET_EVERY_TICKS: u32 = 8;
const SETUP_STEPS: [&str; 4] = [
    "Make the tunnel at Cloudflare and install cloudflared",
    "Wait for its first connection to Cloudflare",
    "Point the server's names at the tunnel",
    "Close ports 80 and 443 to everyone",
];

#[derive(Default)]
pub(super) struct OriginState {
    last: Option<OriginDto>,
    picks: HashMap<String, CloudflareOriginMode>,
    /// Servers whose tunnel was turned off from here, and whether their names point back.
    cleanups: HashMap<String, bool>,
    plan: Option<PlanDto>,
    setup_started: Option<Instant>,
    off_point_back: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LockDto {
    enabled: bool,
    #[serde(default)]
    authenticated_origin_pulls: bool,
    state: String,
    #[serde(default)]
    missing_rules: Vec<String>,
    #[serde(default)]
    open_rules: Vec<String>,
    #[serde(default)]
    stale_rules: Vec<String>,
    #[serde(default)]
    warnings: Vec<String>,
    ipv4_ranges: Option<u32>,
    ipv6_ranges: Option<u32>,
    ranges_fetched_at: Option<i64>,
    last_refresh_error: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TunnelDto {
    enabled: bool,
    state: String,
    ssh_mode: String,
    #[serde(default)]
    connections: u32,
    tunnel_name: Option<String>,
    ssh_hostname: Option<String>,
    mesh_address: Option<String>,
    cloudflared_version: Option<String>,
    #[serde(default)]
    open_rules: Vec<String>,
    #[serde(default)]
    warnings: Vec<String>,
    last_error: Option<String>,
    #[serde(default)]
    break_glass_enabled: bool,
    #[serde(default)]
    break_glass_delay_minutes: u32,
}

#[derive(Deserialize, Clone)]
struct PendingDto {
    id: String,
    summary: String,
    #[serde(default)]
    commands: Vec<String>,
    deadline: Option<i64>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OriginDto {
    role: Option<String>,
    #[serde(default)]
    signed_in: bool,
    lock: Option<LockDto>,
    lock_problem: Option<String>,
    tunnel: Option<TunnelDto>,
    tunnel_problem: Option<String>,
    pending: Option<PendingDto>,
}

#[derive(Deserialize)]
struct RowDto {
    domain: String,
    text: String,
    ok: bool,
}

#[derive(Deserialize)]
struct FirewallDto {
    #[serde(default)]
    domains: Vec<RowDto>,
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    notes: Vec<String>,
    blocked: Option<String>,
    #[serde(rename = "confirmationPhrase")]
    confirmation_phrase: Option<String>,
}

#[derive(Deserialize, Clone)]
struct AccountDto {
    id: String,
    /// A server's list entry calls it its name.
    #[serde(alias = "name")]
    label: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanDomainDto {
    domain: String,
    role: String,
    cloudflare_account_id: Option<String>,
    #[serde(default)]
    routed: bool,
    #[serde(default)]
    in_account: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanDto {
    #[serde(default)]
    accounts: Vec<AccountDto>,
    #[serde(default)]
    domains: Vec<PlanDomainDto>,
    core_direct: Option<String>,
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    notes: Vec<String>,
    blocked: Option<String>,
    suggested_ssh_hostname: Option<String>,
    blocker: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppliedDto {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct RouteDto {
    #[serde(default)]
    routed: Vec<String>,
    #[serde(default)]
    skipped: Vec<String>,
}

#[derive(Deserialize)]
struct ProbeDto {
    ok: bool,
    message: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn commands_title(count: usize, already: &str) -> String {
    match count {
        0 => already.to_owned(),
        1 => "1 firewall command".to_owned(),
        n => format!("{n} firewall commands"),
    }
}

fn is_hostname(name: &str) -> bool {
    let labels: Vec<&str> = name.split('.').collect();
    name.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|label| {
            let b = label.as_bytes();
            !b.is_empty()
                && b.len() <= 63
                && b.iter()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
                && b[0] != b'-'
                && b[b.len() - 1] != b'-'
        })
        && labels
            .last()
            .is_some_and(|l| l.len() >= 2 && l.bytes().all(|c| c.is_ascii_lowercase()))
}

/// The first four of a list, then how many more.
fn short_list(items: &[String]) -> String {
    let shown: Vec<&str> = items.iter().take(4).map(String::as_str).collect();
    let more = items.len().saturating_sub(4);
    if more > 0 {
        format!("{} and {more} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

fn lock_view(lock: &LockDto) -> CloudflareOriginLockView {
    let (state_label, tone) = match lock.state.as_str() {
        "pending" => (
            "Waiting for you to keep the firewall change",
            CloudflareTone::Warning,
        ),
        "on" => (
            "On: only Cloudflare reaches ports 80 and 443",
            CloudflareTone::Good,
        ),
        "drifted" => (
            "On, but the firewall no longer matches",
            CloudflareTone::Bad,
        ),
        _ => (
            "Off: every address reaches ports 80 and 443",
            CloudflareTone::Warning,
        ),
    };
    let mut details = Vec::new();
    if lock.enabled {
        details.push(format!(
            "Authenticated Origin Pulls {}.",
            if lock.authenticated_origin_pulls {
                "on"
            } else {
                "off"
            }
        ));
    }
    if let (Some(v4), Some(v6)) = (lock.ipv4_ranges, lock.ipv6_ranges) {
        let fetched = lock
            .ranges_fetched_at
            .map(|at| format!(", fetched {}", ago_label(now_ms() - at)))
            .unwrap_or_default();
        details.push(format!(
            "{v4} IPv4 and {v6} IPv6 ranges from Cloudflare{fetched}."
        ));
    }
    let mut drift = Vec::new();
    if lock.state == "drifted" {
        for (label, list) in [
            ("Not allowed yet", &lock.missing_rules),
            ("Still open to everyone", &lock.open_rules),
            ("No longer Cloudflare's", &lock.stale_rules),
        ] {
            if !list.is_empty() {
                drift.push(format!("{label}: {}", short_list(list)));
            }
        }
    }
    let mut warnings: Vec<String> = lock.last_refresh_error.iter().cloned().collect();
    warnings.extend(lock.warnings.iter().cloned());
    CloudflareOriginLockView {
        state_label: state_label.to_owned(),
        tone,
        enabled: lock.enabled,
        enable_label: (lock.state != "on").then(|| {
            if lock.enabled {
                "Bring up to date"
            } else {
                "Lock to Cloudflare"
            }
            .to_owned()
        }),
        details,
        drift,
        warnings,
    }
}

fn ssh_mode_label(mode: &str) -> &str {
    match mode {
        "open" => "Open as the firewall has it",
        "closed" => "Closed to everyone",
        "cloudflare" => "Cloudflare only, through the tunnel",
        "mesh" => "Cloudflare Mesh only",
        other => other,
    }
}

fn minutes_label(minutes: u32) -> String {
    if minutes < 60 {
        format!("{minutes} min")
    } else {
        format!("{} h", minutes / 60)
    }
}

fn tunnel_view(t: &TunnelDto, lock_on: bool, settled: bool) -> CloudflareTunnelView {
    let (state_label, tone) = match t.state.as_str() {
        "installing" => (
            "Setting up: installing cloudflared and connecting",
            CloudflareTone::Warning,
        ),
        "connecting" => (
            "cloudflared is running and connecting to Cloudflare",
            CloudflareTone::Warning,
        ),
        "portsOpen" => (
            "Connected, but ports 80 and 443 are still open to everyone",
            CloudflareTone::Warning,
        ),
        "pending" => (
            "Waiting for you to keep the firewall change",
            CloudflareTone::Warning,
        ),
        "connected" => (
            "On: no open web ports, everything comes through the tunnel",
            CloudflareTone::Good,
        ),
        "drifted" => (
            "On, but the firewall lets someone in again",
            CloudflareTone::Bad,
        ),
        "down" => (
            "Down: the tunnel lost its connection to Cloudflare",
            CloudflareTone::Bad,
        ),
        "failed" => ("Setting up the tunnel failed", CloudflareTone::Bad),
        _ => ("Off: no tunnel on this server", CloudflareTone::Warning),
    };
    let on = t.enabled && t.state != "failed";
    let mut facts = Vec::new();
    if on {
        let mut fact = |label: &str, value: Option<String>| {
            if let Some(value) = value {
                facts.push(CloudflareFactView {
                    label: label.to_owned(),
                    value,
                });
            }
        };
        fact("Tunnel", t.tunnel_name.clone());
        fact(
            "Connections to Cloudflare",
            Some(if t.connections == 0 {
                "None right now".to_owned()
            } else {
                t.connections.to_string()
            }),
        );
        fact("SSH", Some(ssh_mode_label(&t.ssh_mode).to_owned()));
        fact("SSH name", t.ssh_hostname.clone());
        fact("Mesh address", t.mesh_address.clone());
        fact("cloudflared", t.cloudflared_version.clone());
    }
    let intro = (!t.enabled).then(|| {
        let mut text = "cloudflared on the server dials out to Cloudflare, so the sites and the app's core domain answer through it and ports 80 and 443 close to everyone. You choose who may still open SSH.".to_owned();
        if lock_on {
            text.push_str(" Setting it up replaces the IP lock: its rules go when the tunnel closes the ports.");
        }
        text
    });
    let drift = if t.state == "drifted" && !t.open_rules.is_empty() {
        vec![format!(
            "Still letting someone in: {}",
            short_list(&t.open_rules)
        )]
    } else {
        Vec::new()
    };
    let can = |states: &[&str]| settled && states.contains(&t.state.as_str());
    CloudflareTunnelView {
        state_label: state_label.to_owned(),
        tone,
        enabled: t.enabled,
        working: matches!(t.state.as_str(), "installing" | "connecting"),
        intro,
        facts,
        drift,
        last_error: t.last_error.clone(),
        warnings: t.warnings.clone(),
        break_glass: t.break_glass_enabled,
        break_glass_minutes: t.break_glass_delay_minutes,
        break_glass_text: if t.break_glass_enabled {
            format!(
                "After {} down, the server opens SSH to everyone and closes it again once the tunnel is back.",
                minutes_label(t.break_glass_delay_minutes)
            )
        } else {
            "Off: if the tunnel fails with SSH closed, only your provider's console gets you in."
                .to_owned()
        },
        set_up_label: if can(&["off", "failed"]) {
            Some(if t.state == "failed" { "Try again" } else { "Set up tunnel" }.to_owned())
        } else {
            None
        },
        can_close_ports: can(&["portsOpen", "drifted"]),
        can_change_ssh: can(&["connected", "drifted"]),
        can_turn_off: on && settled,
        hint: (t.state == "connected" && t.ssh_mode == "open").then(|| {
            "The sites are safe behind the tunnel. SSH is the one port left open; you can limit it with Change SSH access.".to_owned()
        }),
    }
}

fn pending_view(p: &PendingDto) -> CloudflarePendingChangeView {
    let deadline_label = match p.deadline {
        Some(at) => {
            let left = (at - now_ms()).max(0) / 60_000;
            if left >= 1 {
                format!("Rolls back in {left} min unless you keep it.")
            } else {
                "Rolls back in under a minute unless you keep it.".to_owned()
            }
        }
        None => "Keep it, or it rolls back by itself.".to_owned(),
    };
    CloudflarePendingChangeView {
        id: p.id.clone(),
        summary: p.summary.clone(),
        commands: p.commands.clone(),
        deadline_label,
    }
}

fn dialog(
    kind: CloudflareOriginDialogKind,
    title: String,
    description: &str,
    apply: &str,
) -> CloudflareOriginDialogView {
    CloudflareOriginDialogView {
        kind,
        title,
        description: description.to_owned(),
        loading: true,
        rows: Vec::new(),
        rows_title: None,
        rows_warning: None,
        firewall_title: None,
        commands: Vec::new(),
        notes: Vec::new(),
        blocked: None,
        problem: None,
        saving: false,
        can_apply: false,
        apply_label: apply.to_owned(),
        danger: false,
        aop: false,
        accounts: Vec::new(),
        account: String::new(),
        route_ssh: false,
        ssh_name: String::new(),
        ssh_name_problem: None,
        needs_ack: false,
        acked: false,
        steps: Vec::new(),
        ssh_modes: Vec::new(),
        ssh_mode: String::new(),
        probe: None,
        probe_ok: false,
        can_test: false,
        test_label: None,
        mesh_address: None,
        can_join_mesh: false,
        phrase: None,
        reopen_web: true,
        point_back: true,
    }
}

fn ssh_modes(current: &str, hostname: bool, can_own: bool) -> Vec<CloudflareSshModeView> {
    let mode = |value: &str, title: &str, line: &str, risk: &str, unavailable: Option<&str>| {
        CloudflareSshModeView {
            value: value.to_owned(),
            title: title.to_owned(),
            line: line.to_owned(),
            risk: unavailable.unwrap_or(risk).to_owned(),
            available: unavailable.is_none(),
            now: value == current,
        }
    };
    vec![
        mode(
            "open",
            "Open as the firewall has it",
            "SSH works the way it does today, from wherever the firewall allows.",
            "The one port bots can still find.",
            None,
        ),
        mode(
            "cloudflare",
            "Cloudflare only",
            "SSH goes through the tunnel behind Cloudflare Access. The computer's Runova holds the only key.",
            "Other SSH tools need cloudflared and a token of their own.",
            (!hostname).then_some("Set the tunnel up again with an SSH name first."),
        ),
        mode(
            "mesh",
            "Cloudflare Mesh only",
            "Only your devices on Cloudflare Mesh reach SSH, at the server's Mesh address.",
            "Needs the Cloudflare One Client running on the computer.",
            None,
        ),
        mode(
            "closed",
            "Closed to everyone",
            "No SSH at all. The app gets in through the core domain only.",
            "If the tunnel fails, only your provider's console gets you in, unless break-glass is on.",
            (!can_own).then_some("Only an Owner can close SSH to everyone."),
        ),
    ]
}

impl Runner {
    pub(super) fn load_servers_list(&mut self) {
        self.cf(
            "cloudflare.servers",
            None,
            |r, result: Result<Vec<AccountDto>, String>| {
                if let Ok(servers) = result {
                    r.view.cloudflare.servers = servers
                        .into_iter()
                        .map(|s| CloudflareChoiceView {
                            id: s.id,
                            name: s.label,
                        })
                        .collect();
                }
            },
        );
    }

    fn origin_id(&self) -> Option<String> {
        self.view
            .cloudflare
            .origin
            .as_ref()
            .map(|o| o.server_id.clone())
    }

    fn origin_name(&self) -> String {
        self.view
            .cloudflare
            .origin
            .as_ref()
            .map_or_else(String::new, |o| o.server_name.clone())
    }

    pub(super) fn refresh_origin(&mut self) {
        let busy = self.cloudflare.origin.setup_started.is_some()
            || self
                .cloudflare
                .origin
                .cleanups
                .contains_key(&self.origin_id().unwrap_or_default())
            || self.cloudflare.origin.last.as_ref().is_some_and(|o| {
                o.pending.is_some()
                    || o.lock.as_ref().is_some_and(|l| l.state == "pending")
                    || o.tunnel.as_ref().is_some_and(|t| {
                        matches!(t.state.as_str(), "installing" | "connecting" | "pending")
                    })
            })
            || self
                .view
                .cloudflare
                .origin_dialog
                .as_ref()
                .is_some_and(|d| {
                    d.can_join_mesh || (d.kind == CloudflareOriginDialogKind::Ssh && d.loading)
                });
        if busy || self.ticks.is_multiple_of(QUIET_EVERY_TICKS) {
            self.load_origin();
        }
    }

    fn open_origin(&mut self, server_id: String) {
        let name = self
            .view
            .cloudflare
            .servers
            .iter()
            .find(|s| s.id == server_id)
            .map_or_else(|| server_id.clone(), |s| s.name.clone());
        self.cloudflare.origin.last = None;
        self.view.cloudflare.origin_dialog = None;
        self.view.cloudflare.origin = Some(CloudflareOriginView {
            server_id,
            server_name: name,
            loading: true,
            problem: None,
            can_admin: false,
            can_own: false,
            mode: CloudflareOriginMode::Tunnel,
            mode_locked: false,
            mode_note: None,
            lock: None,
            lock_problem: None,
            tunnel: None,
            tunnel_problem: None,
            pending: None,
        });
        self.load_origin();
    }

    fn load_origin(&mut self) {
        let Some(id) = self.origin_id() else {
            return;
        };
        let asked = id.clone();
        self.cf(
            "cloudflare.origin",
            Some(json!({ "serverId": id })),
            move |r, result: Result<OriginDto, String>| {
                if r.origin_id().as_deref() != Some(asked.as_str()) {
                    return;
                }
                match result {
                    Ok(origin) => {
                        r.cloudflare.origin.last = Some(origin);
                        r.redraw_origin();
                        r.after_origin_read();
                    }
                    Err(problem) => {
                        if let Some(view) = r.view.cloudflare.origin.as_mut() {
                            view.loading = false;
                            view.problem = Some(problem);
                        }
                    }
                }
            },
        );
    }

    fn redraw_origin(&mut self) {
        let Some(origin) = self.cloudflare.origin.last.clone() else {
            return;
        };
        let Some(view) = self.view.cloudflare.origin.as_mut() else {
            return;
        };
        let role = origin.role.as_deref().unwrap_or_default();
        view.loading = false;
        view.can_own = role == "owner";
        view.can_admin = matches!(role, "owner" | "admin");
        view.problem = (!origin.signed_in).then(|| {
            format!(
                "Sign in to {} on the computer first, under Deploy, to see its firewall.",
                view.server_name
            )
        });
        let tunnel_on = origin.tunnel.as_ref().is_some_and(|t| t.enabled);
        let lock_on = origin.lock.as_ref().is_some_and(|l| l.enabled);
        let pick = self.cloudflare.origin.picks.get(&view.server_id).copied();
        view.mode = if tunnel_on {
            CloudflareOriginMode::Tunnel
        } else {
            pick.unwrap_or(if lock_on {
                CloudflareOriginMode::Ips
            } else {
                CloudflareOriginMode::Tunnel
            })
        };
        view.mode_locked = tunnel_on;
        view.mode_note = tunnel_on.then(|| {
            "The Cloudflare Tunnel is on. To use the IP lock instead, turn the tunnel off, choosing to keep ports 80 and 443 closed, then lock them to Cloudflare.".to_owned()
        });
        let settled = origin.pending.is_none();
        view.lock = origin.lock.as_ref().map(lock_view);
        view.lock_problem = origin.lock_problem.clone();
        view.tunnel = origin
            .tunnel
            .as_ref()
            .map(|t| tunnel_view(t, lock_on, settled));
        view.tunnel_problem = origin.tunnel_problem.clone();
        view.pending = origin.pending.as_ref().map(pending_view);
    }

    /// What a fresh read of the server moves on: a setup waiting for its connection, a mesh
    /// address arriving, a tunnel that went off and needs cleaning up at Cloudflare.
    fn after_origin_read(&mut self) {
        let Some(id) = self.origin_id() else {
            return;
        };
        let tunnel = self
            .cloudflare
            .origin
            .last
            .as_ref()
            .and_then(|o| o.tunnel.clone());
        if let Some(t) = &tunnel {
            if t.state == "off"
                && !t.enabled
                && let Some(point_back) = self.cloudflare.origin.cleanups.remove(&id)
            {
                self.cf(
                    "cloudflare.tunnelCleanUp",
                    Some(json!({"serverId": id.clone(), "pointBack": point_back})),
                    |r, result: Result<OkDto, String>| match result {
                        Ok(done) => r.view.notice = Some(done.message),
                        Err(problem) => r.view.error = Some(problem),
                    },
                );
            }
            if let Some(dialog) = self.view.cloudflare.origin_dialog.as_mut()
                && dialog.kind == CloudflareOriginDialogKind::Ssh
                && dialog.mesh_address.is_none()
                && t.mesh_address.is_some()
            {
                dialog.mesh_address = t.mesh_address.clone();
                dialog.can_join_mesh = false;
                self.refresh_ssh_dialog();
            }
        }
        self.setup_watch(tunnel);
    }

    fn origin_mode(&mut self, mode: CloudflareOriginMode) {
        let Some(id) = self.origin_id() else {
            return;
        };
        self.cloudflare.origin.picks.insert(id, mode);
        self.redraw_origin();
    }

    fn set_dialog(&mut self, dialog: CloudflareOriginDialogView) {
        self.view.cloudflare.origin_dialog = Some(dialog);
    }

    fn dialog_mut(&mut self) -> Option<&mut CloudflareOriginDialogView> {
        self.view.cloudflare.origin_dialog.as_mut()
    }

    fn dialog_failed(&mut self, problem: String) {
        if let Some(d) = self.dialog_mut() {
            d.loading = false;
            d.saving = false;
            d.problem = Some(problem);
        }
    }

    fn lock_open(&mut self, enable: bool) {
        let name = self.origin_name();
        let aop = self
            .cloudflare
            .origin
            .last
            .as_ref()
            .and_then(|o| o.lock.as_ref())
            .is_some_and(|l| l.authenticated_origin_pulls);
        let mut d = if enable {
            dialog(
                CloudflareOriginDialogKind::LockOn,
                format!("Lock {name} to Cloudflare"),
                "Ports 80 and 443 will only answer Cloudflare's published addresses, and nginx will log each visitor's own address. The core keeps the list up to date by itself every day.",
                "Lock to Cloudflare",
            )
        } else {
            let mut d = dialog(
                CloudflareOriginDialogKind::LockOff,
                format!("Open {name} to everyone again"),
                "Ports 80 and 443 will answer every address again. nginx stops trusting Cloudflare for the visitor address.",
                "Open to everyone",
            );
            d.danger = true;
            d
        };
        d.aop = enable && aop;
        d.rows_title = Some("Site domains on this server".to_owned());
        self.set_dialog(d);
        self.lock_preview();
    }

    fn lock_input(&self) -> Option<Value> {
        let d = self.view.cloudflare.origin_dialog.as_ref()?;
        let enabled = d.kind == CloudflareOriginDialogKind::LockOn;
        Some(json!({
            "serverId": self.origin_id()?,
            "enabled": enabled,
            "authenticatedOriginPulls": enabled && d.aop,
        }))
    }

    fn lock_preview(&mut self) {
        let Some(input) = self.lock_input() else {
            return;
        };
        if let Some(d) = self.dialog_mut() {
            d.loading = true;
            d.can_apply = false;
        }
        self.cf(
            "cloudflare.originLockPreview",
            Some(input),
            |r, result: Result<FirewallDto, String>| match result {
                Ok(preview) => {
                    let Some(d) = r.dialog_mut() else {
                        return;
                    };
                    let enabling = d.kind == CloudflareOriginDialogKind::LockOn;
                    d.loading = false;
                    d.problem = None;
                    d.rows = preview
                        .domains
                        .iter()
                        .map(|row| CloudflareCheckedRowView {
                            label: row.domain.clone(),
                            text: row.text.clone(),
                            ok: !enabling || row.ok,
                            chip: None,
                        })
                        .collect();
                    d.rows_warning =
                        (enabling && preview.domains.iter().any(|row| !row.ok)).then(|| {
                            "Turn the proxy on for these names first, or they stop answering."
                                .to_owned()
                        });
                    d.firewall_title = Some(commands_title(
                        preview.commands.len(),
                        "The firewall already matches",
                    ));
                    d.commands = preview.commands;
                    d.notes = preview.notes;
                    d.blocked = preview.blocked;
                    d.can_apply = d.blocked.is_none();
                }
                Err(problem) => r.dialog_failed(problem),
            },
        );
    }

    fn lock_set_aop(&mut self, on: bool) {
        if let Some(d) = self.dialog_mut() {
            d.aop = on;
        }
        self.lock_preview();
    }

    /// Sends a change whose answer says what happened and whether a firewall change waits.
    fn origin_change(&mut self, method: &'static str, params: Value, after: fn(&mut Runner)) {
        if let Some(d) = self.dialog_mut() {
            d.saving = true;
            d.can_apply = false;
            d.problem = None;
        }
        self.cf(
            method,
            Some(params),
            move |r, result: Result<AppliedDto, String>| match result {
                Ok(done) => {
                    r.view.cloudflare.origin_dialog = None;
                    r.view.notice = Some(done.message);
                    after(r);
                    r.load_origin();
                }
                Err(problem) => {
                    if let Some(d) = r.dialog_mut() {
                        d.saving = false;
                        d.can_apply = true;
                        d.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn setup_open(&mut self) {
        let name = self.origin_name();
        let mut d = dialog(
            CloudflareOriginDialogKind::Setup,
            format!("Put {name} behind a Cloudflare Tunnel"),
            "cloudflared on the server dials out to Cloudflare, so nothing needs to reach ports 80 and 443 any more. The ports close only after the tunnel is connected and the names point at it.",
            "Set up tunnel",
        );
        d.rows_title = Some("Names on this server".to_owned());
        self.set_dialog(d);
        self.load_plan(CloudflareOriginDialogKind::Setup);
    }

    fn ports_open(&mut self) {
        let name = self.origin_name();
        let mut d = dialog(
            CloudflareOriginDialogKind::Ports,
            format!("Close ports 80 and 443 on {name}"),
            "The tunnel is connected, so nothing needs these ports any more. Visitors keep coming in through Cloudflare.",
            "Close the ports",
        );
        d.danger = true;
        self.set_dialog(d);
        self.load_plan(CloudflareOriginDialogKind::Ports);
    }

    fn load_plan(&mut self, kind: CloudflareOriginDialogKind) {
        let Some(id) = self.origin_id() else {
            return;
        };
        self.cf(
            "cloudflare.tunnelPlan",
            Some(json!({ "serverId": id })),
            move |r, result: Result<PlanDto, String>| match result {
                Ok(plan) => {
                    if r.view.cloudflare.origin_dialog.as_ref().map(|d| d.kind) != Some(kind) {
                        return;
                    }
                    let tunnel_ssh = r
                        .cloudflare
                        .origin
                        .last
                        .as_ref()
                        .and_then(|o| o.tunnel.as_ref())
                        .and_then(|t| t.ssh_hostname.clone());
                    if let Some(d) = r.dialog_mut() {
                        d.loading = false;
                        d.accounts = plan
                            .accounts
                            .iter()
                            .map(|a| CloudflareChoiceView {
                                id: a.id.clone(),
                                name: a.label.clone(),
                            })
                            .collect();
                        d.account = plan
                            .accounts
                            .first()
                            .map(|a| a.id.clone())
                            .unwrap_or_default();
                        d.ssh_name = tunnel_ssh
                            .or_else(|| plan.suggested_ssh_hostname.clone())
                            .unwrap_or_default();
                        d.route_ssh = !d.ssh_name.is_empty();
                        d.commands = plan.commands.clone();
                        d.notes = plan.notes.clone();
                    }
                    r.cloudflare.origin.plan = Some(plan);
                    r.refresh_plan_dialog();
                }
                Err(problem) => r.dialog_failed(problem),
            },
        );
    }

    /// Works out what a setup or ports dialog says from the plan and the choices made in it.
    fn refresh_plan_dialog(&mut self) {
        let Some(plan) = self.cloudflare.origin.plan.clone() else {
            return;
        };
        let running = self.cloudflare.origin.setup_started.is_some();
        let Some(d) = self.dialog_mut() else {
            return;
        };
        if d.kind == CloudflareOriginDialogKind::Ports {
            let open: Vec<String> = plan
                .domains
                .iter()
                .filter(|x| x.role != "ssh" && !x.routed)
                .map(|x| x.domain.clone())
                .collect();
            d.rows_warning = (!open.is_empty()).then(|| {
                format!(
                    "Not pointing at the tunnel yet: {}. They stop answering once the ports close.",
                    open.join(", ")
                )
            });
            d.firewall_title = Some(commands_title(
                plan.commands.len(),
                "The firewall already matches",
            ));
            d.blocked = plan.blocked.clone();
            d.can_apply = d.blocked.is_none() && !d.saving;
            return;
        }
        let account = d.account.clone();
        d.rows = plan
            .domains
            .iter()
            .filter(|x| x.role != "ssh")
            .map(|x| {
                let here = x.cloudflare_account_id.as_deref() == Some(account.as_str());
                let text = if here && x.routed {
                    "Already goes through the tunnel"
                } else if here {
                    "Will go through the tunnel"
                } else if !x.in_account {
                    "Not in a connected Cloudflare account: stops answering"
                } else {
                    "In another Cloudflare account: stops answering"
                };
                CloudflareCheckedRowView {
                    label: x.domain.clone(),
                    text: text.to_owned(),
                    ok: here,
                    chip: (x.role == "core").then(|| "Core domain".to_owned()),
                }
            })
            .collect();
        let lost = d.rows.iter().filter(|row| !row.ok).count();
        d.needs_ack = lost > 0;
        d.rows_warning = d.needs_ack.then(|| {
            if lost == 1 {
                "I understand this name stops answering once the ports close. Add it to this Cloudflare account to keep it."
            } else {
                "I understand these names stop answering once the ports close. Add them to this Cloudflare account to keep them."
            }
            .to_owned()
        });
        d.blocked = plan.blocker.clone().or_else(|| {
            if plan.accounts.is_empty() {
                Some("No connected Cloudflare account holds a domain yet. Connect one on the computer first.".to_owned())
            } else {
                plan.core_direct.as_ref().map(|domain| {
                    format!("The core domain {domain} points straight at the server, and the tunnel closes the ports it needs. Switch it to Through Cloudflare under Security, Connection on the computer first.")
                })
            }
        });
        d.ssh_name_problem = (d.route_ssh && !is_hostname(d.ssh_name.trim()))
            .then(|| "Use a name like ssh.example.com.".to_owned());
        d.firewall_title = Some(match plan.commands.len() {
            0 => "Ports 80 and 443 are already closed".to_owned(),
            1 => "Then, 1 firewall command".to_owned(),
            n => format!("Then, {n} firewall commands"),
        });
        d.can_apply = d.blocked.is_none()
            && !d.account.is_empty()
            && (!d.needs_ack || d.acked)
            && d.ssh_name_problem.is_none()
            && !running;
    }

    fn setup_start(&mut self) {
        let (Some(id), Some(d)) = (
            self.origin_id(),
            self.view.cloudflare.origin_dialog.as_ref(),
        ) else {
            return;
        };
        if !d.can_apply {
            return;
        }
        let first = d
            .steps
            .iter()
            .position(|s| s.state != CloudflareStepState::Done)
            .unwrap_or(0);
        let ssh = if d.route_ssh {
            json!(d.ssh_name.trim().to_lowercase())
        } else {
            Value::Null
        };
        let input = json!({"serverId": id, "cloudflareAccountId": d.account, "sshHostname": ssh});
        if let Some(d) = self.dialog_mut() {
            if d.steps.is_empty() {
                d.steps = SETUP_STEPS
                    .iter()
                    .map(|label| CloudflareStepView {
                        label: (*label).to_owned(),
                        state: CloudflareStepState::Waiting,
                        detail: None,
                    })
                    .collect();
            }
            d.problem = None;
            d.can_apply = false;
            d.saving = true;
        }
        self.cloudflare.origin.setup_started = Some(Instant::now());
        self.setup_step(first, input);
    }

    fn step(&mut self, index: usize, state: CloudflareStepState, detail: Option<String>) {
        if let Some(step) = self.dialog_mut().and_then(|d| d.steps.get_mut(index)) {
            step.state = state;
            if detail.is_some() {
                step.detail = detail;
            }
        }
    }

    fn setup_failed(&mut self, index: usize, problem: String) {
        self.step(index, CloudflareStepState::Failed, None);
        self.cloudflare.origin.setup_started = None;
        if let Some(d) = self.dialog_mut() {
            d.saving = false;
            d.problem = Some(problem);
            d.apply_label = "Try again".to_owned();
        }
        self.refresh_plan_dialog();
    }

    fn setup_step(&mut self, index: usize, input: Value) {
        let Some(id) = self.origin_id() else {
            return;
        };
        self.step(index, CloudflareStepState::Running, None);
        match index {
            0 => self.cf(
                "cloudflare.tunnelSetUp",
                Some(input),
                |r, result: Result<OkDto, String>| match result {
                    Ok(_) => {
                        r.step(0, CloudflareStepState::Done, None);
                        r.step(1, CloudflareStepState::Running, None);
                        r.cloudflare.origin.setup_started = Some(Instant::now());
                        r.load_origin();
                    }
                    Err(problem) => r.setup_failed(0, problem),
                },
            ),
            1 => {
                self.cloudflare.origin.setup_started = Some(Instant::now());
                self.load_origin();
            }
            2 => self.cf(
                "cloudflare.tunnelRoute",
                Some(json!({ "serverId": id })),
                |r, result: Result<RouteDto, String>| match result {
                    Ok(route) => {
                        let mut detail = format!("{} routed", route.routed.len());
                        if !route.skipped.is_empty() {
                            detail.push_str(&format!("; left alone: {}", route.skipped.join(", ")));
                        }
                        r.step(2, CloudflareStepState::Done, Some(detail));
                        r.setup_step(3, Value::Null);
                    }
                    Err(problem) => r.setup_failed(2, problem),
                },
            ),
            _ => self.cf(
                "cloudflare.tunnelClosePorts",
                Some(json!({ "serverId": id })),
                |r, result: Result<AppliedDto, String>| match result {
                    Ok(done) => {
                        r.step(3, CloudflareStepState::Done, None);
                        r.cloudflare.origin.setup_started = None;
                        r.view.cloudflare.origin_dialog = None;
                        r.view.notice = Some(done.message);
                        r.load_origin();
                    }
                    Err(problem) => r.setup_failed(3, problem),
                },
            ),
        }
    }

    /// The setup's second step: waits for the tunnel's first connection on each read.
    fn setup_watch(&mut self, tunnel: Option<TunnelDto>) {
        let waiting = self
            .view
            .cloudflare
            .origin_dialog
            .as_ref()
            .and_then(|d| d.steps.get(1))
            .is_some_and(|s| s.state == CloudflareStepState::Running);
        let (true, Some(started), Some(t)) =
            (waiting, self.cloudflare.origin.setup_started, tunnel)
        else {
            return;
        };
        if t.state == "failed" {
            let problem = t
                .last_error
                .unwrap_or_else(|| "cloudflared did not connect.".to_owned());
            self.setup_failed(1, problem);
        } else if t.connections > 0 && !matches!(t.state.as_str(), "installing" | "connecting") {
            self.step(
                1,
                CloudflareStepState::Done,
                Some(format!("{} connections to Cloudflare", t.connections)),
            );
            self.setup_step(2, Value::Null);
        } else if started.elapsed() > CONNECT_WITHIN {
            self.setup_failed(
                1,
                "cloudflared did not connect within three minutes. The server may not reach Cloudflare on port 7844.".to_owned(),
            );
        }
    }

    fn ssh_open(&mut self) {
        let Some(t) = self
            .cloudflare
            .origin
            .last
            .as_ref()
            .and_then(|o| o.tunnel.clone())
        else {
            return;
        };
        let can_own = self
            .view
            .cloudflare
            .origin
            .as_ref()
            .is_some_and(|o| o.can_own);
        let mut d = dialog(
            CloudflareOriginDialogKind::Ssh,
            "Who may open SSH".to_owned(),
            "The sites already come through the tunnel. This decides what happens to SSH, the one port the tunnel leaves alone until you choose.",
            "Apply",
        );
        d.ssh_modes = ssh_modes(&t.ssh_mode, t.ssh_hostname.is_some(), can_own);
        d.ssh_mode = t.ssh_mode.clone();
        d.mesh_address = t.mesh_address.clone();
        self.set_dialog(d);
        self.ssh_preview();
    }

    fn ssh_mode(&mut self, mode: String) {
        if let Some(d) = self.dialog_mut() {
            d.ssh_mode = mode;
            d.probe = None;
            d.probe_ok = false;
            d.phrase = None;
            d.problem = None;
        }
        self.ssh_preview();
    }

    fn ssh_preview(&mut self) {
        let (Some(id), Some(d)) = (
            self.origin_id(),
            self.view.cloudflare.origin_dialog.as_ref(),
        ) else {
            return;
        };
        let mode = d.ssh_mode.clone();
        let mesh_ready = d.mesh_address.is_some();
        if let Some(d) = self.dialog_mut() {
            d.loading = mode != "mesh" || mesh_ready;
            d.commands.clear();
            d.notes.clear();
            d.firewall_title = None;
        }
        self.refresh_ssh_dialog();
        if mode == "mesh" && !mesh_ready {
            return;
        }
        let asked = mode.clone();
        self.cf(
            "cloudflare.tunnelPreviewSsh",
            Some(json!({"serverId": id, "mode": mode})),
            move |r, result: Result<FirewallDto, String>| match result {
                Ok(preview) => {
                    let Some(d) = r.dialog_mut() else {
                        return;
                    };
                    if d.ssh_mode != asked {
                        return;
                    }
                    d.loading = false;
                    d.firewall_title = Some(commands_title(
                        preview.commands.len(),
                        "The firewall already matches",
                    ));
                    d.commands = preview.commands;
                    d.notes = preview.notes;
                    d.blocked = preview.blocked;
                    d.phrase = preview.confirmation_phrase.filter(|_| asked == "closed");
                    r.refresh_ssh_dialog();
                }
                Err(problem) => r.dialog_failed(problem),
            },
        );
    }

    fn refresh_ssh_dialog(&mut self) {
        let current = self
            .cloudflare
            .origin
            .last
            .as_ref()
            .and_then(|o| o.tunnel.as_ref())
            .map(|t| (t.ssh_mode.clone(), t.ssh_hostname.clone()));
        let Some(d) = self.dialog_mut() else {
            return;
        };
        if d.kind != CloudflareOriginDialogKind::Ssh {
            return;
        }
        let (now, hostname) = current.unwrap_or_default();
        let mode = d.ssh_mode.clone();
        let available = d.ssh_modes.iter().any(|m| m.value == mode && m.available);
        d.danger = mode == "closed";
        d.can_join_mesh = mode == "mesh" && d.mesh_address.is_none();
        d.test_label = match mode.as_str() {
            "cloudflare" => {
                hostname.map(|h| format!("Test SSH through the tunnel at {h}, from the computer"))
            }
            "mesh" if d.mesh_address.is_some() => {
                Some("Test SSH over Mesh, from the computer".to_owned())
            }
            _ => None,
        };
        d.can_test = d.test_label.is_some() && !d.saving;
        if mode == "mesh" {
            d.notes.retain(|n| !n.starts_with("Mesh needs"));
            d.notes.push(
                "Mesh needs the Cloudflare One Client signed in on the computer, since the test and the change go from there."
                    .to_owned(),
            );
        }
        let needs_probe = matches!(mode.as_str(), "cloudflare" | "mesh");
        d.can_apply = !d.loading
            && !d.saving
            && available
            && d.blocked.is_none()
            && (mode != now || !d.commands.is_empty())
            && (!needs_probe || d.probe_ok)
            && (mode != "closed" || d.phrase.is_some());
    }

    fn ssh_test(&mut self) {
        let (Some(id), Some(d)) = (
            self.origin_id(),
            self.view.cloudflare.origin_dialog.as_ref(),
        ) else {
            return;
        };
        if !d.can_test {
            return;
        }
        let route = d.ssh_mode.clone();
        if let Some(d) = self.dialog_mut() {
            d.probe = Some("Testing from the computer...".to_owned());
            d.probe_ok = false;
            d.can_test = false;
        }
        self.cf(
            "cloudflare.tunnelProbeSsh",
            Some(json!({"serverId": id, "route": route})),
            |r, result: Result<ProbeDto, String>| {
                if let Some(d) = r.dialog_mut() {
                    match result {
                        Ok(probe) => {
                            d.probe = Some(probe.message);
                            d.probe_ok = probe.ok;
                        }
                        Err(problem) => {
                            d.probe = Some(problem);
                            d.probe_ok = false;
                        }
                    }
                }
                r.refresh_ssh_dialog();
            },
        );
    }

    fn join_mesh(&mut self) {
        let Some(id) = self.origin_id() else {
            return;
        };
        if let Some(d) = self.dialog_mut() {
            d.saving = true;
        }
        self.cf(
            "cloudflare.tunnelJoinMesh",
            Some(json!({ "serverId": id })),
            |r, result: Result<OkDto, String>| {
                if let Some(d) = r.dialog_mut() {
                    d.saving = false;
                }
                match result {
                    Ok(done) => {
                        r.view.notice = Some(done.message);
                        r.load_origin();
                    }
                    Err(problem) => r.dialog_failed(problem),
                }
            },
        );
    }

    fn ssh_apply(&mut self, phrase: String, password: String) {
        let password = Zeroizing::new(password);
        let (Some(id), Some(d)) = (
            self.origin_id(),
            self.view.cloudflare.origin_dialog.as_ref(),
        ) else {
            return;
        };
        if !d.can_apply {
            return;
        }
        let mode = d.ssh_mode.clone();
        let mut params = Map::new();
        params.insert("serverId".into(), json!(id));
        params.insert("mode".into(), json!(mode));
        if mode == "closed" {
            if phrase.trim().is_empty() || password.is_empty() {
                if let Some(d) = self.dialog_mut() {
                    d.problem =
                        Some("Type the phrase and your password on the server core.".to_owned());
                }
                return;
            }
            params.insert("overrideConfirmation".into(), json!(phrase.trim()));
            params.insert("password".into(), json!(password.as_str()));
        }
        self.origin_change("cloudflare.tunnelApplySsh", Value::Object(params), |_| {});
    }

    fn off_open(&mut self) {
        let name = self.origin_name();
        let mut d = dialog(
            CloudflareOriginDialogKind::Off,
            format!("Turn the tunnel off on {name}"),
            "SSH opens to everyone again. cloudflared stops once you keep the firewall change, and the tunnel is then removed at Cloudflare.",
            "Turn off",
        );
        d.danger = true;
        self.set_dialog(d);
        self.off_preview();
    }

    fn off_preview(&mut self) {
        let (Some(id), Some(d)) = (
            self.origin_id(),
            self.view.cloudflare.origin_dialog.as_ref(),
        ) else {
            return;
        };
        let reopen = d.reopen_web;
        if let Some(d) = self.dialog_mut() {
            d.loading = true;
            d.can_apply = false;
        }
        self.cf(
            "cloudflare.tunnelPreviewOff",
            Some(json!({"serverId": id, "reopenWeb": reopen})),
            |r, result: Result<FirewallDto, String>| match result {
                Ok(preview) => {
                    if let Some(d) = r.dialog_mut() {
                        d.loading = false;
                        d.firewall_title = Some(commands_title(
                            preview.commands.len(),
                            "Nothing in the firewall changes",
                        ));
                        d.commands = preview.commands;
                        d.notes = preview.notes;
                        d.blocked = preview.blocked;
                        d.can_apply = d.blocked.is_none();
                    }
                }
                Err(problem) => r.dialog_failed(problem),
            },
        );
    }

    fn origin_apply(&mut self) {
        let (Some(id), Some(d)) = (self.origin_id(), self.view.cloudflare.origin_dialog.clone())
        else {
            return;
        };
        match d.kind {
            CloudflareOriginDialogKind::LockOn | CloudflareOriginDialogKind::LockOff => {
                if !d.can_apply {
                    return;
                }
                if let Some(input) = self.lock_input() {
                    self.origin_change("cloudflare.originLockApply", input, |_| {});
                }
            }
            CloudflareOriginDialogKind::Setup => self.setup_start(),
            CloudflareOriginDialogKind::Ports => {
                if d.can_apply {
                    self.origin_change(
                        "cloudflare.tunnelClosePorts",
                        json!({ "serverId": id }),
                        |_| {},
                    );
                }
            }
            CloudflareOriginDialogKind::Ssh => self.ssh_apply(String::new(), String::new()),
            CloudflareOriginDialogKind::Off => {
                if !d.can_apply {
                    return;
                }
                self.cloudflare.origin.off_point_back = d.point_back;
                self.origin_change(
                    "cloudflare.tunnelTurnOff",
                    json!({"serverId": id, "reopenWeb": d.reopen_web}),
                    |r| {
                        if let Some(id) = r.origin_id() {
                            let point_back = r.cloudflare.origin.off_point_back;
                            r.cloudflare.origin.cleanups.insert(id, point_back);
                        }
                    },
                );
            }
        }
    }

    fn break_glass(&mut self, enabled: bool, minutes: u32) {
        let Some(id) = self.origin_id() else {
            return;
        };
        self.view.busy = true;
        self.cf(
            "cloudflare.tunnelBreakGlass",
            Some(json!({"serverId": id, "enabled": enabled, "delayMinutes": minutes})),
            |r, result: Result<OkDto, String>| {
                r.view.busy = false;
                match result {
                    Ok(done) => {
                        r.view.notice = Some(done.message);
                        r.load_origin();
                    }
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn firewall_decide(&mut self, method: &'static str) {
        let (Some(id), Some(pending)) = (
            self.origin_id(),
            self.cloudflare
                .origin
                .last
                .as_ref()
                .and_then(|o| o.pending.clone()),
        ) else {
            return;
        };
        self.view.busy = true;
        self.cf(
            method,
            Some(json!({"serverId": id, "changeSetId": pending.id})),
            |r, result: Result<OkDto, String>| {
                r.view.busy = false;
                match result {
                    Ok(done) => {
                        r.view.notice = Some(done.message);
                        r.load_origin();
                    }
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn firewall_revert(&mut self) {
        let Some(pending) = self
            .cloudflare
            .origin
            .last
            .as_ref()
            .and_then(|o| o.pending.clone())
        else {
            return;
        };
        self.ask(
            asking(
                "Revert this firewall change?".to_owned(),
                format!("{} The old rules come back now.", pending.summary),
                "Revert",
            ),
            |runner| runner.firewall_decide("cloudflare.firewallRevert"),
        );
    }
}

#[uniffi::export]
impl Engine {
    /// A saved server's Cloudflare-only origin: its origin lock and Cloudflare Tunnel.
    pub fn cloudflare_open_origin(&self, server_id: String) {
        self.run(move |r| r.open_origin(server_id));
    }

    pub fn cloudflare_close_origin(&self) {
        self.run(|r| {
            r.view.cloudflare.origin = None;
            r.view.cloudflare.origin_dialog = None;
            r.cloudflare.origin.setup_started = None;
        });
    }

    pub fn cloudflare_origin_mode(&self, mode: CloudflareOriginMode) {
        self.run(move |r| r.origin_mode(mode));
    }

    pub fn cloudflare_close_origin_dialog(&self) {
        self.run(|r| {
            if r.cloudflare.origin.setup_started.is_none() {
                r.view.cloudflare.origin_dialog = None;
            }
        });
    }

    /// Applies whatever the open dialog previews; setting up runs its steps one after another.
    pub fn cloudflare_origin_apply(&self) {
        self.run(Runner::origin_apply);
    }

    pub fn cloudflare_lock_open(&self, enable: bool) {
        self.run(move |r| r.lock_open(enable));
    }

    pub fn cloudflare_lock_set_aop(&self, on: bool) {
        self.run(move |r| r.lock_set_aop(on));
    }

    pub fn cloudflare_tunnel_setup_open(&self) {
        self.run(Runner::setup_open);
    }

    pub fn cloudflare_tunnel_setup_account(&self, account_id: String) {
        self.run(move |r| {
            if let Some(d) = r.dialog_mut() {
                d.account = account_id;
                d.acked = false;
            }
            r.refresh_plan_dialog();
        });
    }

    pub fn cloudflare_tunnel_setup_ssh(&self, route: bool, name: String) {
        self.run(move |r| {
            if let Some(d) = r.dialog_mut() {
                d.route_ssh = route;
                d.ssh_name = name;
            }
            r.refresh_plan_dialog();
        });
    }

    /// The person understands that names outside the account stop answering.
    pub fn cloudflare_tunnel_setup_ack(&self, acked: bool) {
        self.run(move |r| {
            if let Some(d) = r.dialog_mut() {
                d.acked = acked;
            }
            r.refresh_plan_dialog();
        });
    }

    pub fn cloudflare_tunnel_ports_open(&self) {
        self.run(Runner::ports_open);
    }

    pub fn cloudflare_tunnel_ssh_open(&self) {
        self.run(Runner::ssh_open);
    }

    pub fn cloudflare_tunnel_ssh_mode(&self, mode: String) {
        self.run(move |r| r.ssh_mode(mode));
    }

    /// Tests SSH the chosen way, from the computer, which is whose way in the change keeps.
    pub fn cloudflare_tunnel_ssh_test(&self) {
        self.run(Runner::ssh_test);
    }

    pub fn cloudflare_tunnel_join_mesh(&self) {
        self.run(Runner::join_mesh);
    }

    /// Closing SSH takes the guard's phrase and the password on the server core.
    pub fn cloudflare_tunnel_ssh_apply(&self, phrase: String, password: String) {
        self.run(move |r| r.ssh_apply(phrase, password));
    }

    pub fn cloudflare_tunnel_off_open(&self) {
        self.run(Runner::off_open);
    }

    pub fn cloudflare_tunnel_off_reopen(&self, reopen_web: bool) {
        self.run(move |r| {
            if let Some(d) = r.dialog_mut() {
                d.reopen_web = reopen_web;
            }
            r.off_preview();
        });
    }

    pub fn cloudflare_tunnel_off_point_back(&self, point_back: bool) {
        self.run(move |r| {
            if let Some(d) = r.dialog_mut() {
                d.point_back = point_back;
            }
        });
    }

    pub fn cloudflare_tunnel_break_glass(&self, enabled: bool, delay_minutes: u32) {
        self.run(move |r| r.break_glass(enabled, delay_minutes));
    }

    pub fn cloudflare_firewall_keep(&self) {
        self.run(|r| r.firewall_decide("cloudflare.firewallKeep"));
    }

    pub fn cloudflare_firewall_revert(&self) {
        self.run(Runner::firewall_revert);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names_and_lists_read_like_the_desktop() {
        assert!(is_hostname("ssh.example.com"));
        assert!(!is_hostname("ssh"));
        assert!(!is_hostname("-ssh.example.com"));
        assert!(!is_hostname("ssh.example.c0m"));
        let five: Vec<String> = (1..=5).map(|i| format!("r{i}")).collect();
        assert_eq!(short_list(&five), "r1, r2, r3, r4 and 1 more");
        assert_eq!(commands_title(0, "Nothing"), "Nothing");
        assert_eq!(commands_title(2, "Nothing"), "2 firewall commands");
        assert_eq!(minutes_label(30), "30 min");
        assert_eq!(minutes_label(120), "2 h");
    }
}
