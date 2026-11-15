//! A domain's settings (E99): SSL/TLS, caching and purge, the security level, AI bots, WAF custom
//! rules and IP access rules. Every setting is described here as a switch or a choice in the
//! desktop's words, so the two phones draw them the same way without knowing what they are.

use super::{BotsDto, OkDto, SettingsDto, ValueSetting, asking, remaining};
use crate::engine::{Engine, Runner};
use crate::view::{
    CloudflareAccessRuleView, CloudflareFormView, CloudflareOptionView, CloudflareRuleView,
    CloudflareSettingKind, CloudflareSettingView, CloudflareSettingsGroup, CloudflareTab,
    CloudflareTone,
};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_DESCRIPTION: usize = 120;
const DEFAULT_LEVEL: &str = "medium";

/// The browser cache TTLs Cloudflare accepts, in seconds; 0 respects the server's own headers.
const BROWSER_CACHE_TTLS: [u32; 28] = [
    0, 30, 60, 120, 300, 1200, 1800, 3600, 7200, 10800, 14400, 18000, 28800, 43200, 57600, 72000,
    86400, 172800, 259200, 345600, 432000, 691200, 1382400, 2073600, 2678400, 5356800, 16070400,
    31536000,
];

#[derive(Deserialize, Clone)]
pub(super) struct RuleDto {
    id: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    expression: String,
    #[serde(default)]
    action: String,
    #[serde(default = "yes")]
    enabled: bool,
}

#[derive(Deserialize, Clone)]
pub(super) struct AccessRuleDto {
    id: String,
    mode: String,
    target: String,
    value: String,
    #[serde(default)]
    notes: String,
}

fn yes() -> bool {
    true
}

fn option(value: &str, label: &str) -> CloudflareOptionView {
    CloudflareOptionView {
        value: value.to_owned(),
        label: label.to_owned(),
    }
}

fn text_of(setting: &ValueSetting) -> String {
    match &setting.value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn switch(key: &str, title: &str, detail: &str, on: bool, editable: bool) -> CloudflareSettingView {
    CloudflareSettingView {
        key: key.to_owned(),
        title: title.to_owned(),
        detail: detail.to_owned(),
        kind: CloudflareSettingKind::Switch,
        value: if on { "on" } else { "off" }.to_owned(),
        on,
        options: Vec::new(),
        editable,
        note: None,
        note_tone: CloudflareTone::Good,
    }
}

fn choice(
    key: &str,
    title: &str,
    detail: &str,
    value: String,
    options: Vec<CloudflareOptionView>,
    editable: bool,
) -> CloudflareSettingView {
    CloudflareSettingView {
        key: key.to_owned(),
        title: title.to_owned(),
        detail: detail.to_owned(),
        kind: CloudflareSettingKind::Choice,
        value,
        on: false,
        options,
        editable,
        note: None,
        note_tone: CloudflareTone::Good,
    }
}

fn with_note(
    mut item: CloudflareSettingView,
    note: &str,
    tone: CloudflareTone,
) -> CloudflareSettingView {
    item.note = Some(note.to_owned());
    item.note_tone = tone;
    item
}

fn ssl_label(mode: &str) -> &str {
    match mode {
        "off" => "Off (no HTTPS)",
        "flexible" => "Flexible",
        "full" => "Full",
        "strict" => "Full (strict)",
        "origin_pull" => "Strict (SSL-only origin pull)",
        other => other,
    }
}

const STRICT_NEEDS: &str =
    "Full (strict) needs a trusted certificate on the server, such as one from Let's Encrypt.";

/// What a proxied domain's SSL/TLS mode means for its visitors, as the desktop says it.
fn ssl_advice(mode: &str) -> (String, CloudflareTone) {
    match mode {
        "strict" | "origin_pull" => (
            "Cloudflare encrypts the connection to your server and checks the server's certificate. This is the safest mode.".to_owned(),
            CloudflareTone::Good,
        ),
        "full" => (
            format!("The connection to your server is encrypted, but its certificate is not checked, so anyone in between could pose as it. {STRICT_NEEDS}"),
            CloudflareTone::Warning,
        ),
        "flexible" => (
            format!("Cloudflare reaches your server over plain HTTP, and a server that redirects to HTTPS sends visitors round in a loop. {STRICT_NEEDS}"),
            CloudflareTone::Bad,
        ),
        _ => (format!("Visitors get no HTTPS at all. {STRICT_NEEDS}"), CloudflareTone::Bad),
    }
}

fn cache_level_label(level: &str) -> &str {
    match level {
        "aggressive" => "Standard",
        "simplified" => "Ignore query string",
        "basic" => "No query string",
        other => other,
    }
}

fn cache_level_description(level: &str) -> &str {
    match level {
        "aggressive" => "Caches static files, keeping a separate copy for every query string.",
        "simplified" => "Caches static files and serves the same copy whatever the query string.",
        "basic" => "Caches static files only when the address has no query string.",
        _ => "",
    }
}

pub(super) fn level_label(level: &str) -> &str {
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

fn ai_bots_label(value: &str) -> &str {
    match value {
        "disabled" => "Off",
        "only_on_ad_pages" => "On ad pages",
        "block" => "Everywhere",
        other => other,
    }
}

fn ai_bots_description(value: &str) -> &str {
    match value {
        "disabled" => "AI crawlers can reach every page, as long as robots.txt lets them.",
        "only_on_ad_pages" => {
            "AI crawlers are blocked on hostnames that show ads, and can reach the rest."
        }
        "block" => "Cloudflare blocks known AI scrapers and crawlers on every page.",
        _ => "",
    }
}

fn count(amount: u32, unit: &str) -> String {
    format!("{amount} {unit}{}", if amount == 1 { "" } else { "s" })
}

/// A browser cache TTL as Cloudflare's dashboard writes it: "2 hours", "1 month", "1 year".
fn browser_ttl_label(seconds: u32) -> String {
    match seconds {
        0 => "Respect existing headers".to_owned(),
        31_536_000 => "1 year".to_owned(),
        // Cloudflare's months are 31 days each.
        s if s.is_multiple_of(2_678_400) => count(s / 2_678_400, "month"),
        s if s.is_multiple_of(86_400) => count(s / 86_400, "day"),
        s if s.is_multiple_of(3600) => count(s / 3600, "hour"),
        s if s.is_multiple_of(60) => count(s / 60, "minute"),
        s => count(s, "second"),
    }
}

fn editable(setting: Option<&ValueSetting>, saving: bool) -> bool {
    setting.is_some_and(|s| s.editable) && !saving
}

/// The open tab's settings, in the groups the desktop's cards have.
pub(super) fn groups(
    tab: CloudflareTab,
    zone: &str,
    settings: &SettingsDto,
    bots: Option<&BotsDto>,
    saving: bool,
) -> Vec<CloudflareSettingsGroup> {
    match tab {
        CloudflareTab::Dns => Vec::new(),
        CloudflareTab::Ssl => vec![ssl_group(zone, settings, saving)],
        CloudflareTab::Caching => vec![caching_group(zone, settings, saving)],
        CloudflareTab::Security => {
            let mut groups = vec![CloudflareSettingsGroup {
                title: "Protection".to_owned(),
                detail: format!("Who gets a check before reaching {zone}."),
                items: vec![choice(
                    "securityLevel",
                    "Security level",
                    "How suspicious a visitor has to look before Cloudflare checks them.",
                    text_of(&settings.security_level),
                    [
                        "off",
                        "essentially_off",
                        "low",
                        "medium",
                        "high",
                        "under_attack",
                    ]
                    .iter()
                    .map(|level| option(level, level_label(level)))
                    .collect(),
                    settings.security_level.editable && !saving,
                )],
            }];
            if let Some(bots) = bots {
                groups.push(bots_group(zone, bots, saving));
            }
            groups
        }
    }
}

fn ssl_group(zone: &str, settings: &SettingsDto, saving: bool) -> CloudflareSettingsGroup {
    let mut items = Vec::new();
    if let Some(ssl) = &settings.ssl {
        let mode = text_of(ssl);
        let mut modes = vec!["off", "flexible", "full", "strict"];
        if mode == "origin_pull" {
            modes.push("origin_pull");
        }
        let (advice, tone) = ssl_advice(&mode);
        items.push(with_note(
            choice(
                "ssl",
                "SSL/TLS mode",
                "How Cloudflare connects to your server.",
                mode,
                modes.iter().map(|m| option(m, ssl_label(m))).collect(),
                editable(Some(ssl), saving),
            ),
            &advice,
            tone,
        ));
    }
    let toggle = |key: &str, title: &str, detail: &str, setting: &Option<ValueSetting>| {
        setting.as_ref().map(|s| {
            switch(
                key,
                title,
                detail,
                matches!(s.value.as_str(), Some("on" | "zrt")),
                editable(Some(s), saving),
            )
        })
    };
    items.extend(toggle(
        "alwaysUseHttps",
        "Always Use HTTPS",
        "Sends visitors who ask for http:// to the https:// address.",
        &settings.always_use_https,
    ));
    items.extend(toggle(
        "automaticHttpsRewrites",
        "Automatic HTTPS Rewrites",
        "Fixes mixed content by loading http:// links on your pages over https://.",
        &settings.automatic_https_rewrites,
    ));
    if let Some(tls) = &settings.min_tls_version {
        items.push(choice(
            "minTlsVersion",
            "Minimum TLS version",
            "The oldest TLS version a visitor's browser may connect with.",
            text_of(tls),
            ["1.0", "1.1", "1.2", "1.3"]
                .iter()
                .map(|v| option(v, &format!("TLS {v}")))
                .collect(),
            editable(Some(tls), saving),
        ));
    }
    items.extend(toggle(
        "tls13",
        "TLS 1.3",
        "The newest TLS version: faster to connect and drops older ciphers.",
        &settings.tls13,
    ));
    CloudflareSettingsGroup {
        title: "SSL/TLS".to_owned(),
        detail: format!("How visitors and Cloudflare reach {zone} over HTTPS."),
        items,
    }
}

fn caching_group(zone: &str, settings: &SettingsDto, saving: bool) -> CloudflareSettingsGroup {
    let dev = &settings.development_mode;
    let on = dev.value.as_str() == Some("on");
    let mut development = switch(
        "developmentMode",
        "Development mode",
        "Skips the cache for three hours, so changes to the site show at once.",
        on,
        dev.editable && !saving,
    );
    let left = remaining(dev.seconds_remaining);
    if on && !left.is_empty() {
        development.note = Some(format!("On, {left}"));
        development.note_tone = CloudflareTone::Warning;
    }
    let mut items = vec![development];
    if let Some(level) = &settings.cache_level {
        let value = text_of(level);
        let note = cache_level_description(&value).to_owned();
        items.push(with_note(
            choice(
                "cacheLevel",
                "Caching level",
                "Which addresses Cloudflare treats as the same cached file.",
                value,
                ["aggressive", "simplified", "basic"]
                    .iter()
                    .map(|l| option(l, cache_level_label(l)))
                    .collect(),
                editable(Some(level), saving),
            ),
            &note,
            CloudflareTone::Good,
        ));
    }
    if let Some(ttl) = &settings.browser_cache_ttl {
        items.push(choice(
            "browserCacheTtl",
            "Browser cache TTL",
            "How long a visitor's browser keeps files before it asks again.",
            text_of(ttl),
            BROWSER_CACHE_TTLS
                .iter()
                .map(|s| option(&s.to_string(), &browser_ttl_label(*s)))
                .collect(),
            editable(Some(ttl), saving),
        ));
    }
    CloudflareSettingsGroup {
        title: "Caching".to_owned(),
        detail: format!("How {zone} is cached at Cloudflare and in browsers."),
        items,
    }
}

fn bots_group(zone: &str, bots: &BotsDto, saving: bool) -> CloudflareSettingsGroup {
    let mut items = vec![
        with_note(
            choice(
                "aiBots",
                "Block AI bots",
                "Stops known AI scrapers and crawlers before they reach the site.",
                bots.ai_bots.clone(),
                ["disabled", "only_on_ad_pages", "block"]
                    .iter()
                    .map(|v| option(v, ai_bots_label(v)))
                    .collect(),
                !saving,
            ),
            ai_bots_description(&bots.ai_bots),
            CloudflareTone::Good,
        ),
        switch(
            "aiLabyrinth",
            "AI Labyrinth",
            "Sends AI crawlers that ignore your rules into a maze of decoy pages.",
            bots.ai_labyrinth,
            !saving,
        ),
        switch(
            "preferenceSync",
            "Bot Preference Sync",
            "Puts your AI bot choices at the top of the site's robots.txt.",
            bots.preference_sync,
            !saving,
        ),
    ];
    if let Some(fight) = bots.fight_mode {
        items.push(switch(
            "fightMode",
            "Bot Fight Mode",
            "Challenges traffic that looks like a known bot, on every request.",
            fight,
            !saving,
        ));
    }
    CloudflareSettingsGroup {
        title: "AI bots".to_owned(),
        detail: format!("Which AI crawlers can reach {zone}, and what robots.txt tells them."),
        items,
    }
}

const BOT_KEYS: [&str; 4] = ["aiBots", "aiLabyrinth", "preferenceSync", "fightMode"];
const SWITCH_KEYS: [&str; 4] = [
    "developmentMode",
    "alwaysUseHttps",
    "automaticHttpsRewrites",
    "tls13",
];

/// What a toast says once a bot setting has changed, as the desktop says it.
fn bot_notice(key: &str, value: &Value) -> String {
    let on = value.as_bool() == Some(true);
    let state = if on { "on" } else { "off" };
    match key {
        "aiBots" => match value.as_str() {
            Some("disabled") => "AI bots are not blocked any more.".to_owned(),
            Some("block") => "AI bots are blocked everywhere now.".to_owned(),
            _ => "AI bots are blocked on pages with ads now.".to_owned(),
        },
        "aiLabyrinth" => format!("AI Labyrinth is {state}."),
        "preferenceSync" if on => {
            "Bot Preference Sync is on. robots.txt now starts with your AI bot choices.".to_owned()
        }
        "preferenceSync" => "Bot Preference Sync is off.".to_owned(),
        _ => format!("Bot Fight Mode is {state}."),
    }
}

fn rule_action_label(action: &str) -> &str {
    match action {
        "block" => "Block",
        "managed_challenge" => "Managed challenge",
        "challenge" => "Interactive challenge",
        "js_challenge" => "JavaScript challenge",
        "skip" => "Allow (skip the other rules)",
        "log" => "Log",
        other => other,
    }
}

fn rule_view(rule: &RuleDto) -> CloudflareRuleView {
    CloudflareRuleView {
        id: rule.id.clone(),
        description: if rule.description.is_empty() {
            "No description".to_owned()
        } else {
            rule.description.clone()
        },
        action_label: rule_action_label(&rule.action).to_owned(),
        tone: match rule.action.as_str() {
            "block" => CloudflareTone::Bad,
            "skip" | "log" => CloudflareTone::Good,
            _ => CloudflareTone::Warning,
        },
        expression: rule.expression.clone(),
        enabled: rule.enabled,
    }
}

fn mode_label(mode: &str) -> &str {
    match mode {
        "block" => "Block",
        "challenge" => "Interactive challenge",
        "js_challenge" => "JavaScript challenge",
        "managed_challenge" => "Managed challenge",
        "whitelist" => "Allow",
        other => other,
    }
}

fn access_view(rule: &AccessRuleDto) -> CloudflareAccessRuleView {
    CloudflareAccessRuleView {
        id: rule.id.clone(),
        value: rule.value.clone(),
        target_label: match rule.target.as_str() {
            "ip" => "IP address",
            "ip6" => "IPv6 address",
            "ip_range" => "IP range",
            "country" => "Country",
            "asn" => "Network (ASN)",
            other => other,
        }
        .to_owned(),
        mode_label: mode_label(&rule.mode).to_owned(),
        tone: match rule.mode.as_str() {
            "block" => CloudflareTone::Bad,
            "whitelist" => CloudflareTone::Good,
            _ => CloudflareTone::Warning,
        },
        notes: rule.notes.clone(),
    }
}

/// The entries of a list typed with commas, spaces or one per line.
fn split_list(text: &str) -> Vec<String> {
    text.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|piece| !piece.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A description to start from, saying what the rule does, as the desktop's builder suggests.
fn describe_rule(spec: &Value) -> String {
    let list = |key: &str| -> Vec<String> {
        spec[key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let text = match spec["kind"].as_str() {
        Some("block-countries") => format!("Block {}", list("countries").join(", ")),
        Some("challenge-path") => format!(
            "Challenge {}{}",
            spec["path"].as_str().unwrap_or_default(),
            if spec["match"] == "prefix" {
                " and below"
            } else {
                ""
            }
        ),
        _ => format!("Allow {}", list("ips").join(", ")),
    };
    if text.chars().count() > MAX_DESCRIPTION {
        let cut: String = text.chars().take(MAX_DESCRIPTION - 3).collect();
        format!("{cut}...")
    } else {
        text
    }
}

impl Runner {
    pub(super) fn load_tab_data(&mut self) {
        let Some(zone) = self.view.cloudflare.zone.as_ref() else {
            return;
        };
        if zone.tab == CloudflareTab::Security {
            self.load_rules();
        }
    }

    fn open_tab(&mut self, tab: CloudflareTab) {
        let Some(zone) = self.view.cloudflare.zone.as_mut() else {
            return;
        };
        zone.tab = tab;
        self.redraw_zone();
        self.load_tab_data();
    }

    fn load_rules(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        if let Some(view) = self.view.cloudflare.zone.as_mut() {
            view.rules.loading = self.cloudflare.custom_rules.is_empty();
        }
        let asked = zone.clone();
        self.cf(
            "cloudflare.customRules",
            Some(json!({ "zoneId": zone.clone() })),
            move |r, result: Result<Vec<RuleDto>, String>| {
                if r.zone_id().as_deref() != Some(asked.as_str()) {
                    return;
                }
                match result {
                    Ok(rules) => r.keep_rules(rules),
                    Err(problem) => {
                        if let Some(view) = r.view.cloudflare.zone.as_mut() {
                            view.rules.loading = false;
                            view.rules.problem = Some(problem);
                        }
                    }
                }
            },
        );
        let asked = zone.clone();
        self.cf(
            "cloudflare.accessRules",
            Some(json!({ "zoneId": zone })),
            move |r, result: Result<Vec<AccessRuleDto>, String>| {
                if r.zone_id().as_deref() != Some(asked.as_str()) {
                    return;
                }
                match result {
                    Ok(rules) => r.keep_access_rules(rules),
                    Err(problem) => {
                        if let Some(view) = r.view.cloudflare.zone.as_mut() {
                            view.rules.access_problem = Some(problem);
                        }
                    }
                }
            },
        );
    }

    fn keep_rules(&mut self, rules: Vec<RuleDto>) {
        if let Some(view) = self.view.cloudflare.zone.as_mut() {
            view.rules.loading = false;
            view.rules.problem = None;
            view.rules.custom = rules.iter().map(rule_view).collect();
        }
        self.cloudflare.custom_rules = rules;
    }

    fn keep_access_rules(&mut self, rules: Vec<AccessRuleDto>) {
        if let Some(view) = self.view.cloudflare.zone.as_mut() {
            view.rules.access_problem = None;
            view.rules.access = rules.iter().map(access_view).collect();
        }
        self.cloudflare.access_rules = rules;
    }

    fn setting_title(&self, key: &str) -> (String, Option<String>) {
        let item = self
            .view
            .cloudflare
            .zone
            .as_ref()
            .and_then(|z| {
                z.settings
                    .iter()
                    .flat_map(|g| g.items.iter())
                    .find(|i| i.key == key)
            })
            .cloned();
        match item {
            Some(item) => (item.title, None),
            None => (key.to_owned(), None),
        }
    }

    fn choice_label(&self, key: &str, value: &str) -> String {
        self.view
            .cloudflare
            .zone
            .as_ref()
            .and_then(|z| {
                z.settings
                    .iter()
                    .flat_map(|g| g.items.iter())
                    .find(|i| i.key == key)
            })
            .and_then(|i| i.options.iter().find(|o| o.value == value))
            .map_or_else(|| value.to_owned(), |o| o.label.clone())
    }

    /// Changes any setting the tabs show, by the key its view carries.
    fn change_setting_by_key(&mut self, key: String, value: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let on = value == "on" || value == "true";
        if BOT_KEYS.contains(&key.as_str()) {
            let sent = if key == "aiBots" {
                Value::String(value)
            } else {
                Value::Bool(on)
            };
            let notice = bot_notice(&key, &sent);
            self.set_toggles_saving(true);
            self.view.error = None;
            self.cf(
                "cloudflare.changeBotSetting",
                Some(json!({"zoneId": zone, "change": {"setting": key, "value": sent}})),
                move |r, result: Result<BotsDto, String>| {
                    r.cloudflare.saving = false;
                    match result {
                        Ok(bots) => {
                            r.view.notice = Some(notice);
                            r.show_toggles(Some(bots), false);
                        }
                        Err(problem) => {
                            r.view.error = Some(problem);
                            r.redraw_zone();
                        }
                    }
                },
            );
            return;
        }
        let (title, _) = self.setting_title(&key);
        let (sent, notice) = if SWITCH_KEYS.contains(&key.as_str()) {
            let notice = match (key.as_str(), on) {
                ("developmentMode", true) => "Development mode is on for three hours.".to_owned(),
                (_, true) => format!("{title} is on."),
                (_, false) => format!("{title} is off."),
            };
            (
                Value::String(if on { "on" } else { "off" }.to_owned()),
                notice,
            )
        } else if key == "browserCacheTtl" {
            let Ok(seconds) = value.parse::<u32>() else {
                return;
            };
            (
                json!(seconds),
                format!("{title} is {} now.", browser_ttl_label(seconds)),
            )
        } else {
            if key == "securityLevel" && value == "under_attack" {
                let before = self
                    .cloudflare
                    .settings
                    .as_ref()
                    .and_then(|s| s.security_level.value.as_str().map(str::to_owned))
                    .filter(|level| level != "under_attack")
                    .unwrap_or_else(|| DEFAULT_LEVEL.to_owned());
                self.cloudflare
                    .level_before_attack
                    .insert(zone.clone(), before);
            }
            let label = self.choice_label(&key, &value);
            (Value::String(value), format!("{title} is {label} now."))
        };
        self.change_setting(json!({"setting": key, "value": sent}), notice);
    }

    fn rule_description(&self, id: &str) -> String {
        self.cloudflare
            .custom_rules
            .iter()
            .find(|r| r.id == id)
            .map(|r| {
                if r.description.is_empty() {
                    "this rule".to_owned()
                } else {
                    r.description.clone()
                }
            })
            .unwrap_or_else(|| "this rule".to_owned())
    }

    fn set_rule_enabled(&mut self, id: String, enabled: bool) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let name = self.rule_description(&id);
        self.view.error = None;
        self.cf(
            "cloudflare.setCustomRuleEnabled",
            Some(json!({"zoneId": zone, "ruleId": id, "enabled": enabled})),
            move |r, result: Result<Vec<RuleDto>, String>| match result {
                Ok(rules) => {
                    r.view.notice =
                        Some(format!("{name} is {}.", if enabled { "on" } else { "off" }));
                    r.keep_rules(rules);
                }
                Err(problem) => r.view.error = Some(problem),
            },
        );
    }

    fn delete_rule(&mut self, id: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let name = self.rule_description(&id);
        self.ask(
            asking(
                format!("Delete the rule {name}?"),
                "Requests it matched go through as if it was never there. To pause it instead, switch it off.".to_owned(),
                "Delete rule",
            ),
            move |runner| {
                runner.view.busy = true;
                runner.cf(
                    "cloudflare.deleteCustomRule",
                    Some(json!({"zoneId": zone, "ruleId": id})),
                    move |r, result: Result<Vec<RuleDto>, String>| {
                        r.view.busy = false;
                        match result {
                            Ok(rules) => {
                                r.view.notice = Some(format!("Deleted the rule {name}."));
                                r.keep_rules(rules);
                            }
                            Err(problem) => r.view.error = Some(problem),
                        }
                    },
                );
            },
        );
    }

    fn add_rule(
        &mut self,
        kind: String,
        values: String,
        path: String,
        prefix: bool,
        description: String,
    ) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let Some(form) = self.view.cloudflare.rule_builder.as_mut() else {
            return;
        };
        form.saving = true;
        form.problem = None;
        let spec = match kind.as_str() {
            "block-countries" => {
                let mut codes: Vec<String> = Vec::new();
                for code in split_list(&values) {
                    let code = code.to_uppercase();
                    if !codes.contains(&code) {
                        codes.push(code);
                    }
                }
                json!({"kind": kind, "countries": codes})
            }
            "challenge-path" => json!({
                "kind": kind,
                "path": path.trim(),
                "match": if prefix { "prefix" } else { "exact" },
            }),
            _ => json!({"kind": "allow-ips", "ips": split_list(&values)}),
        };
        let typed = description.trim();
        let description = if typed.is_empty() {
            describe_rule(&spec)
        } else {
            typed.to_owned()
        };
        let notice = format!("Added the rule {description}.");
        self.cf(
            "cloudflare.createCustomRule",
            Some(json!({"zoneId": zone, "input": {"description": description, "spec": spec}})),
            move |r, result: Result<Vec<RuleDto>, String>| match result {
                Ok(rules) => {
                    r.view.cloudflare.rule_builder = None;
                    r.view.notice = Some(notice);
                    r.keep_rules(rules);
                }
                Err(problem) => {
                    if let Some(form) = r.view.cloudflare.rule_builder.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn add_access_rule(&mut self, value: String, mode: String, notes: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let Some(form) = self.view.cloudflare.access_rule_form.as_mut() else {
            return;
        };
        form.saving = true;
        form.problem = None;
        let value = value.trim().to_owned();
        self.cf(
            "cloudflare.createAccessRule",
            Some(json!({"zoneId": zone, "input": {"mode": mode, "value": value, "notes": notes.trim()}})),
            move |r, result: Result<AccessRuleDto, String>| match result {
                Ok(rule) => {
                    r.view.cloudflare.access_rule_form = None;
                    r.view.notice = Some(format!("Added the access rule for {}.", rule.value));
                    let mut rules = r.cloudflare.access_rules.clone();
                    rules.push(rule);
                    r.keep_access_rules(rules);
                }
                Err(problem) => {
                    if let Some(form) = r.view.cloudflare.access_rule_form.as_mut() {
                        form.saving = false;
                        form.problem = Some(problem);
                    }
                }
            },
        );
    }

    fn delete_access_rule(&mut self, id: String) {
        let (Some(zone), Some(rule)) = (
            self.zone_id(),
            self.cloudflare
                .access_rules
                .iter()
                .find(|r| r.id == id)
                .cloned(),
        ) else {
            return;
        };
        let detail = format!(
            "{} for {}. Requests from there are treated like any other again.",
            mode_label(&rule.mode),
            rule.value
        );
        self.ask(
            asking("Delete this access rule?".to_owned(), detail, "Delete"),
            move |runner| {
                runner.view.busy = true;
                let asked = id.clone();
                runner.cf(
                    "cloudflare.deleteAccessRule",
                    Some(json!({"zoneId": zone, "ruleId": id})),
                    move |r, result: Result<OkDto, String>| {
                        r.view.busy = false;
                        match result {
                            Ok(done) => {
                                r.view.notice = Some(done.message);
                                let mut rules = r.cloudflare.access_rules.clone();
                                rules.retain(|rule| rule.id != asked);
                                r.keep_access_rules(rules);
                            }
                            Err(problem) => r.view.error = Some(problem),
                        }
                    },
                );
            },
        );
    }

    fn purge(&mut self, params: Value) {
        self.view.busy = true;
        self.view.error = None;
        self.cf(
            "cloudflare.purgeCache",
            Some(params),
            |r, result: Result<OkDto, String>| {
                r.view.busy = false;
                match result {
                    Ok(done) => r.view.notice = Some(done.message),
                    Err(problem) => r.view.error = Some(problem),
                }
            },
        );
    }

    fn purge_everything(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let detail = format!(
            "Every cached file of {} is fetched from your server again. The site can be slower for a few minutes.",
            self.zone_name()
        );
        self.ask(
            asking("Purge everything?".to_owned(), detail, "Purge everything"),
            move |runner| runner.purge(json!({"zoneId": zone, "everything": true})),
        );
    }

    fn purge_urls(&mut self, text: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let urls: Vec<String> = text.split_whitespace().map(str::to_owned).collect();
        if urls.is_empty() {
            self.view.error = Some("Paste at least one address to purge.".to_owned());
            return;
        }
        self.purge(json!({"zoneId": zone, "urls": urls}));
    }
}

#[uniffi::export]
impl Engine {
    pub fn cloudflare_open_tab(&self, tab: CloudflareTab) {
        self.run(move |r| r.open_tab(tab));
    }

    /// Any setting the tabs show: "on" or "off" for a switch, an option's value for a choice.
    pub fn cloudflare_change_setting(&self, key: String, value: String) {
        self.run(move |r| r.change_setting_by_key(key, value));
    }

    pub fn cloudflare_set_rule_enabled(&self, id: String, enabled: bool) {
        self.run(move |r| r.set_rule_enabled(id, enabled));
    }

    pub fn cloudflare_delete_rule(&self, id: String) {
        self.run(move |r| r.delete_rule(id));
    }

    pub fn cloudflare_open_rule_builder(&self) {
        self.run(|r| r.view.cloudflare.rule_builder = Some(CloudflareFormView::default()));
    }

    pub fn cloudflare_close_rule_builder(&self) {
        self.run(|r| r.view.cloudflare.rule_builder = None);
    }

    /// `kind` is block-countries, challenge-path or allow-ips. An empty description is written
    /// from the rule.
    pub fn cloudflare_add_rule(
        &self,
        kind: String,
        values: String,
        path: String,
        prefix: bool,
        description: String,
    ) {
        self.run(move |r| r.add_rule(kind, values, path, prefix, description));
    }

    pub fn cloudflare_open_access_rule_form(&self) {
        self.run(|r| r.view.cloudflare.access_rule_form = Some(CloudflareFormView::default()));
    }

    pub fn cloudflare_close_access_rule_form(&self) {
        self.run(|r| r.view.cloudflare.access_rule_form = None);
    }

    pub fn cloudflare_add_access_rule(&self, value: String, mode: String, notes: String) {
        self.run(move |r| r.add_access_rule(value, mode, notes));
    }

    pub fn cloudflare_delete_access_rule(&self, id: String) {
        self.run(move |r| r.delete_access_rule(id));
    }

    pub fn cloudflare_purge_everything(&self) {
        self.run(Runner::purge_everything);
    }

    pub fn cloudflare_purge_urls(&self, text: String) {
        self.run(move |r| r.purge_urls(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_ttls_read_like_cloudflares_dashboard() {
        assert_eq!(browser_ttl_label(0), "Respect existing headers");
        assert_eq!(browser_ttl_label(30), "30 seconds");
        assert_eq!(browser_ttl_label(60), "1 minute");
        assert_eq!(browser_ttl_label(7200), "2 hours");
        assert_eq!(browser_ttl_label(86_400), "1 day");
        assert_eq!(browser_ttl_label(2_678_400), "1 month");
        assert_eq!(browser_ttl_label(31_536_000), "1 year");
    }

    #[test]
    fn a_rule_describes_itself_and_stays_short() {
        assert_eq!(
            describe_rule(&json!({"kind": "challenge-path", "path": "/login", "match": "exact"})),
            "Challenge /login"
        );
        let many: Vec<String> = (0..60).map(|i| format!("10.0.0.{i}")).collect();
        let text = describe_rule(&json!({"kind": "allow-ips", "ips": many}));
        assert_eq!(text.chars().count(), MAX_DESCRIPTION);
        assert!(text.ends_with("..."));
    }
}
