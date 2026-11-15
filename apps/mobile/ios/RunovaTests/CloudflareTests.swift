import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `CloudflareTest.kt`, for the comparison with Android.
@MainActor
final class CloudflareTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: nil, direct: true, error: nil)

    private let work = CloudflareAccountView(
        id: "acct-1", label: "Work", statusLabel: "Needs 1 permission", tone: .warning,
        detail: "Add them to the token on Cloudflare, then check it again.", missing: ["Zone > Zone WAF > Edit"],
        unverified: [], locked: false,
        zones: [
            CloudflareZoneRow(id: "z1", name: "example.com", statusLabel: "Active", active: true, plan: "Free Website"),
            CloudflareZoneRow(
                id: "z2", name: "shop.example.org", statusLabel: "Waiting for name servers", active: false,
                plan: "Free Website"),
        ], zonesLoading: false, zonesProblem: nil)

    private let home = CloudflareAccountView(
        id: "acct-2", label: "Home", statusLabel: "Locked", tone: .warning,
        detail: "Unlock Servers on this computer to use this account.", missing: [], unverified: [], locked: true,
        zones: [], zonesLoading: false, zonesProblem: nil)

    private func record(_ id: String, _ type: String, _ name: String, _ content: String, proxied: Bool, ttl: String = "Auto")
        -> CloudflareRecordView
    {
        CloudflareRecordView(
            id: id, recordType: type, name: name, fullName: name == "@" ? "example.com" : "\(name).example.com",
            content: content, proxied: proxied, proxiable: type != "MX", ttlLabel: ttl, editable: true,
            priority: type == "MX" ? 10 : nil, comment: "")
    }

    private func zone(pending: Bool = false) -> CloudflareZoneView {
        CloudflareZoneView(
            id: "z1", name: "example.com", accountId: "acct-1",
            statusLabel: pending ? "Waiting for name servers" : "Active", active: !pending, pending: pending,
            plan: "Free Website", nameServers: ["bob.ns.cloudflare.com", "lola.ns.cloudflare.com"], tab: .dns,
            toggles: CloudflareTogglesView(
                devMode: true, devModeDetail: "On, 2 h 59 min left", devModeEditable: true, underAttack: false,
                underAttackEditable: true, aiBotsBlocked: true, aiBotsDetail: "On, everywhere", aiBotsAvailable: true,
                saving: false),
            dns: CloudflareDnsView(
                loading: false, problem: nil,
                records: [
                    record("r1", "A", "@", "203.0.113.10", proxied: true),
                    record("r2", "CNAME", "www", "example.com", proxied: true),
                    record("r3", "MX", "@", "mx.example.net", proxied: false, ttl: "1 hr"),
                ]),
            settings: [],
            rules: CloudflareRulesView(loading: false, problem: nil, custom: [], access: [], accessProblem: nil))
    }

    private func screen(
        zone: CloudflareZoneView? = nil, accounts: [CloudflareAccountView]? = nil,
        token: CloudflareTokenFormView? = nil, form: CloudflareRecordFormView? = nil,
        point: CloudflarePointDomainView? = nil
    ) -> CloudflareScreen {
        let listed = accounts ?? [work, home]
        return CloudflareScreen(
            loading: false, configured: !listed.isEmpty, problem: nil, accounts: listed, zone: zone, tokenForm: token,
            addDomain: nil, recordForm: form, pointDomain: point, ruleBuilder: nil, accessRuleForm: nil, biometric: nil)
    }

    private func draft() -> RecordDraft {
        RecordDraft(
            recordType: "A", name: "app", content: "203.0.113.20", ttl: 1, proxied: true, priority: 10, comment: "",
            caaFlags: 0, caaTag: "issue", caaValue: "", srvPriority: 0, srvWeight: 0, srvPort: 0, srvTarget: "")
    }

    func testAccounts() throws {
        try renderSnapshot(fixtureView(connection: connected, cloudflare: screen()), "cloudflare", tab: "cloudflare")
    }

    func testEmpty() throws {
        try renderSnapshot(
            fixtureView(connection: connected, cloudflare: screen(accounts: [])), "cloudflare-empty", tab: "cloudflare")
    }

    func testZone() throws {
        try renderSnapshot(
            fixtureView(connection: connected, cloudflare: screen(zone: zone())), "cloudflare-zone", tab: "cloudflare")
    }

    func testPending() throws {
        try renderSnapshot(
            fixtureView(connection: connected, cloudflare: screen(zone: zone(pending: true))), "cloudflare-pending",
            tab: "cloudflare")
    }

    func testRecordForm() throws {
        let form = CloudflareRecordFormView(
            recordId: nil, title: "Add a record", zoneName: "example.com", draft: draft(), problem: nil, saving: false)
        try renderSnapshot(
            fixtureView(connection: connected, cloudflare: screen(zone: zone(), form: form)), "cloudflare-record",
            tab: "cloudflare")
    }

    func testTokenForm() throws {
        let form = CloudflareTokenFormView(accountId: nil, accountLabel: nil, problem: nil, saving: false)
        try renderSnapshot(
            fixtureView(connection: connected, cloudflare: screen(token: form)), "cloudflare-token", tab: "cloudflare")
    }

    func testPointDomain() throws {
        let plan = CloudflarePointPlanView(
            summary: "2 changes to point example.com and www.example.com at prod.",
            changes: [
                CloudflarePlannedChangeView(
                    actionLabel: "Change", tone: .warning, recordType: "A", name: "@", content: "198.51.100.5",
                    previous: "203.0.113.10", reason: nil),
                CloudflarePlannedChangeView(
                    actionLabel: "Add", tone: .good, recordType: "A", name: "www", content: "198.51.100.5",
                    previous: nil, reason: nil),
            ], upToDate: false)
        let point = CloudflarePointDomainView(
            zoneName: "example.com", servers: [CloudflareChoiceView(id: "srv-1", name: "prod")], loading: false,
            plan: plan, problem: nil, saving: false)
        try renderSnapshot(
            fixtureView(connection: connected, cloudflare: screen(zone: zone(), point: point)), "cloudflare-point",
            tab: "cloudflare")
    }

    func testTheAccountCardOffersEveryTokenAction() {
        var asked: [String?] = []
        let intents = CloudflareIntents(openTokenForm: { asked.append($0) })
        intents.openTokenForm("acct-1")
        intents.openTokenForm(nil)
        XCTAssertEqual(asked, ["acct-1", nil])
    }
}
