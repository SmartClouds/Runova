//! What the Cloudflare screens show (E98 onward). Re-exported from `view`, with the other screens.

use crate::view::BiometricRequestView;

/// How something stands, for its colour: fine, worth a look, or broken.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum CloudflareTone {
    #[default]
    Good,
    Warning,
    Bad,
}

/// The tabs of a domain, in the desktop's order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum CloudflareTab {
    #[default]
    Dns,
    Ssl,
    Caching,
    Security,
    Access,
    Servers,
    Turnstile,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareWidgetView {
    pub sitekey: String,
    pub name: String,
    pub domains: Vec<String>,
    pub mode_label: String,
    pub clearance_label: String,
    /// The HTML that puts the widget on a page, with its site key in.
    pub snippet: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareTurnstileView {
    pub loading: bool,
    pub problem: Option<String>,
    pub widgets: Vec<CloudflareWidgetView>,
}

/// A widget as its form holds it; the same shape goes back when it is saved.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WidgetDraft {
    pub name: String,
    pub domains: Vec<String>,
    pub mode: String,
    pub clearance: String,
    pub region: String,
    pub offlabel: bool,
    pub ephemeral_id: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareWidgetFormView {
    /// None for a new widget.
    pub sitekey: Option<String>,
    pub title: String,
    pub draft: WidgetDraft,
    pub modes: Vec<CloudflareOptionView>,
    pub clearances: Vec<CloudflareOptionView>,
    pub regions: Vec<CloudflareOptionView>,
    pub problem: Option<String>,
    pub saving: bool,
}

/// A widget's secret, on screen after the phone's own check, and wiped when it goes.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareRevealedSecretView {
    pub sitekey: String,
    pub name: String,
    pub value: String,
}

impl std::fmt::Debug for CloudflareRevealedSecretView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudflareRevealedSecretView")
            .field("sitekey", &self.sitekey)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareDnsServerView {
    pub id: String,
    pub name: String,
    /// It holds a DNS token for this domain, so it can get wildcard certificates.
    pub has_token: bool,
    /// Runova made the token, so removing it deletes it at Cloudflare too.
    pub made_here: bool,
    pub detail: String,
    pub loading: bool,
    pub busy: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareServersView {
    pub loading: bool,
    pub problem: Option<String>,
    pub servers: Vec<CloudflareDnsServerView>,
}

/// Where a name stands with the email code gate.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum CloudflareGateState {
    #[default]
    Off,
    On,
    /// An Access application the app did not make: shown, never changed.
    Elsewhere,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareGateHostView {
    pub hostname: String,
    /// "Core server", "Site blog", "SSH", or none for a name no server claims.
    pub role_label: Option<String>,
    pub proxied: bool,
    /// Its record can be put behind the proxy from here.
    pub can_proxy: bool,
    pub state: CloudflareGateState,
    /// "Email code, 3 people, 24 hours", "Open to everyone", and so on.
    pub summary: String,
    /// The core server's domain, where this computer needs a pass.
    pub core: bool,
    pub this_computer_pass: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareIpLimitView {
    pub id: String,
    /// "app.example.com/admin and below", "every name in example.com".
    pub target: String,
    pub ips: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareAccessView {
    pub loading: bool,
    pub problem: Option<String>,
    /// Email codes are turned on for the account.
    pub ready: bool,
    /// The account has no Zero Trust team yet, so turning codes on needs a team name.
    pub needs_team: bool,
    pub team_domain: Option<String>,
    pub hosts: Vec<CloudflareGateHostView>,
    pub limits: Vec<CloudflareIpLimitView>,
    pub limits_problem: Option<String>,
}

/// Someone who may ask for a code: an address, or everyone at a domain.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflarePersonView {
    pub value: String,
    pub domain: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareEmailGateFormView {
    pub hostname: String,
    /// The name has a gate already; the form changes it.
    pub existing: bool,
    pub people: Vec<CloudflarePersonView>,
    /// What could not be used, with why: "nope: Type an email address...".
    pub invalid: Vec<String>,
    pub session: String,
    pub sessions: Vec<CloudflareOptionView>,
    /// Who can open the name and for how long, in one sentence.
    pub preview: String,
    pub core_note: Option<String>,
    /// The people came from the last list used.
    pub from_last: bool,
    pub saving: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareIpLimitFormView {
    /// None for a new limit.
    pub rule_id: Option<String>,
    /// The names behind the proxy, and "*" for every name.
    pub names: Vec<CloudflareOptionView>,
    /// The chosen name, "*" for every name, or empty until one is picked.
    pub hostname: String,
    pub whole_site: bool,
    pub path: String,
    pub prefix: bool,
    pub path_problem: Option<String>,
    pub ips: Vec<String>,
    pub invalid: Vec<String>,
    /// The computer's own address on the internet, when it is known.
    pub this_computer: Option<String>,
    pub can_add_this_computer: bool,
    /// The list leaves the computer out, so it would get the block page too.
    pub shut_out: bool,
    pub preview: String,
    pub can_save: bool,
    pub saving: bool,
    pub problem: Option<String>,
}

/// A setting is a switch, or a choice between a few values.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum CloudflareSettingKind {
    #[default]
    Switch,
    Choice,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareOptionView {
    pub value: String,
    pub label: String,
}

/// One setting, drawn the same way whatever it is: its name, what it does, and its value.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareSettingView {
    /// What `cloudflare_change_setting` takes back.
    pub key: String,
    pub title: String,
    pub detail: String,
    pub kind: CloudflareSettingKind,
    /// The chosen option's value, for a choice.
    pub value: String,
    /// Whether a switch is on.
    pub on: bool,
    pub options: Vec<CloudflareOptionView>,
    pub editable: bool,
    /// What the current value means, when it is worth saying.
    pub note: Option<String>,
    pub note_tone: CloudflareTone,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareSettingsGroup {
    pub title: String,
    pub detail: String,
    pub items: Vec<CloudflareSettingView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareRuleView {
    pub id: String,
    pub description: String,
    pub action_label: String,
    pub tone: CloudflareTone,
    pub expression: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareAccessRuleView {
    pub id: String,
    pub value: String,
    /// "IP address", "IP range", "Country", "Network (ASN)".
    pub target_label: String,
    pub mode_label: String,
    pub tone: CloudflareTone,
    pub notes: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareRulesView {
    pub loading: bool,
    pub problem: Option<String>,
    pub custom: Vec<CloudflareRuleView>,
    pub access: Vec<CloudflareAccessRuleView>,
    pub access_problem: Option<String>,
}

/// A small form's state: why the computer refused it, and whether it is on its way.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareFormView {
    pub problem: Option<String>,
    pub saving: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareScreen {
    pub loading: bool,
    /// At least one account is connected on the computer.
    pub configured: bool,
    /// Why the accounts could not be read, in the computer's words.
    pub problem: Option<String>,
    pub accounts: Vec<CloudflareAccountView>,
    pub zone: Option<CloudflareZoneView>,
    pub token_form: Option<CloudflareTokenFormView>,
    pub add_domain: Option<CloudflareAddDomainView>,
    pub record_form: Option<CloudflareRecordFormView>,
    pub point_domain: Option<CloudflarePointDomainView>,
    pub rule_builder: Option<CloudflareFormView>,
    pub access_rule_form: Option<CloudflareFormView>,
    pub email_gate_form: Option<CloudflareEmailGateFormView>,
    pub ip_limit_form: Option<CloudflareIpLimitFormView>,
    pub widget_form: Option<CloudflareWidgetFormView>,
    pub revealed_secret: Option<CloudflareRevealedSecretView>,
    /// The phone's own check, before a pasted token leaves it.
    pub biometric: Option<BiometricRequestView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareAccountView {
    pub id: String,
    pub label: String,
    /// "Connected", "Needs 2 permissions", "Locked", "Expired".
    pub status_label: String,
    pub tone: CloudflareTone,
    /// One more line about it, when there is something to do.
    pub detail: Option<String>,
    /// Permissions the token lacks, as Cloudflare's token page names them.
    pub missing: Vec<String>,
    pub unverified: Vec<String>,
    pub locked: bool,
    pub zones: Vec<CloudflareZoneRow>,
    pub zones_loading: bool,
    pub zones_problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareZoneRow {
    pub id: String,
    pub name: String,
    pub status_label: String,
    pub active: bool,
    pub plan: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareZoneView {
    pub id: String,
    pub name: String,
    pub account_id: String,
    pub status_label: String,
    pub active: bool,
    /// Waiting for the registrar to use Cloudflare's name servers.
    pub pending: bool,
    pub plan: String,
    pub name_servers: Vec<String>,
    pub tab: CloudflareTab,
    /// None until the settings are read, and when the token may not read them.
    pub toggles: Option<CloudflareTogglesView>,
    pub dns: CloudflareDnsView,
    /// The settings of the open tab, in groups, as the desktop's cards have them.
    pub settings: Vec<CloudflareSettingsGroup>,
    pub rules: CloudflareRulesView,
    pub access: CloudflareAccessView,
    pub turnstile: CloudflareTurnstileView,
    pub servers: CloudflareServersView,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareTogglesView {
    pub dev_mode: bool,
    /// "Off", "On, 2 h 59 min left".
    pub dev_mode_detail: String,
    pub dev_mode_editable: bool,
    pub under_attack: bool,
    pub under_attack_editable: bool,
    pub ai_bots_blocked: bool,
    /// "Off", "On, everywhere", "On, ad pages".
    pub ai_bots_detail: String,
    /// The token may read bot settings at all.
    pub ai_bots_available: bool,
    /// One of the switches is being written.
    pub saving: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareDnsView {
    pub loading: bool,
    pub problem: Option<String>,
    pub records: Vec<CloudflareRecordView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareRecordView {
    pub id: String,
    pub record_type: String,
    /// "@" for the domain itself, else the part before it ("www").
    pub name: String,
    pub full_name: String,
    /// What it points at, written out for the list (an MX shows its priority, a CAA its tag).
    pub content: String,
    pub proxied: bool,
    pub proxiable: bool,
    pub ttl_label: String,
    pub editable: bool,
    pub priority: Option<u32>,
    pub comment: String,
}

/// A record as the editor holds it; the same shape goes back when it is saved.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RecordDraft {
    pub record_type: String,
    pub name: String,
    pub content: String,
    /// Seconds, or 1 for automatic.
    pub ttl: u32,
    pub proxied: bool,
    pub priority: u32,
    pub comment: String,
    pub caa_flags: u8,
    pub caa_tag: String,
    pub caa_value: String,
    pub srv_priority: u32,
    pub srv_weight: u32,
    pub srv_port: u32,
    pub srv_target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareRecordFormView {
    /// None for a new record.
    pub record_id: Option<String>,
    pub title: String,
    pub zone_name: String,
    pub draft: RecordDraft,
    pub problem: Option<String>,
    pub saving: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareTokenFormView {
    /// The account whose token is replaced, or None to connect another account.
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub problem: Option<String>,
    pub saving: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareChoiceView {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflareAddDomainView {
    pub account_id: String,
    pub choices: Vec<CloudflareChoiceView>,
    pub loading: bool,
    pub problem: Option<String>,
    pub saving: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflarePointDomainView {
    pub zone_name: String,
    pub servers: Vec<CloudflareChoiceView>,
    pub loading: bool,
    pub plan: Option<CloudflarePointPlanView>,
    pub problem: Option<String>,
    pub saving: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflarePointPlanView {
    /// What will happen, in one sentence.
    pub summary: String,
    pub changes: Vec<CloudflarePlannedChangeView>,
    pub up_to_date: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CloudflarePlannedChangeView {
    /// "Add", "Change", "Remove", "Keep".
    pub action_label: String,
    pub tone: CloudflareTone,
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub previous: Option<String>,
    pub reason: Option<String>,
}
