//! A domain's settings on the phone (E99): SSL/TLS, caching and purge, the security level, AI bots,
//! WAF custom rules and IP access rules, each in the desktop's words.

mod common;

use common::World;
use common::cloudflare::*;
use runova_ffi::view::{
    CloudflareSettingKind, CloudflareSettingView, CloudflareTab, CloudflareTone, CloudflareZoneView,
};
use serde_json::{Value, json};

const RULE: &str = "3a03d665bac047339bb530ecb439a90d";
const ACCESS: &str = "92f17202ed8bd63d69a66b86a49a8f6b";

fn rule(id: &str, description: &str, action: &str, enabled: bool) -> Value {
    json!({
        "id": id, "description": description, "expression": "(ip.src.country in {\"T1\"})",
        "action": action, "enabled": enabled, "lastUpdated": "2024-06-01T12:00:00Z",
    })
}

fn access_rule(id: &str, value: &str, mode: &str) -> Value {
    json!({
        "id": id, "mode": mode, "target": "ip", "value": value, "notes": "Scraper",
        "createdOn": "2024-06-01T12:00:00Z",
    })
}

async fn on_tab(tab: CloudflareTab) -> World {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.customRules",
        json!([rule(RULE, "Block Tor exit nodes", "block", true)]),
    );
    world.computer.answer(
        "cloudflare.accessRules",
        json!([access_rule(ACCESS, "198.51.100.4", "block")]),
    );
    world.engine.cloudflare_open_tab(tab);
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.tab == tab && !z.settings.is_empty())
            },
            "the tab",
        )
        .await;
    world
}

fn zone_of(world: &World) -> CloudflareZoneView {
    world.latest().unwrap().cloudflare.zone.unwrap()
}

fn item(zone: &CloudflareZoneView, key: &str) -> CloudflareSettingView {
    zone.settings
        .iter()
        .flat_map(|g| g.items.iter())
        .find(|i| i.key == key)
        .cloned()
        .unwrap_or_else(|| panic!("no setting {key}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn ssl_tls_shows_the_mode_with_what_it_means() {
    let world = on_tab(CloudflareTab::Ssl).await;

    let zone = zone_of(&world);
    assert_eq!(zone.settings[0].title, "SSL/TLS");
    let keys: Vec<String> = zone.settings[0]
        .items
        .iter()
        .map(|i| i.key.clone())
        .collect();
    assert_eq!(
        keys,
        [
            "ssl",
            "alwaysUseHttps",
            "automaticHttpsRewrites",
            "minTlsVersion",
            "tls13"
        ]
    );
    let ssl = item(&zone, "ssl");
    assert_eq!(ssl.kind, CloudflareSettingKind::Choice);
    assert_eq!(ssl.value, "full");
    let labels: Vec<String> = ssl.options.iter().map(|o| o.label.clone()).collect();
    assert_eq!(
        labels,
        ["Off (no HTTPS)", "Flexible", "Full", "Full (strict)"]
    );
    assert!(ssl.note.unwrap().contains("certificate is not checked"));
    assert_eq!(ssl.note_tone, CloudflareTone::Warning);
    let tls13 = item(&zone, "tls13");
    assert_eq!(tls13.kind, CloudflareSettingKind::Switch);
    assert!(tls13.on);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_switch_is_sent_and_said_back() {
    let world = on_tab(CloudflareTab::Ssl).await;
    let mut after = settings("off", 0, "medium");
    after["alwaysUseHttps"]["value"] = json!("on");
    world.computer.answer("cloudflare.changeSetting", after);

    world
        .engine
        .cloudflare_change_setting("alwaysUseHttps".into(), "on".into());
    let view = world.until(|v| v.notice.is_some(), "done").await;

    assert_eq!(
        world.computer.params_of("cloudflare.changeSetting")[0],
        Some(json!({"zoneId": ZONE, "change": {"setting": "alwaysUseHttps", "value": "on"}}))
    );
    assert_eq!(view.notice.as_deref(), Some("Always Use HTTPS is on."));
    assert!(item(&view.cloudflare.zone.unwrap(), "alwaysUseHttps").on);
}

#[tokio::test(flavor = "multi_thread")]
async fn caching_lists_its_levels_and_the_browser_ttl_in_words() {
    let world = on_tab(CloudflareTab::Caching).await;
    let mut after = settings("off", 0, "medium");
    after["browserCacheTtl"]["value"] = json!(7200);
    world.computer.answer("cloudflare.changeSetting", after);

    let zone = zone_of(&world);
    assert_eq!(
        item(&zone, "developmentMode").kind,
        CloudflareSettingKind::Switch
    );
    let level = item(&zone, "cacheLevel");
    let labels: Vec<String> = level.options.iter().map(|o| o.label.clone()).collect();
    assert_eq!(
        labels,
        ["Standard", "Ignore query string", "No query string"]
    );
    let ttl = item(&zone, "browserCacheTtl");
    assert_eq!(ttl.value, "14400");
    assert!(
        ttl.options
            .iter()
            .any(|o| o.value == "14400" && o.label == "4 hours")
    );
    assert!(
        ttl.options
            .iter()
            .any(|o| o.value == "0" && o.label == "Respect existing headers")
    );

    world
        .engine
        .cloudflare_change_setting("browserCacheTtl".into(), "7200".into());
    let view = world.until(|v| v.notice.is_some(), "done").await;
    assert_eq!(
        world.computer.params_of("cloudflare.changeSetting")[0],
        Some(json!({"zoneId": ZONE, "change": {"setting": "browserCacheTtl", "value": 7200}}))
    );
    assert_eq!(
        view.notice.as_deref(),
        Some("Browser cache TTL is 2 hours now.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn security_shows_protection_ai_bots_and_both_kinds_of_rules() {
    let world = on_tab(CloudflareTab::Security).await;
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| !z.rules.loading && !z.rules.access.is_empty())
            },
            "the rules",
        )
        .await;

    let zone = view.cloudflare.zone.unwrap();
    assert_eq!(item(&zone, "securityLevel").value, "medium");
    let bots = item(&zone, "aiBots");
    let labels: Vec<String> = bots.options.iter().map(|o| o.label.clone()).collect();
    assert_eq!(labels, ["Off", "On ad pages", "Everywhere"]);
    assert_eq!(item(&zone, "fightMode").kind, CloudflareSettingKind::Switch);
    let custom = &zone.rules.custom[0];
    assert_eq!(custom.description, "Block Tor exit nodes");
    assert_eq!(custom.action_label, "Block");
    assert_eq!(custom.tone, CloudflareTone::Bad);
    let access = &zone.rules.access[0];
    assert_eq!(access.value, "198.51.100.4");
    assert_eq!(access.target_label, "IP address");
    assert_eq!(access.mode_label, "Block");
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_settings_go_to_bot_management() {
    let world = on_tab(CloudflareTab::Security).await;
    world.computer.answer(
        "cloudflare.changeBotSetting",
        json!({"aiBots": "disabled", "aiLabyrinth": true, "preferenceSync": false, "fightMode": false}),
    );

    world
        .engine
        .cloudflare_change_setting("aiLabyrinth".into(), "on".into());
    let view = world.until(|v| v.notice.is_some(), "done").await;

    assert_eq!(
        world.computer.params_of("cloudflare.changeBotSetting")[0],
        Some(json!({"zoneId": ZONE, "change": {"setting": "aiLabyrinth", "value": true}}))
    );
    assert_eq!(view.notice.as_deref(), Some("AI Labyrinth is on."));
    assert!(item(&view.cloudflare.zone.unwrap(), "aiLabyrinth").on);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rule_switches_off_and_is_deleted_after_asking() {
    let world = on_tab(CloudflareTab::Security).await;
    world.computer.answer(
        "cloudflare.setCustomRuleEnabled",
        json!([rule(RULE, "Block Tor exit nodes", "block", false)]),
    );
    world
        .computer
        .answer("cloudflare.deleteCustomRule", json!([]));

    world.engine.cloudflare_set_rule_enabled(RULE.into(), false);
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.rules.custom.first().is_some_and(|r| !r.enabled))
            },
            "off",
        )
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.setCustomRuleEnabled")[0],
        Some(json!({"zoneId": ZONE, "ruleId": RULE, "enabled": false}))
    );

    world.engine.cloudflare_delete_rule(RULE.into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(view.confirm.unwrap().title.contains("Block Tor exit nodes"));
    world.engine.confirm();
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.rules.custom.is_empty())
            },
            "gone",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_builder_makes_each_kind_of_rule_with_a_description_from_it() {
    let world = on_tab(CloudflareTab::Security).await;
    world.computer.answer(
        "cloudflare.createCustomRule",
        json!([rule(RULE, "Block CN, RU", "block", true)]),
    );

    world.engine.cloudflare_open_rule_builder();
    world
        .until(|v| v.cloudflare.rule_builder.is_some(), "the builder")
        .await;
    world.engine.cloudflare_add_rule(
        "block-countries".into(),
        "cn, ru".into(),
        String::new(),
        false,
        String::new(),
    );
    let view = world
        .until(|v| v.cloudflare.rule_builder.is_none(), "added")
        .await;
    assert_eq!(view.notice.as_deref(), Some("Added the rule Block CN, RU."));

    world.engine.cloudflare_open_rule_builder();
    world.engine.cloudflare_add_rule(
        "challenge-path".into(),
        String::new(),
        "/admin".into(),
        true,
        String::new(),
    );
    world.engine.cloudflare_open_rule_builder();
    world.engine.cloudflare_add_rule(
        "allow-ips".into(),
        "203.0.113.10\n198.51.100.0/24".into(),
        String::new(),
        false,
        "Office".into(),
    );
    world
        .until(
            |_| {
                world
                    .computer
                    .params_of("cloudflare.createCustomRule")
                    .len()
                    == 3
            },
            "all three",
        )
        .await;

    let inputs: Vec<Value> = world
        .computer
        .params_of("cloudflare.createCustomRule")
        .into_iter()
        .map(|p| p.unwrap()["input"].clone())
        .collect();
    let of = |kind: &str| {
        inputs
            .iter()
            .find(|i| i["spec"]["kind"] == kind)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        of("block-countries"),
        json!({"description": "Block CN, RU", "spec": {"kind": "block-countries", "countries": ["CN", "RU"]}})
    );
    assert_eq!(
        of("challenge-path"),
        json!({"description": "Challenge /admin and below", "spec": {"kind": "challenge-path", "path": "/admin", "match": "prefix"}})
    );
    assert_eq!(
        of("allow-ips"),
        json!({"description": "Office", "spec": {"kind": "allow-ips", "ips": ["203.0.113.10", "198.51.100.0/24"]}})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_rule_keeps_the_builder_open_with_the_reason() {
    let world = on_tab(CloudflareTab::Security).await;
    world.computer.refuse(
        "cloudflare.createCustomRule",
        "bad-params",
        "USA is not a two-letter country code, such as US or DE.",
    );

    world.engine.cloudflare_open_rule_builder();
    world.engine.cloudflare_add_rule(
        "block-countries".into(),
        "USA".into(),
        String::new(),
        false,
        String::new(),
    );
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .rule_builder
                    .as_ref()
                    .is_some_and(|b| b.problem.is_some())
            },
            "the problem",
        )
        .await;

    assert_eq!(
        view.cloudflare.rule_builder.unwrap().problem.as_deref(),
        Some("USA is not a two-letter country code, such as US or DE.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_access_rule_is_added_and_deleted_after_asking() {
    let world = on_tab(CloudflareTab::Security).await;
    world.computer.answer(
        "cloudflare.createAccessRule",
        access_rule(
            "a2f17202ed8bd63d69a66b86a49a8f6b",
            "203.0.113.0/24",
            "managed_challenge",
        ),
    );
    world.computer.answer(
        "cloudflare.deleteAccessRule",
        json!({"ok": true, "message": "Deleted the access rule."}),
    );

    world.engine.cloudflare_open_access_rule_form();
    world.engine.cloudflare_add_access_rule(
        " 203.0.113.0/24 ".into(),
        "managed_challenge".into(),
        "Office".into(),
    );
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.rules.access.len() == 2)
            },
            "added",
        )
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.createAccessRule")[0],
        Some(
            json!({"zoneId": ZONE, "input": {"mode": "managed_challenge", "value": "203.0.113.0/24", "notes": "Office"}})
        )
    );

    world.engine.cloudflare_delete_access_rule(ACCESS.into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(view.confirm.unwrap().detail.contains("198.51.100.4"));
    world.engine.confirm();
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.rules.access.len() == 1)
            },
            "gone",
        )
        .await;
    assert_eq!(
        view.cloudflare.zone.unwrap().rules.access[0].mode_label,
        "Managed challenge"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_cache_is_purged_whole_after_asking_or_file_by_file() {
    let world = on_tab(CloudflareTab::Caching).await;
    world.computer.answer(
        "cloudflare.purgeCache",
        json!({"ok": true, "message": "Purged everything. Visitors get fresh copies now."}),
    );

    world.engine.cloudflare_purge_everything();
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(world.computer.params_of("cloudflare.purgeCache").is_empty());
    world.engine.confirm();
    world.until(|v| v.notice.is_some(), "purged").await;

    world
        .engine
        .cloudflare_purge_urls("https://example.com/a.css\n\n  https://example.com/b.js  ".into());
    world
        .until(
            |_| world.computer.params_of("cloudflare.purgeCache").len() == 2,
            "both",
        )
        .await;

    let sent = world.computer.params_of("cloudflare.purgeCache");
    assert_eq!(sent[0], Some(json!({"zoneId": ZONE, "everything": true})));
    assert_eq!(
        sent[1],
        Some(
            json!({"zoneId": ZONE, "urls": ["https://example.com/a.css", "https://example.com/b.js"]})
        )
    );
}
