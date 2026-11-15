import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `CloudflareSettingsTest.kt`, for the comparison with Android.
@MainActor
final class CloudflareSettingsTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: nil, direct: true, error: nil)

    private func option(_ value: String, _ label: String) -> CloudflareOptionView {
        CloudflareOptionView(value: value, label: label)
    }

    private func toggle(_ key: String, _ title: String, _ detail: String, on: Bool) -> CloudflareSettingView {
        CloudflareSettingView(
            key: key, title: title, detail: detail, kind: .switch, value: on ? "on" : "off", on: on, options: [],
            editable: true, note: nil, noteTone: .good)
    }

    private var ssl: CloudflareSettingsGroup {
        CloudflareSettingsGroup(
            title: "SSL/TLS", detail: "How visitors and Cloudflare reach example.com over HTTPS.",
            items: [
                CloudflareSettingView(
                    key: "ssl", title: "SSL/TLS mode", detail: "How Cloudflare connects to your server.", kind: .choice,
                    value: "full", on: false,
                    options: [
                        option("off", "Off (no HTTPS)"), option("flexible", "Flexible"), option("full", "Full"),
                        option("strict", "Full (strict)"),
                    ], editable: true,
                    note:
                        "The connection to your server is encrypted, but its certificate is not checked, so anyone in between could pose as it.",
                    noteTone: .warning),
                toggle(
                    "alwaysUseHttps", "Always Use HTTPS", "Sends visitors who ask for http:// to the https:// address.",
                    on: false),
                toggle("tls13", "TLS 1.3", "The newest TLS version: faster to connect and drops older ciphers.", on: true),
            ])
    }

    private var caching: CloudflareSettingsGroup {
        let ttls: [(Int, String)] = [
            (0, "Respect existing headers"), (30, "30 seconds"), (60, "1 minute"), (3600, "1 hour"), (7200, "2 hours"),
            (14400, "4 hours"), (86400, "1 day"), (31_536_000, "1 year"),
        ]
        return CloudflareSettingsGroup(
            title: "Caching", detail: "How example.com is cached at Cloudflare and in browsers.",
            items: [
                toggle(
                    "developmentMode", "Development mode",
                    "Skips the cache for three hours, so changes to the site show at once.", on: false),
                CloudflareSettingView(
                    key: "browserCacheTtl", title: "Browser cache TTL",
                    detail: "How long a visitor's browser keeps files before it asks again.", kind: .choice,
                    value: "14400", on: false, options: ttls.map { option(String($0.0), $0.1) }, editable: true,
                    note: nil, noteTone: .good),
            ])
    }

    private var protection: CloudflareSettingsGroup {
        CloudflareSettingsGroup(
            title: "Protection", detail: "Who gets a check before reaching example.com.",
            items: [
                CloudflareSettingView(
                    key: "securityLevel", title: "Security level",
                    detail: "How suspicious a visitor has to look before Cloudflare checks them.", kind: .choice,
                    value: "medium", on: false,
                    options: [
                        option("low", "Low"), option("medium", "Medium"), option("high", "High"),
                        option("under_attack", "I'm Under Attack"),
                    ], editable: true, note: nil, noteTone: .good)
            ])
    }

    private let rules = CloudflareRulesView(
        loading: false, problem: nil,
        custom: [
            CloudflareRuleView(
                id: "r1", description: "Block Tor exit nodes", actionLabel: "Block", tone: .bad,
                expression: "(ip.src.country in {\"T1\"})", enabled: true)
        ],
        access: [
            CloudflareAccessRuleView(
                id: "a1", value: "198.51.100.4", targetLabel: "IP address", modeLabel: "Block", tone: .bad,
                notes: "Scraper")
        ], accessProblem: nil)

    private func zone(_ tab: CloudflareTab, _ groups: [CloudflareSettingsGroup]) -> CloudflareZoneView {
        CloudflareZoneView(
            id: "z1", name: "example.com", accountId: "acct-1", statusLabel: "Active", active: true, pending: false,
            plan: "Free Website", nameServers: [], tab: tab, toggles: nil,
            dns: CloudflareDnsView(loading: false, problem: nil, records: []), settings: groups, rules: rules,
            access: CloudflareAccessView(
                loading: false, problem: nil, ready: true, needsTeam: false, teamDomain: nil, hosts: [], limits: [],
                limitsProblem: nil),
            turnstile: CloudflareTurnstileView(loading: false, problem: nil, widgets: []),
            servers: CloudflareServersView(loading: false, problem: nil, servers: []))
    }

    private func view(
        _ zone: CloudflareZoneView, builder: CloudflareFormView? = nil, access: CloudflareFormView? = nil
    ) -> AppView {
        fixtureView(
            connection: connected,
            cloudflare: CloudflareScreen(
                loading: false, configured: true, problem: nil, accounts: [], zone: zone, tokenForm: nil,
                addDomain: nil, recordForm: nil, pointDomain: nil, ruleBuilder: builder, accessRuleForm: access,
                emailGateForm: nil, ipLimitForm: nil, widgetForm: nil, revealedSecret: nil, biometric: nil))
    }

    func testSsl() throws {
        try renderSnapshot(view(zone(.ssl, [ssl])), "cloudflare-ssl", tab: "cloudflare")
    }

    func testCaching() throws {
        try renderSnapshot(view(zone(.caching, [caching])), "cloudflare-caching", tab: "cloudflare")
    }

    func testSecurity() throws {
        try renderSnapshot(view(zone(.security, [protection])), "cloudflare-security", tab: "cloudflare")
    }

    func testRuleBuilder() throws {
        try renderSnapshot(
            view(zone(.security, [protection]), builder: CloudflareFormView(problem: nil, saving: false)),
            "cloudflare-rule", tab: "cloudflare")
    }

    func testAccessRuleForm() throws {
        try renderSnapshot(
            view(zone(.security, [protection]), access: CloudflareFormView(problem: nil, saving: false)),
            "cloudflare-access-rule", tab: "cloudflare")
    }
}
