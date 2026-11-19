//! Website traffic and attacks on the phone (E111): a Deploy server's report for any range and
//! site with the desktop's numbers, its attacks with Block behind a question, the blocked list, the
//! settings the phone may change, and an attack notification that opens that site's attacks.

mod common;

use common::{World, connected, signed_in};
use runova_ffi::notifications::notification_destination;
use runova_ffi::view::{
    ConnectionPhase, NotificationDestination, Section, TrafficRange, TrafficTab, TrafficTone,
    TrafficTrend,
};
use serde_json::{Value, json};

const DAY: i64 = 86_400_000;
const LIST: &str = "/api/v1/notifications?page=1&pageSize=50";

fn servers() -> Value {
    json!([
        {"id": "srv1", "name": "Prod", "host": "10.0.0.1", "state": "online", "problem": null},
    ])
}

fn totals(visitors: i64, visits: i64, page_views: i64, bounces: i64) -> Value {
    json!({
        "visitors": visitors, "visits": visits, "pageViews": page_views,
        "requests": 60_000, "botRequests": 6_000, "bytes": 1_610_612_736_i64,
        "bounces": bounces, "visitSeconds": visits * 95,
        "status2xx": 50_000, "status3xx": 3_000, "status4xx": 900, "status5xx": 100,
        "averageResponseMs": 42.0, "p95ResponseMs": 180.0,
    })
}

fn report(role: &str, range: &str, granularity: &str, enabled: bool) -> Value {
    let from = 1_763_078_400_000_i64;
    let series: Vec<Value> = (0..7)
        .map(|i| {
            json!({"at": from + i * DAY, "axis": format!("{} Nov", 12 + i),
                   "label": format!("Day {}", 12 + i),
                   "visitors": 1000 + i * 100, "pageViews": 4000 + i * 500})
        })
        .collect();
    let previous: Vec<Value> = (0..7)
        .map(|_| json!({"visitors": 900, "pageViews": 3500}))
        .collect();
    json!({
        "role": role, "siteId": null, "range": range, "granularity": granularity,
        "granularities": [
            {"value": "hour", "label": "Hour", "enabled": true, "reason": null},
            {"value": "day", "label": "Day", "enabled": true, "reason": null},
            {"value": "week", "label": "Week", "enabled": false, "reason": "Pick four weeks or more to see weeks."},
            {"value": "month", "label": "Month", "enabled": false, "reason": "Pick two months or more to see months."},
        ],
        "fromUnixMs": from, "toUnixMs": from + 7 * DAY - 1, "timeZone": "UTC",
        "enabled": enabled, "collectingSince": null,
        "sites": [{"id": "blog", "label": "blog.example.com"}, {"id": "shop", "label": "shop.example.com"}],
        "totals": totals(12_900, 15_000, 41_000, 6_300),
        "previous": totals(11_120, 15_000, 0, 5_000),
        "series": series,
        "previousSeries": previous,
        "breakdowns": [
            {"dimension": "page", "total": 41_000, "top": [
                {"value": "/", "count": 20_500}, {"value": "/blog", "count": 10_250}]},
            {"dimension": "referrer", "total": 41_000, "top": [{"value": "", "count": 2_000}]},
            {"dimension": "device", "total": 41_000, "top": [
                {"value": "desktop", "count": 30_750}, {"value": "mobile", "count": 10_250}]},
            {"dimension": "country", "total": 41_000, "top": [
                {"value": "US", "count": 20_500, "name": "United States"},
                {"value": "XX", "count": 100, "name": "Unknown"}]},
            {"dimension": "statusCode", "total": 60_000, "top": [{"value": "200", "count": 50_000}]},
        ],
        "countrySources": "82% from Cloudflare, 18% from DB-IP",
    })
}

fn attacks(now: i64) -> Value {
    json!({
        "events": [
            {"id": 41, "siteId": "blog", "kind": "scan", "kindLabel": "Scans", "address": "198.51.100.23",
             "country": "NL", "countryName": "Netherlands", "firstSeen": now - 3 * 3_600_000,
             "lastSeen": now - 2 * 60_000, "count": 412,
             "samplePaths": ["/.env", "/.git/config"], "blocked": false},
            {"id": 38, "siteId": "shop", "kind": "flood", "kindLabel": "Floods", "address": "2001:db8::1",
             "country": null, "countryName": null, "firstSeen": now - 20 * 3_600_000,
             "lastSeen": now - 19 * 3_600_000, "count": 9120, "samplePaths": ["/"], "blocked": true},
        ],
        "series": [{"startUnixMs": now - DAY, "scan": 1, "bruteForce": 0, "flood": 1, "injection": 0}],
        "addresses": 2, "blocked": 1,
    })
}

fn blocked(now: i64) -> Value {
    json!([
        {"id": 7, "network": "203.0.113.45", "reason": "Password guessing", "automatic": true,
         "createdAt": now - 2 * 3_600_000, "siteId": "shop", "createdBy": null,
         "expiresAt": now + 3 * 3_600_000},
        {"id": 8, "network": "10.9.0.0/16", "reason": "Blocked from the phone", "automatic": false,
         "createdAt": now - 3 * DAY, "siteId": null, "createdBy": "sam", "expiresAt": null},
    ])
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

const OK: fn(&str) -> Value = |message| json!({"ok": true, "message": message});

async fn on_server(role: &str) -> World {
    let world = connected().await;
    world.computer.answer("deploy.servers", servers());
    world.computer.answer(
        "deploy.overview",
        json!({"reachable": true, "containers": [], "stacks": [], "problems": []}),
    );
    world
        .computer
        .answer("deploy.traffic", report(role, "7d", "day", true));
    world
        .computer
        .answer("deploy.trafficAttacks", attacks(now_ms()));
    world
        .computer
        .answer("deploy.trafficBlocked", blocked(now_ms()));
    world.engine.open_section(Some(Section::Deploy));
    world
        .until(|v| !v.deploy.servers.is_empty(), "the servers")
        .await;
    world.engine.deploy_open_server("srv1".into());
    world
        .until(|v| v.deploy.server.is_some(), "the server")
        .await;
    world
}

async fn on_traffic(role: &str) -> World {
    let world = on_server(role).await;
    world.engine.deploy_open_traffic();
    world
        .until(
            |v| v.deploy.traffic.as_ref().is_some_and(|t| !t.loading),
            "the report",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_shows_seven_days_of_every_site_at_first() {
    let world = on_traffic("admin").await;

    assert_eq!(
        world.computer.params_of("deploy.traffic")[0],
        Some(json!({"serverId": "srv1", "range": "7d"}))
    );
    let traffic = world.latest().unwrap().deploy.traffic.unwrap();
    assert_eq!(traffic.server_name, "Prod");
    assert_eq!(traffic.range, TrafficRange::Week);
    assert_eq!(traffic.site_label, "All websites");
    let labels: Vec<_> = traffic.ranges.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(
        labels,
        ["Today", "7 days", "30 days", "90 days", "12 months"]
    );
    let sites: Vec<_> = traffic.sites.iter().map(|s| s.label.as_str()).collect();
    assert_eq!(
        sites,
        ["All websites", "blog.example.com", "shop.example.com"]
    );
    let day = traffic
        .granularities
        .iter()
        .find(|g| g.value == "day")
        .unwrap();
    assert!(day.selected && day.enabled);
    assert!(!traffic.granularities[2].enabled);
    assert!(traffic.can_admin);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tiles_read_like_the_computer() {
    let world = on_traffic("viewer").await;

    let traffic = world.latest().unwrap().deploy.traffic.unwrap();
    let tile = |label: &str| {
        traffic
            .kpis
            .iter()
            .find(|k| k.label == label)
            .cloned()
            .unwrap_or_else(|| panic!("no {label}"))
    };
    let visitors = tile("Unique visitors");
    assert_eq!(visitors.value, "12.9K");
    assert_eq!(visitors.prefix.as_deref(), Some("about"));
    let change = visitors.change.unwrap();
    assert_eq!(change.text, "+16%");
    assert_eq!(change.trend, TrafficTrend::Up);
    assert_eq!(change.tone, TrafficTone::Good);

    assert_eq!(tile("Visits").value, "15K");
    assert_eq!(tile("Visits").change.unwrap().text, "No change");
    assert_eq!(tile("Page views").change.unwrap().text, "New");
    let bounce = tile("Bounce rate");
    assert_eq!(bounce.value, "42%");
    assert_eq!(bounce.change.as_ref().unwrap().tone, TrafficTone::Bad);
    assert_eq!(tile("Pages per visit").value, "2.7");
    assert_eq!(tile("Visit length").value, "1m 35s");
    assert_eq!(tile("Bandwidth").value, "1.5 GB");
    assert_eq!(tile("Bandwidth").change.unwrap().tone, TrafficTone::Neutral);
    assert_eq!(tile("Bot share").value, "10%");
    assert!(!traffic.can_admin);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_chart_has_both_periods_and_a_readout_for_each_point() {
    let world = on_traffic("admin").await;

    let chart = world
        .latest()
        .unwrap()
        .deploy
        .traffic
        .unwrap()
        .chart
        .unwrap();
    assert_eq!(chart.points.len(), 7);
    let last = &chart.points[6];
    assert_eq!(last.axis, "18 Nov");
    assert_eq!(last.visitors, 1600.0);
    assert_eq!(last.page_views, 7000.0);
    assert_eq!(last.previous_page_views, Some(3500.0));
    assert_eq!(last.readout, "Day 18: 1,600 visitors, 7,000 page views");
    assert_eq!(
        last.previous_readout.as_deref(),
        Some("Period before: 900 visitors, 3,500 page views")
    );
    assert_eq!(chart.max, 10_000.0);
    assert_eq!(chart.y_labels, ["10K", "5,000", "0"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn breakdowns_have_shares_and_countries_have_flags() {
    let world = on_traffic("admin").await;

    let traffic = world.latest().unwrap().deploy.traffic.unwrap();
    let pages = &traffic.breakdowns[0];
    assert_eq!(pages.title, "Pages");
    assert_eq!(pages.unit, "page views");
    assert_eq!(pages.rows[0].label, "/");
    assert_eq!(pages.rows[0].value, "20.5K");
    assert_eq!(pages.rows[0].share_label, "50%");
    assert!((pages.rows[1].share - 0.25).abs() < 1e-6);
    assert_eq!(traffic.breakdowns[1].rows[0].label, "Direct or unknown");
    assert!(
        traffic
            .breakdowns
            .iter()
            .all(|b| b.dimension != "device" && b.dimension != "country")
    );

    let devices = traffic.devices.unwrap();
    assert_eq!(devices.rows[0].label, "Desktop");
    assert_eq!(devices.rows[0].share_label, "75%");

    let countries = traffic.countries.unwrap();
    assert_eq!(countries.rows[0].label, "United States");
    assert_eq!(
        countries.rows[0].flag.as_deref(),
        Some("\u{1F1FA}\u{1F1F8}")
    );
    assert_eq!(countries.rows[1].label, "Unknown");
    assert_eq!(countries.rows[1].flag, None);
    assert_eq!(
        traffic.country_sources.as_deref(),
        Some("82% from Cloudflare, 18% from DB-IP")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn another_range_site_or_bucket_asks_again_with_it() {
    let world = on_traffic("admin").await;

    world.engine.traffic_set_range(TrafficRange::Today);
    world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| t.range == TrafficRange::Today)
            },
            "today",
        )
        .await;
    world.engine.traffic_set_site(Some("blog".into()));
    world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| t.site_label == "blog.example.com")
            },
            "the site",
        )
        .await;
    world.engine.traffic_set_granularity("hour".into());
    world
        .until(
            |_| world.computer.params_of("deploy.traffic").len() >= 4,
            "hours",
        )
        .await;

    let asked = world.computer.params_of("deploy.traffic");
    assert_eq!(
        asked[1],
        Some(json!({"serverId": "srv1", "range": "today"}))
    );
    assert_eq!(
        asked[2],
        Some(json!({"serverId": "srv1", "range": "today", "siteId": "blog"}))
    );
    assert_eq!(
        asked[3],
        Some(
            json!({"serverId": "srv1", "range": "today", "siteId": "blog", "granularity": "hour"})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn statistics_that_are_off_say_who_can_turn_them_on() {
    let world = on_server("viewer").await;
    world
        .computer
        .answer("deploy.traffic", report("viewer", "7d", "day", false));
    world.engine.deploy_open_traffic();
    let view = world
        .until(
            |v| v.deploy.traffic.as_ref().is_some_and(|t| t.off.is_some()),
            "off",
        )
        .await;

    assert_eq!(
        view.deploy.traffic.unwrap().off.as_deref(),
        Some("An Admin or Owner can turn traffic statistics on for this server.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_core_is_said_in_words() {
    let world = on_server("admin").await;
    let older = "This server runs an older core without traffic statistics. Update the core from the Overview, then try again.";
    world.computer.refuse("deploy.traffic", "failed", older);

    world.engine.deploy_open_traffic();
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| t.problem.is_some())
            },
            "the problem",
        )
        .await;

    assert_eq!(view.deploy.traffic.unwrap().problem.as_deref(), Some(older));
}

#[tokio::test(flavor = "multi_thread")]
async fn attacks_list_with_kind_country_and_when() {
    let world = on_traffic("admin").await;

    world.engine.traffic_set_tab(TrafficTab::Attacks);
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.attacks.items.is_empty())
            },
            "the attacks",
        )
        .await;

    assert_eq!(
        world.computer.params_of("deploy.trafficAttacks")[0],
        Some(json!({"serverId": "srv1"}))
    );
    let attacks = view.deploy.traffic.unwrap().attacks;
    assert_eq!(attacks.summary, "2 addresses in the last 7 days, 1 blocked");
    let scan = &attacks.items[0];
    assert_eq!(scan.kind_label, "Scans");
    assert_eq!(scan.address, "198.51.100.23");
    assert_eq!(scan.country.as_deref(), Some("Netherlands"));
    assert_eq!(scan.flag.as_deref(), Some("\u{1F1F3}\u{1F1F1}"));
    assert_eq!(scan.site, "blog.example.com");
    assert_eq!(scan.count_label, "412 requests");
    assert_eq!(scan.when_label, "2m ago");
    assert_eq!(scan.paths, ["/.env", "/.git/config"]);
    assert!(scan.can_block);
    assert!(!attacks.items[1].can_block);
}

#[tokio::test(flavor = "multi_thread")]
async fn blocking_an_address_asks_first_then_tells_the_computer() {
    let world = on_traffic("admin").await;
    world.computer.answer(
        "deploy.trafficBlock",
        OK("Blocked 198.51.100.23. nginx refuses it on every site on this server."),
    );
    world.engine.traffic_set_tab(TrafficTab::Attacks);
    world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.attacks.items.is_empty())
            },
            "the attacks",
        )
        .await;

    world.engine.traffic_block(41);
    let confirm = world
        .until(|v| v.confirm.is_some(), "the question")
        .await
        .confirm
        .unwrap();
    assert_eq!(confirm.title, "Block 198.51.100.23?");
    assert!(
        confirm
            .detail
            .starts_with("nginx will refuse 198.51.100.23 on every site")
    );
    assert!(confirm.danger);
    assert!(world.computer.params_of("deploy.trafficBlock").is_empty());

    world.engine.confirm();
    world.until(|v| v.notice.is_some(), "done").await;

    assert_eq!(
        world.computer.params_of("deploy.trafficBlock"),
        vec![Some(
            json!({"serverId": "srv1", "network": "198.51.100.23", "siteId": "blog"})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_cannot_block() {
    let world = on_traffic("viewer").await;
    world.engine.traffic_set_tab(TrafficTab::Attacks);
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.attacks.items.is_empty())
            },
            "the attacks",
        )
        .await;
    assert!(!view.deploy.traffic.unwrap().attacks.items[0].can_block);

    world.engine.traffic_block(41);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    assert!(world.latest().unwrap().confirm.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_blocked_list_lets_an_address_back_after_asking() {
    let world = on_traffic("admin").await;
    world.computer.answer(
        "deploy.trafficUnblock",
        OK("Unblocked. nginx answers that address again."),
    );

    world.engine.traffic_set_tab(TrafficTab::Blocked);
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.blocked.items.is_empty())
            },
            "the blocked list",
        )
        .await;
    let list = view.deploy.traffic.unwrap().blocked;
    assert_eq!(list.items[0].network, "203.0.113.45");
    assert_eq!(
        list.items[0].detail,
        "Automatic, 2h ago, on shop.example.com. Lifted in 3h."
    );
    assert_eq!(
        list.items[1].detail,
        "By sam, 3d ago, every site. For good."
    );

    world.engine.traffic_unblock(8);
    let confirm = world
        .until(|v| v.confirm.is_some(), "the question")
        .await
        .confirm
        .unwrap();
    assert_eq!(confirm.title, "Let 10.9.0.0/16 back in?");
    world.engine.confirm();
    world.until(|v| v.notice.is_some(), "done").await;

    assert_eq!(
        world.computer.params_of("deploy.trafficUnblock"),
        vec![Some(json!({"serverId": "srv1", "blockId": 8}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_send_only_what_changed() {
    let world = on_traffic("admin").await;
    world.computer.answer(
        "deploy.trafficStatus",
        json!({
            "role": "admin",
            "statistics": {"enabled": true, "countries": true, "hourlyRetentionDays": 90, "dailyRetentionDays": 730},
            "detection": {"enabled": true},
            "autoBlock": {"enabled": true, "kinds": ["scan", "bruteForce"], "minutes": 60},
            "geoDatabaseReady": true, "storageBytes": 12_582_912, "changedAt": null, "changedBy": null,
        }),
    );
    world
        .computer
        .answer("deploy.trafficSaveSettings", OK("Saved."));

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
    let settings = view.deploy.traffic.unwrap().settings.unwrap();
    assert!(settings.statistics && settings.countries && settings.detection);
    assert_eq!(settings.hourly_days, 90);
    assert_eq!(settings.hourly_choices, [7, 30, 90, 180, 365]);
    assert_eq!(settings.daily_choices, [30, 365, 730, 1825]);
    assert_eq!(settings.storage, "12 MB of statistics on the server");
    assert_eq!(
        settings.auto_block,
        "Auto-block is on for scans and password guessing, for 1h. Change it on the computer."
    );

    world.engine.traffic_settings_countries(false);
    world.engine.traffic_settings_hourly(30);
    world.engine.traffic_settings_detection(false);
    world.engine.traffic_settings_save();
    world.until(|v| v.notice.is_some(), "saved").await;

    assert_eq!(
        world.computer.params_of("deploy.trafficSaveSettings"),
        vec![Some(json!({
            "serverId": "srv1",
            "statistics": {"countries": false, "hourlyRetentionDays": 30},
            "detection": {"enabled": false},
        }))]
    );
    let after = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| t.settings.is_none())
            },
            "closed",
        )
        .await;
    assert_eq!(after.notice.as_deref(), Some("Saved."));
}

#[tokio::test(flavor = "multi_thread")]
async fn see_all_pages_through_a_breakdown() {
    let world = on_traffic("admin").await;
    let items: Vec<Value> = (0..50)
        .map(|i| json!({"value": format!("/p{i}"), "count": 100 - i}))
        .collect();
    world.computer.answer(
        "deploy.trafficDimension",
        json!({"dimension": "page", "total": 41_000, "totalItems": 120, "items": items}),
    );

    world.engine.traffic_open_dimension("page".into());
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .and_then(|t| t.dimension.as_ref())
                    .is_some_and(|d| !d.loading)
            },
            "the page",
        )
        .await;
    let dimension = view.deploy.traffic.unwrap().dimension.unwrap();
    assert_eq!(dimension.title, "Pages");
    assert_eq!(dimension.rows.len(), 50);
    assert_eq!(dimension.total_label, "120 in all");
    assert!(dimension.can_load_more);

    world.engine.traffic_dimension_more();
    world
        .until(
            |_| world.computer.params_of("deploy.trafficDimension").len() == 2,
            "the next page",
        )
        .await;
    let asked = world.computer.params_of("deploy.trafficDimension");
    let from = 1_763_078_400_000_i64;
    assert_eq!(
        asked[1],
        Some(
            json!({"serverId": "srv1", "fromUnixMs": from, "toUnixMs": from + 7 * DAY - 1,
                    "dimension": "page", "offset": 50})
        )
    );
}

#[test]
fn a_deploy_notification_opens_deploy() {
    assert_eq!(
        notification_destination("deploys".into()),
        NotificationDestination::Deploy
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_attack_notification_opens_that_sites_attacks() {
    let world = connected().await;
    world.computer.answer("deploy.servers", servers());
    world
        .computer
        .answer("deploy.traffic", report("admin", "7d", "day", true));
    world
        .computer
        .answer("deploy.trafficAttacks", attacks(now_ms()));

    world.engine.deploy_open_target("srv1:blog".into());
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.attacks.items.is_empty())
            },
            "the attacks",
        )
        .await;

    let traffic = view.deploy.traffic.unwrap();
    assert_eq!(traffic.tab, TrafficTab::Attacks);
    assert_eq!(traffic.site_id.as_deref(), Some("blog"));
    assert_eq!(view.deploy.server.unwrap().id, "srv1");
    assert_eq!(
        world.computer.params_of("deploy.trafficAttacks")[0],
        Some(json!({"serverId": "srv1", "siteId": "blog"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_target_that_is_no_server_only_opens_the_list() {
    let world = connected().await;
    world.computer.answer("deploy.servers", servers());

    world.engine.deploy_open_target("files-site-3".into());
    world
        .until(|v| !v.deploy.servers.is_empty(), "the servers")
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let view = world.latest().unwrap();
    assert!(view.deploy.server.is_none());
    assert!(view.deploy.traffic.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn tapping_an_attack_in_the_inbox_opens_its_site() {
    let world = signed_in().await;
    world.backend.answer(
        LIST,
        json!({"items": [{"id": 9, "kind": "deploys", "title": "Warning on Prod", "body": "",
                          "category": "deploys", "itemId": "srv1:blog", "readAt": null}],
               "unread": 1}),
    );
    world.backend.answer("/api/v1/notifications/9", json!({}));
    world.engine.open_section(Some(Section::Notifications));
    world
        .until(|v| !v.notifications.items.is_empty(), "the inbox")
        .await;
    world.engine.connect(5);
    world
        .until(
            |v| {
                v.connection
                    .as_ref()
                    .is_some_and(|c| c.phase == ConnectionPhase::Connected)
            },
            "connected",
        )
        .await;
    world.computer.answer("deploy.servers", servers());
    world
        .computer
        .answer("deploy.traffic", report("admin", "7d", "day", true));
    world
        .computer
        .answer("deploy.trafficAttacks", attacks(now_ms()));

    world.engine.notification_open(9);
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| t.tab == TrafficTab::Attacks)
            },
            "the attacks",
        )
        .await;

    assert_eq!(
        view.notifications.items[0].destination,
        NotificationDestination::Deploy
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_tapped_before_the_computer_is_there_opens_once_it_is() {
    let world = signed_in().await;
    world
        .engine
        .notification_tapped(None, "deploys".into(), Some("srv1:blog".into()), None);
    world.computer.answer("deploy.servers", servers());
    world
        .computer
        .answer("deploy.traffic", report("admin", "7d", "day", true));
    world
        .computer
        .answer("deploy.trafficAttacks", attacks(now_ms()));

    world.engine.connect(5);
    world
        .until(
            |v| {
                v.connection
                    .as_ref()
                    .is_some_and(|c| c.phase == ConnectionPhase::Connected)
            },
            "connected",
        )
        .await;
    world.engine.open_section(Some(Section::Deploy));
    let view = world
        .until(
            |v| {
                v.deploy
                    .traffic
                    .as_ref()
                    .is_some_and(|t| !t.attacks.items.is_empty())
            },
            "the attacks",
        )
        .await;

    assert_eq!(view.deploy.server.unwrap().id, "srv1");
    assert_eq!(
        view.deploy.traffic.unwrap().site_id.as_deref(),
        Some("blog")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_period_before_counting_says_there_is_no_earlier_data() {
    let world = on_server("admin").await;
    let mut partial = report("admin", "7d", "day", true);
    partial["previous"] = Value::Null;
    partial["noEarlierData"] = json!(true);
    partial["previousSeries"] = json!([null, null, null,
        {"visitors": 900, "pageViews": 3500}, {"visitors": 900, "pageViews": 3500},
        {"visitors": 900, "pageViews": 3500}, {"visitors": 900, "pageViews": 3500}]);
    world.computer.answer("deploy.traffic", partial);

    world.engine.deploy_open_traffic();
    let view = world
        .until(
            |v| v.deploy.traffic.as_ref().is_some_and(|t| !t.loading),
            "the report",
        )
        .await;

    let traffic = view.deploy.traffic.unwrap();
    let change = traffic.kpis[0].change.clone().unwrap();
    assert_eq!(change.text, "No earlier data");
    assert_eq!(change.tone, TrafficTone::Neutral);
    assert_eq!(change.trend, TrafficTrend::Flat);
    let chart = traffic.chart.unwrap();
    assert_eq!(chart.points[2].previous_visitors, None);
    assert_eq!(chart.points[2].previous_readout, None);
    assert_eq!(chart.points[3].previous_visitors, Some(900.0));
}
