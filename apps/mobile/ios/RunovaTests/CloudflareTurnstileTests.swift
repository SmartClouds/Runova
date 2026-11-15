import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `CloudflareTurnstileTest.kt`, for the comparison with Android.
@MainActor
final class CloudflareTurnstileTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: nil, direct: true, error: nil)
    private let sitekey = "0x4AAAAAAABkMYinukE8nzY"

    private var widget: CloudflareWidgetView {
        CloudflareWidgetView(
            sitekey: sitekey, name: "Contact form", domains: ["example.com", "shop.example.com"],
            modeLabel: "Managed", clearanceLabel: "Off",
            snippet:
                "<script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" async defer></script>\n\n<form action=\"/submit\" method=\"post\">\n  <div class=\"cf-turnstile\" data-sitekey=\"\(sitekey)\"></div>\n  <button type=\"submit\">Send</button>\n</form>"
        )
    }

    private let servers = [
        CloudflareDnsServerView(
            id: "srv-1", name: "prod", hasToken: true, madeHere: true,
            detail: "Holds a token Runova made for example.com, for wildcard certificates.", loading: false,
            busy: false, problem: nil),
        CloudflareDnsServerView(
            id: "srv-2", name: "lab", hasToken: false, madeHere: false,
            detail: "No DNS token for example.com, so no wildcard certificates.", loading: false, busy: false,
            problem: nil),
    ]

    private func view(
        _ tab: CloudflareTab, form: CloudflareWidgetFormView? = nil
    ) -> AppView {
        let zone = CloudflareZoneView(
            id: "z1", name: "example.com", accountId: "acct-1", statusLabel: "Active", active: true, pending: false,
            plan: "Free Website", nameServers: [], tab: tab, toggles: nil,
            dns: CloudflareDnsView(loading: false, problem: nil, records: []), settings: [],
            rules: CloudflareRulesView(loading: false, problem: nil, custom: [], access: [], accessProblem: nil),
            access: CloudflareAccessView(
                loading: false, problem: nil, ready: true, needsTeam: false, teamDomain: nil, hosts: [], limits: [],
                limitsProblem: nil),
            turnstile: CloudflareTurnstileView(loading: false, problem: nil, widgets: [widget]),
            servers: CloudflareServersView(loading: false, problem: nil, servers: servers))
        return fixtureView(
            connection: connected,
            cloudflare: CloudflareScreen(
                loading: false, configured: true, problem: nil, accounts: [], zone: zone, tokenForm: nil,
                addDomain: nil, recordForm: nil, pointDomain: nil, ruleBuilder: nil, accessRuleForm: nil,
                emailGateForm: nil, ipLimitForm: nil, widgetForm: form, revealedSecret: nil, biometric: nil))
    }

    private func options(_ pairs: [(String, String)]) -> [CloudflareOptionView] {
        pairs.map { CloudflareOptionView(value: $0.0, label: $0.1) }
    }

    func testTurnstile() throws {
        try renderSnapshot(view(.turnstile), "cloudflare-turnstile", tab: "cloudflare")
    }

    func testServers() throws {
        try renderSnapshot(view(.servers), "cloudflare-servers", tab: "cloudflare")
    }

    func testWidgetForm() throws {
        let form = CloudflareWidgetFormView(
            sitekey: nil, title: "Add a widget",
            draft: WidgetDraft(
                name: "", domains: ["example.com"], mode: "managed", clearance: "no_clearance", region: "world",
                offlabel: false, ephemeralId: false),
            modes: options([("managed", "Managed"), ("non-interactive", "Non-interactive"), ("invisible", "Invisible")]),
            clearances: options([
                ("no_clearance", "Off"), ("jschallenge", "Non-interactive"), ("managed", "Managed"),
                ("interactive", "Interactive"),
            ]),
            regions: options([("world", "Worldwide"), ("china", "China")]), problem: nil, saving: false)
        try renderSnapshot(view(.turnstile, form: form), "cloudflare-widget", tab: "cloudflare")
    }
}
