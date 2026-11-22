//! The demo computer's Deploy, Cloudflare, Monitoring, Pipelines and Errors (E119): every screen
//! opens on made-up data without a refusal, and what is changed reports success and keeps nothing.

mod common;

use common::cloudflare::draft;
use common::{DemoWorld, connected_demo};
use runova_ffi::view::{
    AppView, CloudflareTab, CloudflareTone, MonitorSource, MonitorState, PipelineRunState, Section,
    TrafficTab,
};
use serde_json::json;

fn no_error(view: &AppView) {
    assert_eq!(view.error, None, "{view:?}");
}

async fn on_deploy() -> DemoWorld {
    let demo = connected_demo().await;
    demo.world.engine.open_section(Some(Section::Deploy));
    demo.world
        .until(|v| !v.deploy.servers.is_empty(), "the servers")
        .await;
    demo
}

async fn on_server() -> DemoWorld {
    let demo = on_deploy().await;
    let first = demo.world.latest().unwrap().deploy.servers[0].id.clone();
    demo.world.engine.deploy_open_server(first);
    demo.world
        .until(
            |v| {
                v.deploy
                    .server
                    .as_ref()
                    .is_some_and(|s| !s.loading && !s.containers.is_empty())
            },
            "the server",
        )
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn deploy_shows_servers_containers_and_logs() {
    let demo = on_server().await;
    let world = &demo.world;

    let view = world.latest().unwrap();
    assert!(view.deploy.servers.len() >= 3, "{:?}", view.deploy.servers);
    assert!(view.deploy.servers.iter().any(|s| !s.online));
    let server = view.deploy.server.unwrap();
    assert_eq!(server.unreachable, None);
    assert!(server.containers.len() >= 5, "{:?}", server.containers);
    assert!(server.containers.iter().any(|c| c.healthy == Some(false)));
    assert!(!server.stacks.is_empty());
    assert!(!server.problems.is_empty());
    assert!(server.backup.is_some());

    world
        .engine
        .deploy_open_logs(server.containers[0].id.clone());
    let view = world
        .until(
            |v| v.deploy.logs.as_ref().is_some_and(|l| !l.lines.is_empty()),
            "the logs",
        )
        .await;
    let logs = view.deploy.logs.as_ref().unwrap();
    assert!(logs.lines.len() >= 8);
    assert!(logs.lines.iter().any(|l| l.error));
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn traffic_shows_a_week_its_attacks_blocks_and_settings() {
    let demo = on_server().await;
    let world = &demo.world;

    world.engine.deploy_open_traffic();
    let view = world
        .until(
            |v| v.deploy.traffic.as_ref().is_some_and(|t| !t.loading),
            "the report",
        )
        .await;
    let traffic = view.deploy.traffic.as_ref().unwrap();
    assert_eq!(traffic.problem, None);
    assert_eq!(traffic.off, None);
    assert_eq!(traffic.empty, None);
    assert!(traffic.sites.len() >= 3);
    assert!(!traffic.kpis.is_empty());
    assert_eq!(traffic.chart.as_ref().unwrap().points.len(), 7);
    assert!(traffic.breakdowns.len() >= 3);
    assert!(traffic.devices.is_some() && traffic.countries.is_some());

    world.engine.traffic_set_tab(TrafficTab::Attacks);
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.attacks.loading && !t.attacks.items.is_empty())
            },
            "the attacks",
        )
        .await;
    let attacks = &view.deploy.traffic.as_ref().unwrap().attacks;
    assert_eq!(attacks.problem, None);
    assert!(attacks.items.len() >= 3);

    world.engine.traffic_set_tab(TrafficTab::Blocked);
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.blocked.loading && !t.blocked.items.is_empty())
            },
            "the blocked list",
        )
        .await;
    assert_eq!(view.deploy.traffic.as_ref().unwrap().blocked.problem, None);

    world.engine.traffic_open_settings();
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .and_then(|t| t.settings.as_ref())
                    .is_some_and(|s| !s.loading)
            },
            "the settings",
        )
        .await;
    let settings = view.deploy.traffic.as_ref().unwrap().settings.clone();
    assert_eq!(settings.unwrap().problem, None);

    world.engine.traffic_open_dimension("page".into());
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .and_then(|t| t.dimension.as_ref())
                    .is_some_and(|d| !d.loading && !d.rows.is_empty())
            },
            "every page",
        )
        .await;
    let dimension = view.deploy.traffic.as_ref().unwrap().dimension.clone();
    assert_eq!(dimension.unwrap().problem, None);
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn restarting_a_container_succeeds_and_changes_nothing() {
    let demo = on_server().await;
    let world = &demo.world;
    let before = world.latest().unwrap().deploy.server.unwrap();

    world
        .engine
        .deploy_container_action(before.containers[0].id.clone(), "restart".into());
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();
    let view = world.until(|v| v.notice.is_some(), "done").await;
    no_error(&view);

    let after = world.latest().unwrap().deploy.server.unwrap();
    assert_eq!(after.containers, before.containers);
    assert_eq!(after.stacks, before.stacks);
}

async fn on_cloudflare() -> DemoWorld {
    let demo = connected_demo().await;
    demo.world.engine.open_section(Some(Section::Cloudflare));
    demo.world
        .until(
            |v| {
                v.cloudflare
                    .accounts
                    .iter()
                    .any(|a| !a.zones_loading && !a.zones.is_empty())
                    && !v.cloudflare.servers.is_empty()
            },
            "the zones",
        )
        .await;
    demo
}

async fn on_zone() -> DemoWorld {
    let demo = on_cloudflare().await;
    let zone = demo
        .world
        .latest()
        .unwrap()
        .cloudflare
        .accounts
        .iter()
        .flat_map(|a| a.zones.iter())
        .find(|z| z.active)
        .unwrap()
        .id
        .clone();
    demo.world.engine.cloudflare_open_zone(zone);
    demo.world
        .until(
            |v| {
                v.cloudflare.zone.as_ref().is_some_and(|z| {
                    !z.dns.loading && z.toggles.is_some() && !z.dns.records.is_empty()
                })
            },
            "the zone",
        )
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn cloudflare_lists_its_accounts_and_domains() {
    let demo = on_cloudflare().await;

    let view = demo.world.latest().unwrap();
    let cloudflare = &view.cloudflare;
    assert_eq!(cloudflare.problem, None);
    assert!(cloudflare.configured);
    assert!(cloudflare.accounts.len() >= 2);
    assert!(
        cloudflare
            .accounts
            .iter()
            .any(|a| a.tone != CloudflareTone::Good)
    );
    let zones: Vec<_> = cloudflare
        .accounts
        .iter()
        .flat_map(|a| a.zones.iter())
        .collect();
    assert!(zones.len() >= 3, "{zones:?}");
    assert!(zones.iter().any(|z| !z.active));
    assert!(
        cloudflare
            .accounts
            .iter()
            .all(|a| a.zones_problem.is_none())
    );
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_domain_shows_its_records_and_every_tab() {
    let demo = on_zone().await;
    let world = &demo.world;
    let zone = world.latest().unwrap().cloudflare.zone.unwrap();
    assert!(zone.dns.records.len() >= 6, "{:?}", zone.dns.records);
    assert_eq!(zone.dns.problem, None);

    for tab in [CloudflareTab::Ssl, CloudflareTab::Caching] {
        world.engine.cloudflare_open_tab(tab);
        world
            .until(
                |v| {
                    v.cloudflare
                        .zone
                        .as_ref()
                        .is_some_and(|z| z.tab == tab && !z.settings.is_empty())
                },
                "the settings",
            )
            .await;
    }

    world.engine.cloudflare_open_tab(CloudflareTab::Security);
    let view = world
        .until(
            |v| {
                v.cloudflare.zone.as_ref().is_some_and(|z| {
                    z.tab == CloudflareTab::Security
                        && !z.settings.is_empty()
                        && !z.rules.custom.is_empty()
                        && !z.rules.access.is_empty()
                })
            },
            "the rules",
        )
        .await;
    let rules = &view.cloudflare.zone.as_ref().unwrap().rules;
    assert_eq!(rules.problem, None);
    assert_eq!(rules.access_problem, None);

    world.engine.cloudflare_open_tab(CloudflareTab::Access);
    let view = world
        .until(
            |v| {
                v.cloudflare.zone.as_ref().is_some_and(|z| {
                    !z.access.loading && !z.access.hosts.is_empty() && !z.access.limits.is_empty()
                })
            },
            "the access tab",
        )
        .await;
    let access = &view.cloudflare.zone.as_ref().unwrap().access;
    assert_eq!(access.problem, None);
    assert_eq!(access.limits_problem, None);
    assert!(access.ready);

    world.engine.cloudflare_open_tab(CloudflareTab::Turnstile);
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| !z.turnstile.loading && !z.turnstile.widgets.is_empty())
            },
            "the widgets",
        )
        .await;
    assert_eq!(
        view.cloudflare.zone.as_ref().unwrap().turnstile.problem,
        None
    );

    world.engine.cloudflare_open_tab(CloudflareTab::Servers);
    let view = world
        .until(
            |v| {
                v.cloudflare.zone.as_ref().is_some_and(|z| {
                    !z.servers.servers.is_empty() && z.servers.servers.iter().all(|s| !s.loading)
                })
            },
            "the servers",
        )
        .await;
    let servers = &view.cloudflare.zone.as_ref().unwrap().servers;
    assert_eq!(servers.problem, None);
    assert!(servers.servers.iter().all(|s| s.problem.is_none()));
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_domain_can_be_pointed_at_a_server_and_one_added() {
    let demo = on_zone().await;
    let world = &demo.world;

    world.engine.cloudflare_open_point_domain();
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .point_domain
                    .as_ref()
                    .is_some_and(|p| !p.loading && !p.servers.is_empty())
            },
            "the servers to point at",
        )
        .await;
    let server = view.cloudflare.point_domain.unwrap().servers[0].id.clone();
    world
        .engine
        .cloudflare_preview_point_domain("beta".into(), server, false, true);
    world
        .until(
            |v| {
                v.cloudflare
                    .point_domain
                    .as_ref()
                    .is_some_and(|p| p.plan.is_some())
            },
            "the plan",
        )
        .await;
    world.engine.cloudflare_apply_point_domain();
    let view = world
        .until(
            |v| v.cloudflare.point_domain.is_none() && v.notice.is_some(),
            "pointed",
        )
        .await;
    no_error(&view);

    let account = view.cloudflare.accounts[0].id.clone();
    world.engine.cloudflare_close_zone();
    world.engine.cloudflare_open_add_domain(account);
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .add_domain
                    .as_ref()
                    .is_some_and(|a| !a.loading && !a.choices.is_empty())
            },
            "the Cloudflare accounts",
        )
        .await;
    assert_eq!(view.cloudflare.add_domain.unwrap().problem, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_dns_record_is_added_and_the_list_comes_back_unchanged() {
    let demo = on_zone().await;
    let world = &demo.world;
    let before = world.latest().unwrap().cloudflare.zone.unwrap().dns.records;

    world.engine.cloudflare_new_record();
    world
        .until(|v| v.cloudflare.record_form.is_some(), "the form")
        .await;
    world
        .engine
        .cloudflare_save_record(draft("A", "preview", "203.0.113.10"));
    let view = world
        .until(
            |v| v.cloudflare.record_form.is_none() && v.notice.is_some(),
            "added",
        )
        .await;
    no_error(&view);
    assert!(view.notice.unwrap().starts_with("Added "));

    world
        .until(
            |v| {
                v.cloudflare
                    .zone
                    .as_ref()
                    .is_some_and(|z| z.dns.records == before)
            },
            "the records read again",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_s_origin_shows_its_tunnel() {
    let demo = on_cloudflare().await;
    let world = &demo.world;
    let server = world.latest().unwrap().cloudflare.servers[0].id.clone();

    world.engine.cloudflare_open_origin(server);
    let view = world
        .until(
            |v| v.cloudflare.origin.as_ref().is_some_and(|o| !o.loading),
            "the origin",
        )
        .await;
    let origin = view.cloudflare.origin.as_ref().unwrap();
    assert_eq!(origin.problem, None);
    assert_eq!(origin.tunnel_problem, None);
    assert_eq!(origin.tunnel.as_ref().unwrap().tone, CloudflareTone::Good);
    assert!(origin.lock.is_some());

    world.engine.cloudflare_tunnel_ssh_open();
    let view = world
        .until(
            |v| {
                v.cloudflare
                    .origin_dialog
                    .as_ref()
                    .is_some_and(|d| !d.loading)
            },
            "the SSH choices",
        )
        .await;
    assert_eq!(
        view.cloudflare.origin_dialog.as_ref().unwrap().problem,
        None
    );
    no_error(&view);
}

async fn on_monitoring() -> DemoWorld {
    let demo = connected_demo().await;
    // Cloud monitors come from the website, not from the demo computer.
    demo.world
        .backend
        .answer("/api/v1/cloud-monitors", json!({"items": []}));
    demo.world.engine.open_section(Some(Section::Monitoring));
    demo.world
        .until(|v| !v.monitoring.local.is_empty(), "the monitors")
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn monitoring_lists_the_computer_s_monitors() {
    let demo = on_monitoring().await;

    let view = demo.world.latest().unwrap();
    let local = &view.monitoring.local;
    assert!(local.len() >= 4, "{local:?}");
    assert!(local.iter().any(|m| m.state == MonitorState::Up));
    assert!(local.iter().any(|m| m.state == MonitorState::Degraded));
    assert!(local.iter().any(|m| m.state == MonitorState::Paused));
    assert!(local.iter().all(|m| m.source == MonitorSource::Local));
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn pausing_a_monitor_succeeds_and_changes_nothing() {
    let demo = on_monitoring().await;
    let world = &demo.world;
    let before = world.latest().unwrap().monitoring.local;

    world
        .engine
        .monitor_set_paused(before[0].id.clone(), MonitorSource::Local, true);
    let view = world.until(|v| v.notice.is_some(), "done").await;
    no_error(&view);

    world
        .until(|v| v.monitoring.local == before, "the monitors read again")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_list_their_issues_and_one_opens() {
    let demo = on_monitoring().await;
    let world = &demo.world;

    world.engine.errors_open();
    let view = world
        .until(
            |v| !v.errors.loading && !v.errors.issues.is_empty(),
            "the issues",
        )
        .await;
    assert!(view.errors.issues.len() >= 4);
    assert_eq!(view.errors.note, None);
    let first = view.errors.issues[0].clone();

    world
        .engine
        .errors_open_issue(first.connection_id, first.id);
    let view = world
        .until(
            |v| {
                v.errors
                    .detail
                    .as_ref()
                    .is_some_and(|d| !d.loading && !d.exceptions.is_empty())
            },
            "the issue",
        )
        .await;
    let detail = view.errors.detail.as_ref().unwrap();
    assert!(detail.can_resolve);
    assert!(!detail.exceptions[0].frames.is_empty());
    no_error(&view);

    world.engine.errors_resolve();
    let view = world.until(|v| v.notice.is_some(), "resolved").await;
    no_error(&view);
}

async fn on_pipelines() -> DemoWorld {
    let demo = connected_demo().await;
    demo.world
        .engine
        .select_project(Some("northwind-shop".into()));
    demo.world
        .until(|v| v.selected_project.is_some(), "the project")
        .await;
    demo.world.engine.open_section(Some(Section::Pipelines));
    demo.world
        .until(
            |v| {
                v.pipelines
                    .status
                    .as_ref()
                    .is_some_and(|s| !s.workflows.is_empty())
            },
            "the workflows",
        )
        .await;
    demo
}

#[tokio::test(flavor = "multi_thread")]
async fn pipelines_show_runs_their_jobs_and_a_job_log() {
    let demo = on_pipelines().await;
    let world = &demo.world;

    let status = world.latest().unwrap().pipelines.status.unwrap();
    assert_eq!(status.problem, None);
    assert!(status.workflows.len() >= 4);
    let runs: Vec<_> = status
        .workflows
        .iter()
        .filter_map(|w| w.run.as_ref())
        .collect();
    assert!(runs.iter().any(|r| r.state == PipelineRunState::Success));
    assert!(runs.iter().any(|r| r.state == PipelineRunState::Running));
    let failed = runs
        .iter()
        .find(|r| r.state == PipelineRunState::Failed)
        .unwrap();

    world.engine.pipelines_open_run(failed.id);
    let view = world
        .until(
            |v| v.pipelines.run.as_ref().is_some_and(|r| !r.jobs.is_empty()),
            "the jobs",
        )
        .await;
    let jobs = view.pipelines.run.unwrap().jobs;
    let broken = jobs
        .iter()
        .find(|j| j.state == PipelineRunState::Failed)
        .unwrap();

    world.engine.pipelines_open_job(broken.id);
    let view = world
        .until(
            |v| {
                v.pipelines
                    .log
                    .as_ref()
                    .is_some_and(|l| !l.loading && !l.lines.is_empty())
            },
            "the log",
        )
        .await;
    let log = view.pipelines.log.as_ref().unwrap();
    assert!(log.lines.len() >= 10);
    assert!(log.lines.iter().any(|l| l.error));
    no_error(&view);
}

#[tokio::test(flavor = "multi_thread")]
async fn running_a_workflow_succeeds_and_changes_nothing() {
    let demo = on_pipelines().await;
    let world = &demo.world;
    let before = world.latest().unwrap().pipelines.status.unwrap();
    let plain = before
        .workflows
        .iter()
        .find(|w| w.can_dispatch && w.inputs.is_empty())
        .unwrap()
        .id;

    world.engine.pipelines_dispatch(plain);
    world.until(|v| v.confirm.is_some(), "the question").await;
    world.engine.confirm();
    let view = world.until(|v| v.notice.is_some(), "started").await;
    no_error(&view);

    let after = world.latest().unwrap().pipelines.status.unwrap();
    assert_eq!(after, before);
}
