//! Turnstile and the Servers tab on the phone (E101): widgets made, changed and deleted, a secret
//! shown only after the phone's own check, and the DNS tokens a domain's servers hold.

mod common;

use common::World;
use common::cloudflare::*;
use runova_ffi::view::{CloudflareTab, WidgetDraft};
use serde_json::{Value, json};

const SITEKEY: &str = "0x4AAAAAAABkMYinukE8nzY";
const SECRET: &str = "0x4AAAAAAABkMYsecretValue123";
const TOKEN: &str = "Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M";

fn widget(name: &str) -> Value {
    json!({
        "sitekey": SITEKEY, "name": name, "domains": ["example.com", "shop.example.com"],
        "mode": "managed", "clearance": "no_clearance", "region": "world",
        "offlabel": false, "ephemeralId": false,
        "createdOn": "2026-03-01T10:00:00Z", "modifiedOn": "2026-03-01T10:00:00Z",
    })
}

async fn on_turnstile() -> World {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.turnstileWidgets",
        json!([widget("Contact form")]),
    );
    world.engine.cloudflare_open_tab(CloudflareTab::Turnstile);
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| !z.turnstile.widgets.is_empty())
            },
            "the widgets",
        )
        .await;
    world
}

async fn on_servers(tokens: Value) -> World {
    let world = on_zone().await;
    world.computer.answer(
        "cloudflare.servers",
        json!([{"id": "srv-1", "name": "prod"}, {"id": "srv-2", "name": "lab"}]),
    );
    world.computer.answer("cloudflare.dnsTokens", tokens);
    world.engine.cloudflare_open_tab(CloudflareTab::Servers);
    world
        .until(
            |v| {
                v.cloudflare.zone.as_ref().is_some_and(|z| {
                    z.servers.servers.len() == 2 && z.servers.servers.iter().all(|s| !s.loading)
                })
            },
            "the servers",
        )
        .await;
    world
}

fn draft(name: &str) -> WidgetDraft {
    WidgetDraft {
        name: name.into(),
        domains: vec![
            " Example.com ".into(),
            "example.com".into(),
            "shop.example.com".into(),
        ],
        mode: "invisible".into(),
        clearance: "managed".into(),
        region: "world".into(),
        offlabel: false,
        ephemeral_id: false,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn widgets_are_listed_with_their_mode_and_a_snippet() {
    let world = on_turnstile().await;

    let widget = world
        .latest()
        .unwrap()
        .cloudflare
        .zone
        .unwrap()
        .turnstile
        .widgets[0]
        .clone();
    assert_eq!(widget.name, "Contact form");
    assert_eq!(widget.sitekey, SITEKEY);
    assert_eq!(widget.mode_label, "Managed");
    assert_eq!(widget.domains, ["example.com", "shop.example.com"]);
    assert!(
        widget
            .snippet
            .contains(&format!("data-sitekey=\"{SITEKEY}\""))
    );
    assert!(
        widget
            .snippet
            .contains("challenges.cloudflare.com/turnstile/v0/api.js")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_widget_starts_on_the_domain_and_its_secret_stays_on_the_computer() {
    let world = on_turnstile().await;
    world.computer.answer(
        "cloudflare.createTurnstileWidget",
        json!({"widget": widget("Sign up")}),
    );

    world.engine.cloudflare_new_widget();
    let form = world
        .until(|v| v.cloudflare.widget_form.is_some(), "the form")
        .await
        .cloudflare
        .widget_form
        .unwrap();
    assert_eq!(form.title, "Add a widget");
    assert_eq!(form.draft.domains, ["example.com"]);
    assert_eq!(form.draft.mode, "managed");
    assert_eq!(form.draft.clearance, "no_clearance");

    world.engine.cloudflare_save_widget(draft("Sign up"));
    let view = world
        .until(|v| v.cloudflare.widget_form.is_none(), "made")
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.createTurnstileWidget")[0],
        Some(json!({
            "zoneId": ZONE,
            "input": {
                "name": "Sign up", "domains": ["example.com", "shop.example.com"],
                "mode": "invisible", "clearance": "managed", "region": "world",
                "offlabel": false, "ephemeralId": false,
            },
        }))
    );
    assert_eq!(
        view.notice.as_deref(),
        Some("Made the widget Sign up. Reveal its secret when your server needs it.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_widget_is_changed_by_its_site_key_and_deleted_after_asking() {
    let world = on_turnstile().await;
    world
        .computer
        .answer("cloudflare.updateTurnstileWidget", widget("Contact"));
    world.computer.answer(
        "cloudflare.deleteTurnstileWidget",
        json!({"ok": true, "message": "Deleted the widget."}),
    );

    world.engine.cloudflare_edit_widget(SITEKEY.into());
    let form = world
        .until(|v| v.cloudflare.widget_form.is_some(), "the form")
        .await
        .cloudflare
        .widget_form
        .unwrap();
    assert_eq!(form.title, "Edit widget");
    assert_eq!(form.draft.name, "Contact form");
    world.engine.cloudflare_save_widget(draft("Contact"));
    world
        .until(|v| v.cloudflare.widget_form.is_none(), "saved")
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.updateTurnstileWidget")[0]
            .as_ref()
            .unwrap()["sitekey"],
        json!(SITEKEY)
    );

    world.engine.cloudflare_delete_widget(SITEKEY.into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(view.confirm.unwrap().title.contains("Contact"));
    world.engine.confirm();
    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.turnstile.widgets.is_empty())
            },
            "gone",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_secret_is_shown_only_after_the_phones_own_check() {
    let world = on_turnstile().await;
    world
        .computer
        .answer("cloudflare.turnstileSecret", json!({"secret": SECRET}));

    world.engine.cloudflare_reveal_secret(SITEKEY.into());
    let request = world
        .until(|v| v.cloudflare.biometric.is_some(), "the check")
        .await
        .cloudflare
        .biometric
        .unwrap();
    assert_eq!(request.reason, "Show the secret of Contact form");
    assert!(
        world
            .computer
            .params_of("cloudflare.turnstileSecret")
            .is_empty()
    );

    world.engine.biometric_result(request.id, true);
    let view = world
        .until(|v| v.cloudflare.revealed_secret.is_some(), "the secret")
        .await;
    let secret = view.cloudflare.revealed_secret.unwrap();
    assert_eq!(secret.value, SECRET);
    assert_eq!(secret.name, "Contact form");

    world.engine.cloudflare_hide_secret();
    world
        .until(|v| v.cloudflare.revealed_secret.is_none(), "hidden")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_secret_stays_hidden_without_the_check() {
    let world = on_turnstile().await;

    world.engine.cloudflare_reveal_secret(SITEKEY.into());
    let request = world
        .until(|v| v.cloudflare.biometric.is_some(), "the check")
        .await
        .cloudflare
        .biometric
        .unwrap();
    world.engine.biometric_result(request.id, false);
    let view = world.until(|v| v.error.is_some(), "the refusal").await;

    assert!(
        world
            .computer
            .params_of("cloudflare.turnstileSecret")
            .is_empty()
    );
    assert_eq!(
        view.error.as_deref(),
        Some("Couldn't confirm it's you, so the secret stays hidden.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rotating_asks_first_and_says_whether_the_old_secret_still_works() {
    let world = on_turnstile().await;
    world.computer.answer(
        "cloudflare.rotateTurnstileSecret",
        json!({"widget": widget("Contact form")}),
    );

    world.engine.cloudflare_rotate_secret(SITEKEY.into(), false);
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(
        view.confirm
            .unwrap()
            .detail
            .contains("The old secret keeps working for two hours")
    );
    world.engine.confirm();
    let view = world.until(|v| v.notice.is_some(), "rotated").await;

    assert_eq!(
        world.computer.params_of("cloudflare.rotateTurnstileSecret")[0],
        Some(json!({"zoneId": ZONE, "sitekey": SITEKEY, "now": false}))
    );
    assert_eq!(
        view.notice.as_deref(),
        Some("Rotated the secret of Contact form. Reveal it to copy the new one.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn each_server_says_whether_it_holds_a_dns_token_for_the_domain() {
    let world = on_servers(json!([
        {"zone": "example.com", "zoneId": ZONE, "madeHere": true, "updatedAt": 2},
        {"zone": "other.org", "zoneId": "f".repeat(32), "madeHere": false, "updatedAt": 2},
    ]))
    .await;

    let servers = world
        .latest()
        .unwrap()
        .cloudflare
        .zone
        .unwrap()
        .servers
        .servers;
    assert_eq!(servers[0].name, "prod");
    assert!(servers[0].has_token);
    assert!(servers[0].made_here);
    assert_eq!(
        servers[0].detail,
        "Holds a token Runova made for example.com, for wildcard certificates."
    );
    // Both servers are asked at once, so the calls can land in either order.
    let mut asked = world.computer.params_of("cloudflare.dnsTokens");
    asked.sort_by_key(|p| p.as_ref().map(|p| p["serverId"].to_string()));
    assert_eq!(
        asked,
        vec![
            Some(json!({"serverId": "srv-1"})),
            Some(json!({"serverId": "srv-2"}))
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_gets_a_token_made_here_or_pasted_after_the_check() {
    let world = on_servers(json!([])).await;
    let ok = json!({"ok": true, "message": "The server has a DNS token for this domain now."});
    world.computer.answer("cloudflare.provisionDnsToken", ok);

    world.engine.cloudflare_dns_token_mint("srv-1".into());
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.provisionDnsToken")
                    .is_empty()
            },
            "made",
        )
        .await;
    world
        .engine
        .cloudflare_dns_token_paste("srv-2".into(), format!(" {TOKEN} "));
    let request = world
        .until(|v| v.cloudflare.biometric.is_some(), "the check")
        .await
        .cloudflare
        .biometric
        .unwrap();
    assert_eq!(
        world
            .computer
            .params_of("cloudflare.provisionDnsToken")
            .len(),
        1
    );
    world.engine.biometric_result(request.id, true);
    world
        .until(
            |_| {
                world
                    .computer
                    .params_of("cloudflare.provisionDnsToken")
                    .len()
                    == 2
            },
            "pasted",
        )
        .await;

    let sent = world.computer.params_of("cloudflare.provisionDnsToken");
    assert_eq!(
        sent[0],
        Some(json!({"serverId": "srv-1", "zoneId": ZONE, "mode": "mint"}))
    );
    assert_eq!(
        sent[1],
        Some(json!({"serverId": "srv-2", "zoneId": ZONE, "mode": "paste", "token": TOKEN}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_runova_made_is_also_deleted_at_cloudflare_when_removed() {
    let world = on_servers(json!([
        {"zone": "example.com", "zoneId": ZONE, "madeHere": true, "updatedAt": 2},
    ]))
    .await;
    world.computer.answer(
        "cloudflare.removeDnsToken",
        json!({"ok": true, "message": "The server forgot its DNS token for this domain."}),
    );

    world.engine.cloudflare_dns_token_remove("srv-1".into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    let confirm = view.confirm.unwrap();
    assert_eq!(confirm.title, "Remove the DNS token from prod?");
    assert!(confirm.detail.contains("deleted at Cloudflare"));
    world.engine.confirm();
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.removeDnsToken")
                    .is_empty()
            },
            "removed",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.removeDnsToken")[0],
        Some(json!({"serverId": "srv-1", "zone": "example.com", "deleteAtCloudflare": true}))
    );
}
