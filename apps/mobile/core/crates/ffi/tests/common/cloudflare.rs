//! Cloudflare fixtures shared by the phone's Cloudflare tests (E98 onward).

use super::{World, connected};
use runova_ffi::view::{RecordDraft, Section};
use serde_json::{Value, json};

pub const ZONE: &str = "023e105f4ecef8ad9ca31a8372d0c353";
pub const RECORD: &str = "372e67954025e0ba6aaa6d586b9e0b59";
pub const WWW: &str = "472e67954025e0ba6aaa6d586b9e0b59";
pub const CF_ACCOUNT: &str = "01a7362d577a6c3019a474fd6f485823";
pub const TOKEN: &str = "Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M";

pub fn status() -> Value {
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

pub fn zone(status: &str) -> Value {
    json!({
        "id": ZONE, "accountId": "acct-1", "cloudflareAccountId": CF_ACCOUNT,
        "name": "example.com", "status": status, "paused": false, "plan": "Free Website",
        "nameServers": ["bob.ns.cloudflare.com", "lola.ns.cloudflare.com"],
    })
}

pub fn record(id: &str, name: &str, content: &str, proxied: bool) -> Value {
    json!({
        "id": id, "type": "A", "name": name, "content": content, "ttl": 1,
        "proxied": proxied, "proxiable": true, "editable": true,
    })
}

pub fn records() -> Value {
    json!([
        record(RECORD, "example.com", "203.0.113.10", true),
        {
            "id": WWW, "type": "MX", "name": "mail.example.com", "content": "mx.example.net",
            "ttl": 3600, "proxied": false, "proxiable": false, "priority": 10, "editable": true,
        },
    ])
}

pub fn settings(dev: &str, seconds: u32, level: &str) -> Value {
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

pub fn bots(ai: &str) -> Value {
    json!({"aiBots": ai, "aiLabyrinth": false, "preferenceSync": false, "fightMode": false})
}

pub async fn on_cloudflare() -> World {
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

pub async fn on_zone() -> World {
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

pub fn draft(kind: &str, name: &str, content: &str) -> RecordDraft {
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
