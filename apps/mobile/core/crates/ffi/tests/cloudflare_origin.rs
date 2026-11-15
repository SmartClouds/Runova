//! A server's Cloudflare-only origin on the phone (E102): the origin lock and the Cloudflare Tunnel,
//! each change previewed before it goes, and a firewall change kept or reverted from the phone.

mod common;

use common::{World, connected};
use runova_ffi::view::{
    CloudflareOriginDialogKind, CloudflareOriginMode, CloudflareStepState, Section,
};
use serde_json::{Value, json};

const ACCOUNT: &str = "01a7362d577a6c3019a474fd6f485823";

fn lock(state: &str, enabled: bool) -> Value {
    json!({
        "enabled": enabled, "authenticatedOriginPulls": false, "state": state,
        "missingRules": [], "openRules": [], "staleRules": [], "warnings": [],
        "ipv4Ranges": 15, "ipv6Ranges": 7, "rangesFetchedAt": null, "lastRefreshError": null,
    })
}

fn tunnel(state: &str, enabled: bool, connections: u32) -> Value {
    json!({
        "enabled": enabled, "state": state, "sshMode": "open", "connections": connections,
        "tunnelName": if enabled { json!("runova-prod") } else { json!(null) },
        "sshHostname": if enabled { json!("ssh.example.com") } else { json!(null) },
        "meshAddress": null, "cloudflaredVersion": null, "openRules": [], "warnings": [],
        "lastError": null, "breakGlassEnabled": false, "breakGlassDelayMinutes": 30,
    })
}

fn origin(lock_value: Value, tunnel_value: Value, pending: Value) -> Value {
    json!({
        "role": "owner", "signedIn": true,
        "lock": lock_value, "lockProblem": null,
        "tunnel": tunnel_value, "tunnelProblem": null,
        "pending": pending,
    })
}

fn change() -> Value {
    json!({"id": "cs1", "summary": "Close 80 and 443", "commands": ["ufw deny 80/tcp"], "deadline": null})
}

fn applied() -> Value {
    json!({"ok": true, "message": "Applied. Keep the firewall change within the time shown, or it rolls back.", "changeSetId": "cs1"})
}

async fn on_origin(tunnel_value: Value) -> World {
    let world = connected().await;
    world.computer.answer(
        "cloudflare.status",
        json!({"configured": true, "locked": false, "accounts": []}),
    );
    world.computer.answer(
        "cloudflare.servers",
        json!([{"id": "srv-1", "name": "prod"}]),
    );
    world.computer.answer(
        "cloudflare.origin",
        origin(lock("off", false), tunnel_value, Value::Null),
    );
    world.engine.open_section(Some(Section::Cloudflare));
    world
        .until(|v| !v.cloudflare.servers.is_empty(), "the servers")
        .await;
    world.engine.cloudflare_open_origin("srv-1".into());
    world
        .until(
            |v| v.cloudflare.origin.as_ref().is_some_and(|o| !o.loading),
            "the origin",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_shows_how_cloudflare_reaches_it() {
    let world = on_origin(tunnel("off", false, 0)).await;

    let origin = world.latest().unwrap().cloudflare.origin.unwrap();
    assert_eq!(origin.server_name, "prod");
    assert!(origin.can_admin && origin.can_own);
    assert_eq!(origin.mode, CloudflareOriginMode::Tunnel);
    assert!(!origin.mode_locked);
    let tunnel = origin.tunnel.unwrap();
    assert_eq!(tunnel.state_label, "Off: no tunnel on this server");
    assert_eq!(tunnel.set_up_label.as_deref(), Some("Set up tunnel"));
    assert!(
        tunnel
            .intro
            .unwrap()
            .starts_with("cloudflared on the server dials out")
    );
    let lock = origin.lock.unwrap();
    assert_eq!(
        lock.state_label,
        "Off: every address reaches ports 80 and 443"
    );
    assert_eq!(lock.enable_label.as_deref(), Some("Lock to Cloudflare"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_lock_goes_on_after_a_preview_and_its_change_is_kept() {
    let world = on_origin(tunnel("off", false, 0)).await;
    world.computer.answer(
        "cloudflare.originLockPreview",
        json!({
            "domains": [
                {"domain": "example.com", "text": "Proxied through Cloudflare", "ok": true},
                {"domain": "blog.example.com", "text": "DNS only: visitors would no longer reach it", "ok": false},
            ],
            "commands": ["ufw allow from 173.245.48.0/20 to any port 443"],
            "notes": [], "blocked": null,
        }),
    );
    world
        .computer
        .answer("cloudflare.originLockApply", applied());
    world.computer.answer(
        "cloudflare.firewallKeep",
        json!({"ok": true, "message": "Firewall change kept."}),
    );

    world
        .engine
        .cloudflare_origin_mode(CloudflareOriginMode::Ips);
    world.engine.cloudflare_lock_open(true);
    let dialog = world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| !d.loading)
            },
            "the preview",
        )
        .await
        .cloudflare
        .origin_dialog
        .unwrap();
    assert_eq!(dialog.kind, CloudflareOriginDialogKind::LockOn);
    assert_eq!(dialog.title, "Lock prod to Cloudflare");
    assert_eq!(dialog.rows.len(), 2);
    assert!(!dialog.rows[1].ok);
    assert_eq!(
        dialog.rows_warning.as_deref(),
        Some("Turn the proxy on for these names first, or they stop answering.")
    );
    assert_eq!(dialog.firewall_title.as_deref(), Some("1 firewall command"));
    assert!(dialog.can_apply);

    world.computer.answer(
        "cloudflare.origin",
        origin(lock("pending", true), tunnel("off", false, 0), change()),
    );
    world.engine.cloudflare_origin_apply();
    let view = world
        .until(
            |v| {
                v.cloudflare.origin_dialog.is_none()
                    && v.cloudflare
                        .origin
                        .as_ref()
                        .is_some_and(|o| o.pending.is_some())
            },
            "the change to keep",
        )
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.originLockApply")[0],
        Some(json!({"serverId": "srv-1", "enabled": true, "authenticatedOriginPulls": false}))
    );
    assert_eq!(
        view.cloudflare.origin.unwrap().mode,
        CloudflareOriginMode::Ips
    );

    world.engine.cloudflare_firewall_keep();
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.firewallKeep")
                    .is_empty()
            },
            "kept",
        )
        .await;
    assert_eq!(
        world.computer.params_of("cloudflare.firewallKeep")[0],
        Some(json!({"serverId": "srv-1", "changeSetId": "cs1"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_is_reverted_only_after_asking() {
    let world = on_origin(tunnel("off", false, 0)).await;
    world.computer.answer(
        "cloudflare.origin",
        origin(lock("pending", true), tunnel("off", false, 0), change()),
    );
    world.computer.answer(
        "cloudflare.firewallRevert",
        json!({"ok": true, "message": "Firewall change reverted. The old rules are back."}),
    );
    world.engine.cloudflare_open_origin("srv-1".into());
    world
        .until(
            |v| {
                v.cloudflare
                    .origin
                    .as_ref()
                    .is_some_and(|o| o.pending.is_some())
            },
            "the change",
        )
        .await;

    world.engine.cloudflare_firewall_revert();
    world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(
        world
            .computer
            .params_of("cloudflare.firewallRevert")
            .is_empty()
    );
    world.engine.confirm();
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.firewallRevert")
                    .is_empty()
            },
            "reverted",
        )
        .await;
}

fn plan(core_direct: Value) -> Value {
    json!({
        "accounts": [{"id": ACCOUNT, "label": "Work"}],
        "domains": [
            {"domain": "example.com", "role": "site", "cloudflareAccountId": ACCOUNT, "routed": false, "inAccount": true},
            {"domain": "old.org", "role": "site", "cloudflareAccountId": null, "routed": false, "inAccount": false},
        ],
        "coreDirect": core_direct,
        "commands": ["ufw deny 80/tcp", "ufw deny 443/tcp"], "notes": [], "blocked": null,
        "suggestedSshHostname": "ssh-prod.example.com", "blocker": null,
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_core_domain_pointing_straight_at_the_server_blocks_the_tunnel() {
    let world = on_origin(tunnel("off", false, 0)).await;
    world
        .computer
        .answer("cloudflare.tunnelPlan", plan(json!("core.example.com")));

    world.engine.cloudflare_tunnel_setup_open();
    let dialog = world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| !d.loading)
            },
            "the plan",
        )
        .await
        .cloudflare
        .origin_dialog
        .unwrap();

    assert!(
        dialog
            .blocked
            .unwrap()
            .starts_with("The core domain core.example.com points straight at the server")
    );
    assert!(!dialog.can_apply);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tunnel_is_set_up_step_by_step() {
    let world = on_origin(tunnel("off", false, 0)).await;
    world
        .computer
        .answer("cloudflare.tunnelPlan", plan(Value::Null));
    world.computer.answer(
        "cloudflare.tunnelSetUp",
        json!({"ok": true, "message": "Setting up the tunnel: installing cloudflared and connecting."}),
    );
    world.computer.answer(
        "cloudflare.tunnelRoute",
        json!({"routed": ["example.com"], "skipped": []}),
    );
    world
        .computer
        .answer("cloudflare.tunnelClosePorts", applied());

    world.engine.cloudflare_tunnel_setup_open();
    let dialog = world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| !d.loading)
            },
            "the plan",
        )
        .await
        .cloudflare
        .origin_dialog
        .unwrap();
    assert_eq!(dialog.kind, CloudflareOriginDialogKind::Setup);
    assert_eq!(dialog.title, "Put prod behind a Cloudflare Tunnel");
    assert_eq!(dialog.ssh_name, "ssh-prod.example.com");
    assert!(dialog.route_ssh);
    assert!(dialog.needs_ack);
    assert!(!dialog.can_apply);
    assert_eq!(dialog.rows[0].text, "Will go through the tunnel");
    assert_eq!(
        dialog.rows[1].text,
        "Not in a connected Cloudflare account: stops answering"
    );

    world.engine.cloudflare_tunnel_setup_ack(true);
    world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| d.can_apply)
            },
            "ready",
        )
        .await;
    world.computer.answer(
        "cloudflare.origin",
        origin(
            lock("off", false),
            tunnel("portsOpen", true, 4),
            Value::Null,
        ),
    );
    world.engine.cloudflare_origin_apply();
    let view = world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.tunnelClosePorts")
                    .is_empty()
            },
            "the last step",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.tunnelSetUp")[0],
        Some(
            json!({"serverId": "srv-1", "cloudflareAccountId": ACCOUNT, "sshHostname": "ssh-prod.example.com"})
        )
    );
    assert_eq!(
        world.computer.params_of("cloudflare.tunnelRoute")[0],
        Some(json!({"serverId": "srv-1"}))
    );
    let _ = view;
    let view = world
        .until(|v| v.cloudflare.origin_dialog.is_none(), "closed")
        .await;
    assert!(view.notice.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_setup_steps_say_how_far_they_got() {
    let world = on_origin(tunnel("off", false, 0)).await;
    world
        .computer
        .answer("cloudflare.tunnelPlan", plan(Value::Null));
    world.computer.refuse(
        "cloudflare.tunnelSetUp",
        "failed",
        "The tunnel hands every request to nginx, and nginx is not set up for Runova on this server yet.",
    );

    world.engine.cloudflare_tunnel_setup_open();
    world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| !d.loading)
            },
            "the plan",
        )
        .await;
    world.engine.cloudflare_tunnel_setup_ack(true);
    world.engine.cloudflare_origin_apply();
    let dialog = world
        .until(
            |v| {
                v.cloudflare.origin_dialog.as_ref().is_some_and(|d| {
                    d.steps
                        .first()
                        .is_some_and(|s| s.state == CloudflareStepState::Failed)
                })
            },
            "the failed step",
        )
        .await
        .cloudflare
        .origin_dialog
        .unwrap();

    assert_eq!(dialog.steps.len(), 4);
    assert_eq!(dialog.steps[1].state, CloudflareStepState::Waiting);
    assert!(dialog.problem.unwrap().contains("nginx is not set up"));
    assert_eq!(dialog.apply_label, "Try again");
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_ssh_takes_the_phrase_and_the_password() {
    let world = on_origin(tunnel("connected", true, 4)).await;
    world.computer.answer(
        "cloudflare.tunnelPreviewSsh",
        json!({"commands": ["ufw deny 22/tcp"], "notes": [], "blocked": null, "confirmationPhrase": "close ssh on prod"}),
    );
    world
        .computer
        .answer("cloudflare.tunnelApplySsh", applied());

    world.engine.cloudflare_tunnel_ssh_open();
    world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| !d.loading)
            },
            "the preview",
        )
        .await;
    world.engine.cloudflare_tunnel_ssh_mode("closed".into());
    let dialog = world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| d.ssh_mode == "closed" && d.phrase.is_some() && !d.loading)
            },
            "the phrase",
        )
        .await
        .cloudflare
        .origin_dialog
        .unwrap();
    assert_eq!(dialog.phrase.as_deref(), Some("close ssh on prod"));
    assert!(dialog.danger);
    let now = dialog.ssh_modes.iter().find(|m| m.now).unwrap();
    assert_eq!(now.value, "open");

    world
        .engine
        .cloudflare_tunnel_ssh_apply(String::new(), "pw".into());
    world
        .engine
        .cloudflare_tunnel_ssh_apply("close ssh on prod".into(), "hunter2".into());
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.tunnelApplySsh")
                    .is_empty()
            },
            "applied",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.tunnelApplySsh"),
        vec![Some(json!({
            "serverId": "srv-1", "mode": "closed",
            "overrideConfirmation": "close ssh on prod", "password": "hunter2",
        }))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ssh_through_the_tunnel_is_tested_from_the_computer_first() {
    let world = on_origin(tunnel("connected", true, 4)).await;
    world.computer.answer(
        "cloudflare.tunnelPreviewSsh",
        json!({"commands": ["ufw deny 22/tcp"], "notes": [], "blocked": null, "confirmationPhrase": null}),
    );
    world.computer.answer(
        "cloudflare.tunnelProbeSsh",
        json!({"ok": true, "message": "SSH gets in through the tunnel."}),
    );
    world
        .computer
        .answer("cloudflare.tunnelApplySsh", applied());

    world.engine.cloudflare_tunnel_ssh_open();
    world.engine.cloudflare_tunnel_ssh_mode("cloudflare".into());
    let dialog = world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| d.ssh_mode == "cloudflare" && !d.loading)
            },
            "the preview",
        )
        .await
        .cloudflare
        .origin_dialog
        .unwrap();
    assert!(!dialog.can_apply);
    assert_eq!(
        dialog.test_label.as_deref(),
        Some("Test SSH through the tunnel at ssh.example.com, from the computer")
    );

    world.engine.cloudflare_tunnel_ssh_test();
    world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| d.can_apply)
            },
            "tested",
        )
        .await;
    world
        .engine
        .cloudflare_tunnel_ssh_apply(String::new(), String::new());
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.tunnelApplySsh")
                    .is_empty()
            },
            "applied",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.tunnelProbeSsh")[0],
        Some(json!({"serverId": "srv-1", "route": "cloudflare"}))
    );
    assert_eq!(
        world.computer.params_of("cloudflare.tunnelApplySsh")[0],
        Some(json!({"serverId": "srv-1", "mode": "cloudflare"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_the_tunnel_off_cleans_up_once_it_is_off() {
    let world = on_origin(tunnel("connected", true, 4)).await;
    world.computer.answer(
        "cloudflare.tunnelPreviewOff",
        json!({"commands": ["ufw allow 80/tcp"], "notes": [], "blocked": null}),
    );
    world.computer.answer("cloudflare.tunnelTurnOff", applied());
    world.computer.answer(
        "cloudflare.tunnelCleanUp",
        json!({"ok": true, "message": "The tunnel is off and removed at Cloudflare."}),
    );

    world.engine.cloudflare_tunnel_off_open();
    world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| !d.loading)
            },
            "the preview",
        )
        .await;
    world.engine.cloudflare_tunnel_off_reopen(false);
    world
        .until(
            |_| {
                world
                    .computer
                    .params_of("cloudflare.tunnelPreviewOff")
                    .len()
                    == 2
            },
            "the second preview",
        )
        .await;
    world.computer.answer(
        "cloudflare.origin",
        origin(lock("off", false), tunnel("off", false, 0), Value::Null),
    );
    world.engine.cloudflare_origin_apply();
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.tunnelCleanUp")
                    .is_empty()
            },
            "the clean-up",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.tunnelPreviewOff")[1],
        Some(json!({"serverId": "srv-1", "reopenWeb": false}))
    );
    assert_eq!(
        world.computer.params_of("cloudflare.tunnelTurnOff")[0],
        Some(json!({"serverId": "srv-1", "reopenWeb": false}))
    );
    assert_eq!(
        world.computer.params_of("cloudflare.tunnelCleanUp")[0],
        Some(json!({"serverId": "srv-1", "pointBack": true}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn break_glass_is_switched_with_its_delay() {
    let world = on_origin(tunnel("connected", true, 4)).await;
    world.computer.answer(
        "cloudflare.tunnelBreakGlass",
        json!({"ok": true, "message": "SSH reopens after 60 minutes with the tunnel down."}),
    );

    world.engine.cloudflare_tunnel_break_glass(true, 60);
    world
        .until(
            |_| {
                !world
                    .computer
                    .params_of("cloudflare.tunnelBreakGlass")
                    .is_empty()
            },
            "sent",
        )
        .await;

    assert_eq!(
        world.computer.params_of("cloudflare.tunnelBreakGlass")[0],
        Some(json!({"serverId": "srv-1", "enabled": true, "delayMinutes": 60}))
    );
}
