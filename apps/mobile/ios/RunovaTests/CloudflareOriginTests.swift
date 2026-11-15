import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `CloudflareOriginTest.kt`, for the comparison with Android.
@MainActor
final class CloudflareOriginTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: nil, direct: true, error: nil)

    private let tunnel = CloudflareTunnelView(
        stateLabel: "On: no open web ports, everything comes through the tunnel", tone: .good, enabled: true,
        working: false, intro: nil,
        facts: [
            CloudflareFactView(label: "Tunnel", value: "runova-prod"),
            CloudflareFactView(label: "Connections to Cloudflare", value: "4"),
            CloudflareFactView(label: "SSH", value: "Open as the firewall has it"),
        ],
        drift: [], lastError: nil, warnings: [], breakGlass: false, breakGlassMinutes: 30,
        breakGlassText: "Off: if the tunnel fails with SSH closed, only your provider's console gets you in.",
        setUpLabel: nil, canClosePorts: false, canChangeSsh: true, canTurnOff: true,
        hint:
            "The sites are safe behind the tunnel. SSH is the one port left open; you can limit it with Change SSH access."
    )

    private let lock = CloudflareOriginLockView(
        stateLabel: "Off: every address reaches ports 80 and 443", tone: .warning, enabled: false,
        enableLabel: "Lock to Cloudflare", details: ["15 IPv4 and 7 IPv6 ranges from Cloudflare."], drift: [],
        warnings: [])

    private let pending = CloudflarePendingChangeView(
        id: "cs1", summary: "Close 80 and 443 to everyone", commands: ["ufw deny 80/tcp", "ufw deny 443/tcp"],
        deadlineLabel: "Rolls back in 4 min unless you keep it.")

    private func origin(_ mode: CloudflareOriginMode, pending: CloudflarePendingChangeView? = nil) -> CloudflareOriginView {
        CloudflareOriginView(
            serverId: "srv-1", serverName: "prod", loading: false, problem: nil, canAdmin: true, canOwn: true,
            mode: mode, modeLocked: false, modeNote: nil, lock: lock, lockProblem: nil, tunnel: tunnel,
            tunnelProblem: nil, pending: pending)
    }

    private func dialog(_ kind: CloudflareOriginDialogKind) -> CloudflareOriginDialogView {
        CloudflareOriginDialogView(
            kind: kind, title: "", description: "", loading: false, rows: [], rowsTitle: nil, rowsWarning: nil,
            firewallTitle: nil, commands: [], notes: [], blocked: nil, problem: nil, saving: false, canApply: false,
            applyLabel: "Apply", danger: false, aop: false, accounts: [], account: "", routeSsh: false, sshName: "",
            sshNameProblem: nil, needsAck: false, acked: false, steps: [], sshModes: [], sshMode: "", probe: nil,
            probeOk: false, canTest: false, testLabel: nil, meshAddress: nil, canJoinMesh: false, phrase: nil,
            reopenWeb: true, pointBack: true)
    }

    private func view(_ origin: CloudflareOriginView, dialog: CloudflareOriginDialogView? = nil) -> AppView {
        fixtureView(
            connection: connected,
            cloudflare: CloudflareScreen(
                loading: false, configured: true, problem: nil, accounts: [], zone: nil, tokenForm: nil,
                addDomain: nil, recordForm: nil, pointDomain: nil, ruleBuilder: nil, accessRuleForm: nil,
                emailGateForm: nil, ipLimitForm: nil, widgetForm: nil,
                servers: [CloudflareChoiceView(id: "srv-1", name: "prod")], origin: origin, originDialog: dialog,
                revealedSecret: nil, biometric: nil))
    }

    func testOrigin() throws {
        try renderSnapshot(view(origin(.tunnel, pending: pending)), "cloudflare-origin", tab: "cloudflare")
    }

    func testOriginLock() throws {
        try renderSnapshot(view(origin(.ips)), "cloudflare-origin-lock", tab: "cloudflare")
    }

    func testTunnelSetup() throws {
        var setup = dialog(.setup)
        setup.title = "Put prod behind a Cloudflare Tunnel"
        setup.description = "cloudflared on the server dials out to Cloudflare."
        setup.rows = [
            CloudflareCheckedRowView(label: "example.com", text: "Will go through the tunnel", ok: true, chip: nil),
            CloudflareCheckedRowView(
                label: "old.org", text: "Not in a connected Cloudflare account: stops answering", ok: false,
                chip: "Core domain"),
        ]
        setup.rowsTitle = "Names on this server"
        setup.rowsWarning =
            "I understand this name stops answering once the ports close. Add it to this Cloudflare account to keep it."
        setup.needsAck = true
        setup.routeSsh = true
        setup.sshName = "ssh-prod.example.com"
        setup.firewallTitle = "Then, 2 firewall commands"
        setup.commands = ["ufw deny 80/tcp", "ufw deny 443/tcp"]
        setup.steps = [
            CloudflareStepView(label: "Make the tunnel at Cloudflare and install cloudflared", state: .done, detail: nil),
            CloudflareStepView(label: "Wait for its first connection to Cloudflare", state: .running, detail: nil),
            CloudflareStepView(label: "Point the server's names at the tunnel", state: .waiting, detail: nil),
            CloudflareStepView(label: "Close ports 80 and 443 to everyone", state: .waiting, detail: nil),
        ]
        setup.applyLabel = "Set up tunnel"
        setup.saving = true
        try renderSnapshot(view(origin(.tunnel), dialog: setup), "cloudflare-tunnel-setup", tab: "cloudflare")
    }

    func testTunnelSsh() throws {
        var ssh = dialog(.ssh)
        ssh.title = "Who may open SSH"
        ssh.description = "This decides what happens to SSH."
        ssh.sshMode = "closed"
        ssh.sshModes = [
            CloudflareSshModeView(
                value: "open", title: "Open as the firewall has it", line: "SSH works the way it does today.",
                risk: "The one port bots can still find.", available: true, now: true),
            CloudflareSshModeView(
                value: "closed", title: "Closed to everyone", line: "No SSH at all.",
                risk: "Only your provider's console gets you in.", available: true, now: false),
        ]
        ssh.phrase = "close ssh on prod"
        ssh.firewallTitle = "1 firewall command"
        ssh.commands = ["ufw deny 22/tcp"]
        ssh.canApply = true
        ssh.danger = true
        try renderSnapshot(view(origin(.tunnel), dialog: ssh), "cloudflare-tunnel-ssh", tab: "cloudflare")
    }
}
