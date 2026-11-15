//! A domain's Access tab on the phone (E100): the email code gate on each of its names, and the
//! names and paths only listed addresses can open.

mod common;

use common::World;
use common::cloudflare::*;
use runova_ffi::view::{CloudflareGateState, CloudflareTab};
use serde_json::{Value, json};

const LIMIT: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn host(hostname: &str, role: &str, gate: Value, proxied: bool) -> Value {
    json!({
        "hostname": hostname, "proxied": proxied, "recordId": "c".repeat(32), "role": role,
        "serverId": "srv-1", "serverName": "prod", "siteName": if role == "site" { json!("blog") } else { json!(null) },
        "gate": gate, "thisComputerPass": role == "core",
    })
}

fn plan(ready: bool) -> Value {
    json!({
        "cloudflareAccountId": "01a7362d577a6c3019a474fd6f485823",
        "readiness": {"organization": ready, "teamDomain": if ready { json!("acme.cloudflareaccess.com") } else { json!(null) }, "oneTimePin": ready},
        "hosts": [
            host("core.example.com", "core", json!({"kind": "on", "appId": "a1", "emails": ["ana@example.com", "bo@example.com"], "emailDomains": ["company.com"], "session": "24h"}), true),
            host("blog.example.com", "site", json!({"kind": "off"}), true),
            host("app.example.com", "other", json!({"kind": "off"}), true),
            host("shop.example.com", "other", json!({"kind": "off"}), false),
            host("ssh.example.com", "ssh", json!({"kind": "elsewhere", "appId": "a2", "name": "SSH for prod"}), true),
        ],
    })
}

fn limits() -> Value {
    json!([{
        "id": LIMIT, "enabled": true, "hostname": "app.example.com", "path": "/admin",
        "match": "prefix", "ips": ["203.0.113.10", "198.51.100.0/24"],
    }])
}

fn names() -> Value {
    json!([
        {"id": "1".repeat(32), "type": "A", "name": "app.example.com", "content": "203.0.113.10", "ttl": 1, "proxied": true, "proxiable": true, "editable": true},
        {"id": "2".repeat(32), "type": "CNAME", "name": "www.example.com", "content": "example.com", "ttl": 1, "proxied": true, "proxiable": true, "editable": true},
        {"id": "3".repeat(32), "type": "A", "name": "shop.example.com", "content": "203.0.113.11", "ttl": 1, "proxied": false, "proxiable": true, "editable": true},
        {"id": "4".repeat(32), "type": "A", "name": "*.example.com", "content": "203.0.113.12", "ttl": 1, "proxied": true, "proxiable": true, "editable": true},
        {"id": "5".repeat(32), "type": "TXT", "name": "txt.example.com", "content": "x", "ttl": 1, "proxied": false, "proxiable": false, "editable": true},
    ])
}

async fn on_access(ready: bool) -> World {
    let world = on_zone().await;
    world
        .computer
        .answer("cloudflare.emailGatePlan", plan(ready));
    world.computer.answer("cloudflare.ipLimits", limits());
    world
        .computer
        .answer("cloudflare.publicAddress", json!({"ip": "203.0.113.77"}));
    world.computer.answer("cloudflare.records", names());
    world.engine.cloudflare_open_tab(CloudflareTab::Access);
    world
        .until(
            |v| {
                v.cloudflare.zone.as_ref().is_some_and(|z| {
                    !z.access.loading && !z.access.hosts.is_empty() && !z.access.limits.is_empty()
                })
            },
            "the access tab",
        )
        .await;
    world
}

fn hosts(world: &World) -> Vec<runova_ffi::view::CloudflareGateHostView> {
    world
        .latest()
        .unwrap()
        .cloudflare
        .zone
        .unwrap()
        .access
        .hosts
}

#[tokio::test(flavor = "multi_thread")]
async fn each_name_says_what_it_is_and_who_can_open_it() {
    let world = on_access(true).await;

    let all = hosts(&world);
    let core = &all[0];
    assert_eq!(core.role_label.as_deref(), Some("Core server"));
    assert_eq!(core.state, CloudflareGateState::On);
    assert_eq!(core.summary, "Email code, 3 people, 24 hours");
    assert!(core.this_computer_pass);
    assert_eq!(all[1].role_label.as_deref(), Some("Site blog"));
    assert_eq!(all[2].summary, "Open to everyone");
    let shop = &all[3];
    assert!(!shop.proxied);
    assert!(shop.can_proxy);
    assert_eq!(
        shop.summary,
        "Cloudflare's proxy is off for it, so a gate cannot go on it yet"
    );
    let ssh = &all[4];
    assert_eq!(ssh.state, CloudflareGateState::Elsewhere);
    assert_eq!(ssh.summary, "SSH for prod, set up in Cloudflare");
    let access = world.latest().unwrap().cloudflare.zone.unwrap().access;
    assert!(access.ready);
    assert!(!access.needs_team);
}

#[tokio::test(flavor = "multi_thread")]
async fn email_codes_are_turned_on_once_with_a_team_name() {
    let world = on_access(false).await;
    let access = world.latest().unwrap().cloudflare.zone.unwrap().access;
    assert!(!access.ready);
    assert!(access.needs_team);
    world.computer.answer(
        "cloudflare.emailGatePrepare",
        json!({"organization": true, "teamDomain": "acme.cloudflareaccess.com", "oneTimePin": true}),
    );
    world
        .computer
        .answer("cloudflare.emailGatePlan", plan(true));

    world.engine.cloudflare_gate_prepare(" acme ".into());
    world
        .until(
            |v| v.cloudflare.zone.as_ref().is_some_and(|z| z.access.ready),
            "ready",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.emailGatePrepare")[0],
        Some(json!({"zoneId": ZONE, "teamName": "acme"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gate_goes_on_with_people_typed_or_pasted_and_a_session() {
    let world = on_access(true).await;
    world.computer.answer(
        "cloudflare.emailGateSave",
        json!({"kind": "on", "appId": "a3", "emails": ["ana@example.com", "bo@example.com"], "emailDomains": ["company.com"], "session": "168h"}),
    );

    world
        .engine
        .cloudflare_gate_switch("app.example.com".into(), true);
    let form = world
        .until(|v| v.cloudflare.email_gate_form.is_some(), "the form")
        .await
        .cloudflare
        .email_gate_form
        .unwrap();
    assert!(!form.existing);
    assert!(form.people.is_empty());
    assert_eq!(
        form.preview,
        "Add at least one email or domain to say who can open app.example.com."
    );

    world.engine.cloudflare_gate_add_people(
        "Ana@Example.com, @company.com Bo <bo@example.com>; nope".into(),
    );
    world.engine.cloudflare_gate_set_session("168h".into());
    let form = world
        .until(
            |v| {
                v.cloudflare
                    .email_gate_form
                    .as_ref()
                    .is_some_and(|f| f.session == "168h")
            },
            "the people",
        )
        .await
        .cloudflare
        .email_gate_form
        .unwrap();
    let people: Vec<(String, bool)> = form
        .people
        .iter()
        .map(|p| (p.value.clone(), p.domain))
        .collect();
    assert_eq!(
        people,
        [
            ("company.com".to_owned(), true),
            ("ana@example.com".to_owned(), false),
            ("bo@example.com".to_owned(), false)
        ]
    );
    assert_eq!(
        form.invalid,
        ["nope: Type an email address, or a domain like @company.com to let in everyone there."]
    );
    assert_eq!(
        form.preview,
        "Anyone at @company.com and 2 more people can open app.example.com for 7 days after typing a code."
    );

    world.engine.cloudflare_gate_save();
    let view = world
        .until(|v| v.cloudflare.email_gate_form.is_none(), "saved")
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.emailGateSave")[0],
        Some(json!({
            "zoneId": ZONE, "hostname": "app.example.com",
            "emails": ["ana@example.com", "bo@example.com"], "emailDomains": ["company.com"], "session": "168h",
        }))
    );
    assert_eq!(
        view.notice.as_deref(),
        Some("app.example.com now asks for an email code.")
    );

    // The next new gate starts from the list just used.
    world
        .engine
        .cloudflare_gate_switch("blog.example.com".into(), true);
    let form = world
        .until(
            |v| {
                v.cloudflare
                    .email_gate_form
                    .as_ref()
                    .is_some_and(|f| f.hostname == "blog.example.com")
            },
            "the next form",
        )
        .await
        .cloudflare
        .email_gate_form
        .unwrap();
    assert_eq!(form.people.len(), 3);
    assert!(form.from_last);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_existing_gate_opens_with_its_people_and_a_note_on_the_core() {
    let world = on_access(true).await;

    world.engine.cloudflare_gate_edit("core.example.com".into());
    let form = world
        .until(|v| v.cloudflare.email_gate_form.is_some(), "the form")
        .await
        .cloudflare
        .email_gate_form
        .unwrap();

    assert!(form.existing);
    assert_eq!(form.people.len(), 3);
    assert_eq!(form.session, "24h");
    assert_eq!(
        form.core_note.as_deref(),
        Some(
            "This computer has its own pass, so the app keeps reaching the core without a code. Another computer gets one with Let this computer through."
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gate_comes_off_after_asking() {
    let world = on_access(true).await;
    world.computer.answer(
        "cloudflare.emailGateRemove",
        json!({"ok": true, "message": "core.example.com is open to everyone again."}),
    );

    world
        .engine
        .cloudflare_gate_switch("core.example.com".into(), false);
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    let confirm = view.confirm.unwrap();
    assert_eq!(
        confirm.title,
        "Turn the email code off for core.example.com?"
    );
    assert!(
        confirm
            .detail
            .contains("Every computer's pass through it goes too.")
    );
    assert!(
        world
            .computer
            .params_of("cloudflare.emailGateRemove")
            .is_empty()
    );

    world.engine.confirm();
    world.until(|v| v.notice.is_some(), "off").await;
    assert_eq!(
        world.computer.params_of("cloudflare.emailGateRemove")[0],
        Some(json!({"zoneId": ZONE, "hostname": "core.example.com"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_gets_the_proxy_and_this_computer_gets_a_pass() {
    let world = on_access(true).await;
    let ok = json!({"ok": true, "message": "Done."});
    world
        .computer
        .answer("cloudflare.emailGateProxy", ok.clone());
    world.computer.answer("cloudflare.emailGateLetThrough", ok);

    world
        .engine
        .cloudflare_gate_proxy("shop.example.com".into());
    world
        .engine
        .cloudflare_gate_let_through("core.example.com".into());
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.emailGateProxy")
                    .is_empty()
                    && !world
                        .computer
                        .params_of("cloudflare.emailGateLetThrough")
                        .is_empty()
            },
            "both",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.emailGateProxy")[0],
        Some(json!({"zoneId": ZONE, "hostname": "shop.example.com"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ip_limits_say_what_they_cover_and_who_gets_in() {
    let world = on_access(true).await;

    let limit = world
        .latest()
        .unwrap()
        .cloudflare
        .zone
        .unwrap()
        .access
        .limits[0]
        .clone();
    assert_eq!(limit.target, "app.example.com/admin and below");
    assert_eq!(limit.ips, ["203.0.113.10", "198.51.100.0/24"]);
    assert!(limit.enabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_ip_limit_is_built_up_and_warns_when_this_computer_is_left_out() {
    let world = on_access(true).await;
    world.computer.answer("cloudflare.saveIpLimit", limits());

    world.engine.cloudflare_open_ip_limit(None);
    let form = world
        .until(|v| v.cloudflare.ip_limit_form.is_some(), "the form")
        .await
        .cloudflare
        .ip_limit_form
        .unwrap();
    let names: Vec<String> = form.names.iter().map(|n| n.label.clone()).collect();
    assert_eq!(
        names,
        [
            "Every name in example.com",
            "app.example.com",
            "www.example.com"
        ]
    );
    assert!(!form.can_save);

    world
        .engine
        .cloudflare_ip_limit_set_name("app.example.com".into());
    world
        .engine
        .cloudflare_ip_limit_add_addresses("198.51.100.7, office".into());
    let form = world
        .until(
            |v| {
                v.cloudflare
                    .ip_limit_form
                    .as_ref()
                    .is_some_and(|f| !f.ips.is_empty())
            },
            "the address",
        )
        .await
        .cloudflare
        .ip_limit_form
        .unwrap();
    assert_eq!(
        form.invalid,
        ["office: This is not an IP address or a range like 203.0.113.0/24."]
    );
    assert_eq!(form.this_computer.as_deref(), Some("203.0.113.77"));
    assert!(form.shut_out);

    world.engine.cloudflare_ip_limit_add_this_computer();
    world.engine.cloudflare_ip_limit_set_scope(false);
    world.engine.cloudflare_ip_limit_set_path("admin".into());
    let form = world
        .until(
            |v| {
                v.cloudflare
                    .ip_limit_form
                    .as_ref()
                    .is_some_and(|f| f.path_problem.is_some())
            },
            "the path problem",
        )
        .await
        .cloudflare
        .ip_limit_form
        .unwrap();
    assert!(!form.shut_out);
    assert!(!form.can_add_this_computer);
    assert_eq!(
        form.path_problem.as_deref(),
        Some("A path starts with a slash, like /wp-login.php.")
    );
    assert!(!form.can_save);

    world.engine.cloudflare_ip_limit_set_path("/admin".into());
    world.engine.cloudflare_ip_limit_set_prefix(true);
    let form = world
        .until(
            |v| {
                v.cloudflare
                    .ip_limit_form
                    .as_ref()
                    .is_some_and(|f| f.can_save && f.prefix)
            },
            "ready",
        )
        .await
        .cloudflare
        .ip_limit_form
        .unwrap();
    assert_eq!(
        form.preview,
        "Only 198.51.100.7 and 203.0.113.77 can open app.example.com/admin and below. Everyone else gets Cloudflare's block page."
    );

    world.engine.cloudflare_ip_limit_save();
    let view = world
        .until(|v| v.cloudflare.ip_limit_form.is_none(), "saved")
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.saveIpLimit")[0],
        Some(json!({
            "zoneId": ZONE,
            "spec": {"kind": "ip-lock", "hostname": "app.example.com", "path": "/admin", "match": "prefix", "ips": ["198.51.100.7", "203.0.113.77"]},
        }))
    );
    assert_eq!(
        view.notice.as_deref(),
        Some("Only the listed addresses can open app.example.com/admin and below now.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_limit_is_changed_switched_off_and_deleted() {
    let world = on_access(true).await;
    world.computer.answer("cloudflare.saveIpLimit", limits());
    world
        .computer
        .answer("cloudflare.setCustomRuleEnabled", json!([]));
    world
        .computer
        .answer("cloudflare.deleteCustomRule", json!([]));

    world.engine.cloudflare_open_ip_limit(Some(LIMIT.into()));
    let form = world
        .until(|v| v.cloudflare.ip_limit_form.is_some(), "the form")
        .await
        .cloudflare
        .ip_limit_form
        .unwrap();
    assert_eq!(form.hostname, "app.example.com");
    assert_eq!(form.path, "/admin");
    assert!(!form.whole_site);
    world
        .engine
        .cloudflare_ip_limit_remove_address("203.0.113.10".into());
    world.engine.cloudflare_ip_limit_save();
    world
        .until(|v| v.cloudflare.ip_limit_form.is_none(), "saved")
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.saveIpLimit")[0],
        Some(json!({
            "zoneId": ZONE, "ruleId": LIMIT,
            "spec": {"kind": "ip-lock", "hostname": "app.example.com", "path": "/admin", "match": "prefix", "ips": ["198.51.100.0/24"]},
        }))
    );

    world
        .engine
        .cloudflare_ip_limit_set_enabled(LIMIT.into(), false);
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.setCustomRuleEnabled")
                    .is_empty()
            },
            "off",
        )
        .await;
    world.engine.cloudflare_ip_limit_delete(LIMIT.into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert_eq!(
        view.confirm.unwrap().title,
        "Delete the IP limit for app.example.com/admin and below?"
    );
    world.engine.confirm();
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.deleteCustomRule")
                    .is_empty()
            },
            "deleted",
        )
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.deleteCustomRule")[0],
        Some(json!({"zoneId": ZONE, "ruleId": LIMIT}))
    );
}
