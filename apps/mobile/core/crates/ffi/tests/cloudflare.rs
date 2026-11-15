//! Cloudflare on the phone (E98): the computer's Cloudflare accounts and their domains, a domain's
//! quick switches and DNS records, adding a domain, pointing one at a server, and a token pasted on
//! the phone that only leaves after the phone's own check.

mod common;

use common::{World, connected};
use runova_ffi::view::{CloudflareTone, RecordDraft, Section};
use serde_json::{Value, json};

const ZONE: &str = "023e105f4ecef8ad9ca31a8372d0c353";
const RECORD: &str = "372e67954025e0ba6aaa6d586b9e0b59";
const WWW: &str = "472e67954025e0ba6aaa6d586b9e0b59";
const CF_ACCOUNT: &str = "01a7362d577a6c3019a474fd6f485823";
const TOKEN: &str = "Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M";

fn status() -> Value {
    json!({
        "configured": true,
        "locked": true,
        "accounts": [
            {
                "id": "acct-1", "label": "Work", "locked": false, "state": "active",
                "expiresOn": null, "zoneCount": 1, "checkedAt": 1_700_000_000_000_i64,
                "missing": ["Zone > Zone WAF > Edit"], "unverified": [],
            },
            {
                "id": "acct-2", "label": "Home", "locked": true, "state": null,
                "expiresOn": null, "zoneCount": null, "checkedAt": null,
                "missing": [], "unverified": [],
            },
        ],
    })
}

fn zone(status: &str) -> Value {
    json!({
        "id": ZONE, "accountId": "acct-1", "cloudflareAccountId": CF_ACCOUNT,
        "name": "example.com", "status": status, "paused": false, "plan": "Free Website",
        "nameServers": ["bob.ns.cloudflare.com", "lola.ns.cloudflare.com"],
    })
}

fn record(id: &str, name: &str, content: &str, proxied: bool) -> Value {
    json!({
        "id": id, "type": "A", "name": name, "content": content, "ttl": 1,
        "proxied": proxied, "proxiable": true, "editable": true,
    })
}

fn records() -> Value {
    json!([
        record(RECORD, "example.com", "203.0.113.10", true),
        {
            "id": WWW, "type": "MX", "name": "mail.example.com", "content": "mx.example.net",
            "ttl": 3600, "proxied": false, "proxiable": false, "priority": 10, "editable": true,
        },
    ])
}

fn settings(dev: &str, seconds: u32, level: &str) -> Value {
    json!({
        "developmentMode": {"value": dev, "secondsRemaining": seconds, "editable": true},
        "securityLevel": {"value": level, "editable": true},
        "ssl": {"value": "full", "editable": true},
        "alwaysUseHttps": {"value": "off", "editable": true},
        "automaticHttpsRewrites": {"value": "off", "editable": true},
        "minTlsVersion": {"value": "1.2", "editable": true},
        "tls13": {"value": "on", "editable": true},
        "cacheLevel": {"value": "aggressive", "editable": true},
        "browserCacheTtl": {"value": 14400, "editable": true},
    })
}

fn bots(ai: &str) -> Value {
    json!({"aiBots": ai, "aiLabyrinth": false, "preferenceSync": false, "fightMode": false})
}

async fn on_cloudflare() -> World {
    let world = connected().await;
    world.computer.answer("cloudflare.status", status());
    world
        .computer
        .answer("cloudflare.zones", json!([zone("active")]));
    world.computer.answer("cloudflare.records", records());
    world
        .computer
        .answer("cloudflare.zoneSettings", settings("off", 0, "medium"));
    world
        .computer
        .answer("cloudflare.botSettings", bots("disabled"));
    world.engine.open_section(Some(Section::Cloudflare));
    world
        .until(
            |v| {
                v.cloudflare
                    .accounts
                    .first()
                    .is_some_and(|a| !a.zones.is_empty())
            },
            "the zones",
        )
        .await;
    world
}

async fn on_zone() -> World {
    let world = on_cloudflare().await;
    world.engine.cloudflare_open_zone(ZONE.into());
    world
        .until(
            |v| {
                v.cloudflare.zone.as_ref().is_some_and(|z| {
                    !z.dns.loading && z.toggles.is_some() && !z.dns.records.is_empty()
                })
            },
            "the zone",
        )
        .await;
    world
}

fn draft(kind: &str, name: &str, content: &str) -> RecordDraft {
    RecordDraft {
        record_type: kind.into(),
        name: name.into(),
        content: content.into(),
        ttl: 1,
        proxied: true,
        priority: 10,
        comment: String::new(),
        caa_flags: 0,
        caa_tag: "issue".into(),
        caa_value: String::new(),
        srv_priority: 0,
        srv_weight: 0,
        srv_port: 0,
        srv_target: String::new(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn each_account_says_how_its_token_stands_and_lists_its_domains() {
    let world = on_cloudflare().await;

    let screen = world.latest().unwrap().cloudflare;
    let work = &screen.accounts[0];
    assert_eq!(work.label, "Work");
    assert_eq!(work.status_label, "Needs 1 permission");
    assert_eq!(work.tone, CloudflareTone::Warning);
    assert_eq!(work.missing, vec!["Zone > Zone WAF > Edit".to_owned()]);
    assert_eq!(work.zones[0].name, "example.com");
    assert_eq!(work.zones[0].status_label, "Active");
    assert!(work.zones[0].active);

    let home = &screen.accounts[1];
    assert_eq!(home.status_label, "Locked");
    assert_eq!(
        home.detail.as_deref(),
        Some("Unlock Servers on this computer to use this account.")
    );
    assert!(home.zones.is_empty());
    assert_eq!(
        world.computer.params_of("cloudflare.zones"),
        vec![Some(json!({"accountId": "acct-1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_account_it_says_how_to_start() {
    let world = connected().await;
    world.computer.answer(
        "cloudflare.status",
        json!({"configured": false, "locked": false, "accounts": []}),
    );

    world.engine.open_section(Some(Section::Cloudflare));
    let view = world.until(|v| !v.cloudflare.loading, "the status").await;

    assert!(!view.cloudflare.configured);
    assert!(view.cloudflare.accounts.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_says_why_in_the_computers_words() {
    let world = connected().await;
    world.computer.refuse(
        "cloudflare.status",
        "forbidden",
        "This phone isn't allowed to use Cloudflare on this computer.",
    );

    world.engine.open_section(Some(Section::Cloudflare));
    let view = world
        .until(|v| v.cloudflare.problem.is_some(), "the problem")
        .await;

    assert!(
        view.cloudflare
            .problem
            .unwrap()
            .contains("isn't allowed to use Cloudflare")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_domain_shows_its_records_by_short_name_and_its_switches() {
    let world = on_zone().await;

    let zone = world.latest().unwrap().cloudflare.zone.unwrap();
    assert_eq!(zone.name, "example.com");
    let apex = &zone.dns.records[0];
    assert_eq!(apex.name, "@");
    assert_eq!(apex.full_name, "example.com");
    assert_eq!(apex.ttl_label, "Auto");
    assert!(apex.proxied);
    let mail = &zone.dns.records[1];
    assert_eq!(mail.name, "mail");
    assert_eq!(mail.ttl_label, "1 hr");
    assert_eq!(mail.priority, Some(10));

    let toggles = zone.toggles.unwrap();
    assert!(!toggles.dev_mode);
    assert_eq!(toggles.dev_mode_detail, "Off");
    assert!(!toggles.under_attack);
    assert!(!toggles.ai_bots_blocked);
}

#[tokio::test(flavor = "multi_thread")]
async fn development_mode_turns_on_and_says_how_long_is_left() {
    let world = on_zone().await;
    world
        .computer
        .answer("cloudflare.changeSetting", settings("on", 10_800, "medium"));

    world.engine.cloudflare_set_dev_mode(true);
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .and_then(|z| z.toggles.as_ref())
                    .is_some_and(|t| t.dev_mode)
            },
            "on",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.changeSetting")[0],
        Some(json!({"zoneId": ZONE, "change": {"setting": "developmentMode", "value": "on"}}))
    );
    let toggles = view.cloudflare.zone.unwrap().toggles.unwrap();
    assert_eq!(toggles.dev_mode_detail, "On, 3 h left");
    assert_eq!(
        view.notice.as_deref(),
        Some("Development mode is on for three hours.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn under_attack_goes_back_to_the_level_before_it() {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.changeSetting",
        settings("off", 0, "under_attack"),
    );
    world.engine.cloudflare_set_under_attack(true);
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .and_then(|z| z.toggles.as_ref())
                    .is_some_and(|t| t.under_attack)
            },
            "on",
        )
        .await;

    world
        .computer
        .answer("cloudflare.changeSetting", settings("off", 0, "medium"));
    world.engine.cloudflare_set_under_attack(false);
    world
        .until(
            |_| world.computer.params_of("cloudflare.changeSetting").len() == 2,
            "off",
        )
        .await;

    let sent = world.computer.params_of("cloudflare.changeSetting");
    assert_eq!(
        sent[0].as_ref().unwrap()["change"],
        json!({"setting": "securityLevel", "value": "under_attack"})
    );
    assert_eq!(
        sent[1].as_ref().unwrap()["change"],
        json!({"setting": "securityLevel", "value": "medium"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ai_bots_are_blocked_everywhere_from_the_switch() {
    let world = on_zone().await;
    world
        .computer
        .answer("cloudflare.changeBotSetting", bots("block"));

    world.engine.cloudflare_set_ai_bots_blocked(true);
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .and_then(|z| z.toggles.as_ref())
                    .is_some_and(|t| t.ai_bots_blocked)
            },
            "blocked",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.changeBotSetting")[0],
        Some(json!({"zoneId": ZONE, "change": {"setting": "aiBots", "value": "block"}}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_record_goes_in_under_its_full_name() {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.createRecord",
        record(
            "572e67954025e0ba6aaa6d586b9e0b59",
            "app.example.com",
            "203.0.113.20",
            true,
        ),
    );

    world.engine.cloudflare_new_record();
    let form = world
        .until(|v| v.cloudflare.record_form.is_some(), "the form")
        .await
        .cloudflare
        .record_form
        .unwrap();
    assert_eq!(form.title, "Add a record");
    assert_eq!(form.draft.record_type, "A");
    assert!(form.draft.proxied);

    world
        .engine
        .cloudflare_save_record(draft("A", "app", "203.0.113.20"));
    let view = world
        .until(|v| v.cloudflare.record_form.is_none(), "saved")
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.createRecord")[0],
        Some(json!({
            "zoneId": ZONE,
            "record": {"type": "A", "name": "app.example.com", "content": "203.0.113.20", "ttl": 1, "proxied": true},
        }))
    );
    let names: Vec<String> = view
        .cloudflare
        .zone
        .unwrap()
        .dns
        .records
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert!(names.contains(&"app".to_owned()));
    assert_eq!(view.notice.as_deref(), Some("Added app.example.com."));
}

#[tokio::test(flavor = "multi_thread")]
async fn each_record_type_sends_its_own_fields() {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.createRecord",
        record(RECORD, "x.example.com", "x", false),
    );

    let mut mx = draft("MX", "@", "mx.example.net");
    mx.priority = 5;
    mx.ttl = 300;
    mx.comment = "Mail".into();
    world.engine.cloudflare_new_record();
    world.engine.cloudflare_save_record(mx);
    let mut caa = draft("CAA", "@", "");
    caa.caa_tag = "issue".into();
    caa.caa_value = "letsencrypt.org".into();
    world.engine.cloudflare_new_record();
    world.engine.cloudflare_save_record(caa);
    let mut srv = draft("SRV", "_sip._tcp", "");
    srv.srv_priority = 1;
    srv.srv_weight = 2;
    srv.srv_port = 5060;
    srv.srv_target = "sip.example.com".into();
    world.engine.cloudflare_new_record();
    world.engine.cloudflare_save_record(srv);
    world
        .until(
            |_| world.computer.params_of("cloudflare.createRecord").len() == 3,
            "all three",
        )
        .await;

    // The three go out at once, so they are matched by type rather than by order.
    let sent: Vec<Value> = world
        .computer
        .params_of("cloudflare.createRecord")
        .into_iter()
        .map(|p| p.unwrap()["record"].clone())
        .collect();
    let of = |kind: &str| sent.iter().find(|r| r["type"] == kind).cloned().unwrap();
    assert_eq!(
        of("MX"),
        json!({"type": "MX", "name": "example.com", "content": "mx.example.net", "priority": 5, "ttl": 300, "comment": "Mail"})
    );
    assert_eq!(
        of("CAA"),
        json!({"type": "CAA", "name": "example.com", "caa": {"flags": 0, "tag": "issue", "value": "letsencrypt.org"}, "ttl": 1})
    );
    assert_eq!(
        of("SRV"),
        json!({"type": "SRV", "name": "_sip._tcp.example.com", "srv": {"priority": 1, "weight": 2, "port": 5060, "target": "sip.example.com"}, "ttl": 1})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_record_keeps_the_form_open_with_the_reason() {
    let world = on_zone().await;
    world.computer.refuse(
        "cloudflare.createRecord",
        "bad-params",
        "203.0.113 is not an IPv4 address.",
    );

    world.engine.cloudflare_new_record();
    world
        .engine
        .cloudflare_save_record(draft("A", "app", "203.0.113"));
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .record_form
                    .as_ref()
                    .is_some_and(|f| f.problem.is_some())
            },
            "the problem",
        )
        .await;

    let form = view.cloudflare.record_form.unwrap();
    assert_eq!(
        form.problem.as_deref(),
        Some("203.0.113 is not an IPv4 address.")
    );
    assert!(!form.saving);
}

#[tokio::test(flavor = "multi_thread")]
async fn editing_a_record_starts_from_it_and_changes_it_in_place() {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.updateRecord",
        record(RECORD, "example.com", "203.0.113.99", true),
    );

    world.engine.cloudflare_edit_record(RECORD.into());
    let form = world
        .until(|v| v.cloudflare.record_form.is_some(), "the form")
        .await
        .cloudflare
        .record_form
        .unwrap();
    assert_eq!(form.title, "Edit record");
    assert_eq!(form.draft.name, "@");
    assert_eq!(form.draft.content, "203.0.113.10");

    world
        .engine
        .cloudflare_save_record(draft("A", "@", "203.0.113.99"));
    let view = world
        .until(|v| v.cloudflare.record_form.is_none(), "saved")
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.updateRecord")[0]
            .as_ref()
            .unwrap()["recordId"],
        json!(RECORD)
    );
    assert_eq!(
        view.cloudflare.zone.unwrap().dns.records[0].content,
        "203.0.113.99"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_proxy_switch_sends_the_whole_record_back() {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.updateRecord",
        record(RECORD, "example.com", "203.0.113.10", false),
    );

    world.engine.cloudflare_set_proxied(RECORD.into(), false);
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.updateRecord")
                    .is_empty()
            },
            "sent",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.updateRecord")[0],
        Some(json!({
            "zoneId": ZONE,
            "recordId": RECORD,
            "record": {"type": "A", "name": "example.com", "content": "203.0.113.10", "ttl": 1, "proxied": false},
        }))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_record_asks_first() {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.deleteRecord",
        json!({"ok": true, "message": "Deleted the record."}),
    );

    world.engine.cloudflare_delete_record(WWW.into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(view.confirm.unwrap().detail.contains("mail.example.com"));
    assert!(
        world
            .computer
            .params_of("cloudflare.deleteRecord")
            .is_empty()
    );

    world.engine.confirm();
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.dns.records.len() == 1)
            },
            "gone",
        )
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.deleteRecord")[0],
        Some(json!({"zoneId": ZONE, "recordId": WWW}))
    );
    assert_eq!(view.cloudflare.zone.unwrap().dns.records[0].name, "@");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pasted_token_waits_for_the_phones_own_check() {
    let world = on_cloudflare().await;
    world.computer.answer("cloudflare.saveToken", status());

    world.engine.cloudflare_open_token_form(None);
    world
        .engine
        .cloudflare_save_token(format!(" {TOKEN}\n"), "Phone".into());
    let request = world
        .until(|v| v.cloudflare.biometric.is_some(), "the check")
        .await
        .cloudflare
        .biometric
        .unwrap();
    assert_eq!(
        request.reason,
        "Connect a Cloudflare account to this computer"
    );
    assert!(world.computer.params_of("cloudflare.saveToken").is_empty());

    world.engine.biometric_result(request.id, true);
    let view = world
        .until(|v| v.cloudflare.token_form.is_none(), "saved")
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.saveToken"),
        vec![Some(json!({"token": TOKEN, "label": "Phone"}))]
    );
    assert_eq!(
        view.notice.as_deref(),
        Some("Connected. The token is saved on this computer, not on the phone.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_goes_nowhere_without_the_check() {
    let world = on_cloudflare().await;

    world
        .engine
        .cloudflare_open_token_form(Some("acct-1".into()));
    world
        .engine
        .cloudflare_save_token(TOKEN.into(), String::new());
    let request = world
        .until(|v| v.cloudflare.biometric.is_some(), "the check")
        .await
        .cloudflare
        .biometric
        .unwrap();
    world.engine.biometric_result(request.id, false);
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .token_form
                    .as_ref()
                    .is_some_and(|f| f.problem.is_some())
            },
            "the problem",
        )
        .await;

    assert!(world.computer.params_of("cloudflare.saveToken").is_empty());
    assert_eq!(
        view.cloudflare.token_form.unwrap().problem.as_deref(),
        Some("Couldn't confirm it's you, so the token wasn't sent.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_that_cannot_be_one_is_refused_on_the_phone() {
    let world = on_cloudflare().await;

    world.engine.cloudflare_open_token_form(None);
    world
        .engine
        .cloudflare_save_token("has a space in it".into(), String::new());
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .token_form
                    .as_ref()
                    .is_some_and(|f| f.problem.is_some())
            },
            "the problem",
        )
        .await;

    assert!(view.cloudflare.biometric.is_none());
    assert_eq!(
        view.cloudflare.token_form.unwrap().problem.as_deref(),
        Some("A token has no spaces in it. Copy it again from Cloudflare.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_is_checked_again_and_removed_after_asking() {
    let world = on_cloudflare().await;
    world.computer.answer("cloudflare.checkToken", status());
    world.computer.answer(
        "cloudflare.removeToken",
        json!({"configured": false, "locked": false, "accounts": []}),
    );

    world.engine.cloudflare_check_token("acct-1".into());
    world
        .until(
            |_| !world.computer.params_of("cloudflare.checkToken").is_empty(),
            "checked",
        )
        .await;
    world.engine.cloudflare_remove_token("acct-1".into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(view.confirm.unwrap().title.contains("Work"));
    world.engine.confirm();
    world
        .until(|v| v.cloudflare.accounts.is_empty(), "removed")
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.removeToken"),
        vec![Some(json!({"accountId": "acct-1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_domain_opens_with_the_name_servers_to_set() {
    let world = on_cloudflare().await;
    world.computer.answer(
        "cloudflare.accounts",
        json!([{"id": CF_ACCOUNT, "name": "Acme"}]),
    );
    world
        .computer
        .answer("cloudflare.createZone", zone("pending"));

    world.engine.cloudflare_open_add_domain("acct-1".into());
    let form = world
        .until(
            |v| {
                v.cloudflare
                    .add_domain
                    .as_ref()
                    .is_some_and(|f| !f.choices.is_empty())
            },
            "the accounts",
        )
        .await
        .cloudflare
        .add_domain
        .unwrap();
    assert_eq!(form.choices[0].name, "Acme");

    world
        .engine
        .cloudflare_add_domain("example.com".into(), CF_ACCOUNT.into());
    let view = world
        .until(|v| v.cloudflare.zone.is_some(), "the new domain")
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.createZone")[0],
        Some(
            json!({"accountId": "acct-1", "name": "example.com", "cloudflareAccountId": CF_ACCOUNT})
        )
    );
    let zone = view.cloudflare.zone.unwrap();
    assert!(zone.pending);
    assert_eq!(zone.status_label, "Waiting for name servers");
    assert_eq!(zone.name_servers.len(), 2);
    assert!(view.cloudflare.add_domain.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_domain_points_at_a_server_after_a_preview() {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.servers",
        json!([{"id": "srv-1", "name": "prod"}]),
    );
    let plan = json!({
        "zoneName": "example.com",
        "names": ["example.com", "www.example.com"],
        "addresses": {"ipv4": ["198.51.100.5"], "ipv6": []},
        "changes": [
            {"action": "update", "type": "A", "name": "example.com", "content": "198.51.100.5", "previous": "203.0.113.10", "proxied": true, "recordId": RECORD},
            {"action": "create", "type": "A", "name": "www.example.com", "content": "198.51.100.5", "proxied": true},
        ],
        "upToDate": false,
    });
    world
        .computer
        .answer("cloudflare.planPointDomain", plan.clone());
    world.computer.answer(
        "cloudflare.pointDomain",
        json!({"plan": plan, "applied": 2}),
    );

    world.engine.cloudflare_open_point_domain();
    world
        .until(
            |v| {
                v.cloudflare
                    .point_domain
                    .as_ref()
                    .is_some_and(|p| !p.servers.is_empty())
            },
            "the servers",
        )
        .await;
    world
        .engine
        .cloudflare_preview_point_domain("@".into(), "srv-1".into(), true, true);
    let preview = world
        .until(
            |v| {
                v.cloudflare
                    .point_domain
                    .as_ref()
                    .is_some_and(|p| p.plan.is_some())
            },
            "the preview",
        )
        .await
        .cloudflare
        .point_domain
        .unwrap()
        .plan
        .unwrap();
    assert_eq!(preview.changes[0].action_label, "Change");
    assert_eq!(preview.changes[0].previous.as_deref(), Some("203.0.113.10"));
    assert_eq!(preview.changes[1].action_label, "Add");
    assert_eq!(preview.changes[1].name, "www");
    assert!(
        world
            .computer
            .params_of("cloudflare.pointDomain")
            .is_empty()
    );

    world.engine.cloudflare_apply_point_domain();
    let view = world
        .until(|v| v.cloudflare.point_domain.is_none(), "applied")
        .await;

    let input = json!({"zoneId": ZONE, "name": "@", "serverId": "srv-1", "includeWww": true, "proxied": true});
    assert_eq!(
        world.computer.params_of("cloudflare.planPointDomain")[0],
        Some(input.clone())
    );
    assert_eq!(
        world.computer.params_of("cloudflare.pointDomain")[0],
        Some(input)
    );
    assert_eq!(
        view.notice.as_deref(),
        Some("example.com points at prod now. 2 records changed.")
    );
}
