import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `CloudflareAccessTest.kt`, for the comparison with Android.
@MainActor
final class CloudflareAccessTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: nil, direct: true, error: nil)

    private let hosts = [
        CloudflareGateHostView(
            hostname: "core.example.com", roleLabel: "Core server", proxied: true, canProxy: false, state: .on,
            summary: "Email code, 3 people, 24 hours", core: true, thisComputerPass: false),
        CloudflareGateHostView(
            hostname: "app.example.com", roleLabel: nil, proxied: true, canProxy: false, state: .off,
            summary: "Open to everyone", core: false, thisComputerPass: false),
        CloudflareGateHostView(
            hostname: "shop.example.com", roleLabel: nil, proxied: false, canProxy: true, state: .off,
            summary: "Cloudflare's proxy is off for it, so a gate cannot go on it yet", core: false,
            thisComputerPass: false),
        CloudflareGateHostView(
            hostname: "ssh.example.com", roleLabel: "SSH", proxied: true, canProxy: false, state: .elsewhere,
            summary: "SSH for prod, set up in Cloudflare", core: false, thisComputerPass: false),
    ]

    private let limits = [
        CloudflareIpLimitView(
            id: "l1", target: "app.example.com/admin and below", ips: ["203.0.113.10", "198.51.100.0/24"],
            enabled: true)
    ]

    private func access(ready: Bool = true, needsTeam: Bool = false) -> CloudflareAccessView {
        CloudflareAccessView(
            loading: false, problem: nil, ready: ready, needsTeam: needsTeam, teamDomain: nil, hosts: hosts,
            limits: limits, limitsProblem: nil)
    }

    private func view(
        _ access: CloudflareAccessView, gate: CloudflareEmailGateFormView? = nil,
        limit: CloudflareIpLimitFormView? = nil
    ) -> AppView {
        let zone = CloudflareZoneView(
            id: "z1", name: "example.com", accountId: "acct-1", statusLabel: "Active", active: true, pending: false,
            plan: "Free Website", nameServers: [], tab: .access, toggles: nil,
            dns: CloudflareDnsView(loading: false, problem: nil, records: []), settings: [],
            rules: CloudflareRulesView(loading: false, problem: nil, custom: [], access: [], accessProblem: nil),
            access: access)
        return fixtureView(
            connection: connected,
            cloudflare: CloudflareScreen(
                loading: false, configured: true, problem: nil, accounts: [], zone: zone, tokenForm: nil,
                addDomain: nil, recordForm: nil, pointDomain: nil, ruleBuilder: nil, accessRuleForm: nil,
                emailGateForm: gate, ipLimitForm: limit, biometric: nil))
    }

    private var sessions: [CloudflareOptionView] {
        [("30m", "30 min"), ("6h", "6 hours"), ("24h", "24 hours"), ("168h", "7 days"), ("720h", "30 days")]
            .map { CloudflareOptionView(value: $0.0, label: $0.1) }
    }

    func testAccess() throws {
        try renderSnapshot(view(access()), "cloudflare-access", tab: "cloudflare")
    }

    func testSetup() throws {
        try renderSnapshot(view(access(ready: false, needsTeam: true)), "cloudflare-access-setup", tab: "cloudflare")
    }

    func testGateForm() throws {
        let form = CloudflareEmailGateFormView(
            hostname: "app.example.com", existing: false,
            people: [
                CloudflarePersonView(value: "company.com", domain: true),
                CloudflarePersonView(value: "ana@example.com", domain: false),
            ],
            invalid: ["nope: Type an email address, or a domain like @company.com to let in everyone there."],
            session: "168h", sessions: sessions,
            preview:
                "Anyone at @company.com and ana@example.com can open app.example.com for 7 days after typing a code.",
            coreNote: nil, fromLast: false, saving: false, problem: nil)
        try renderSnapshot(view(access(), gate: form), "cloudflare-gate", tab: "cloudflare")
    }

    func testIpLimitForm() throws {
        let form = CloudflareIpLimitFormView(
            ruleId: nil,
            names: [
                CloudflareOptionView(value: "*", label: "Every name in example.com"),
                CloudflareOptionView(value: "app.example.com", label: "app.example.com"),
            ],
            hostname: "app.example.com", wholeSite: false, path: "/admin", prefix: true, pathProblem: nil,
            ips: ["198.51.100.7"], invalid: [], thisComputer: "203.0.113.77", canAddThisComputer: true, shutOut: true,
            preview:
                "Only 198.51.100.7 can open app.example.com/admin and below. Everyone else gets Cloudflare's block page.",
            canSave: true, saving: false, problem: nil)
        try renderSnapshot(view(access(), limit: form), "cloudflare-ip-limit", tab: "cloudflare")
    }
}
