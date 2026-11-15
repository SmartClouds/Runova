import SwiftUI

/// A server's Cloudflare-only origin: the Cloudflare Tunnel or the IP lock, as on Android.
private let breakGlassMinutes: [UInt32] = [15, 30, 60, 120, 240]

private func minutesLabel(_ minutes: UInt32) -> String { minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h" }

private extension CloudflareTone {
    func color(_ palette: RunovaPalette) -> Color {
        switch self {
        case .good: return palette.primary
        case .warning: return palette.warning
        case .bad: return palette.destructive
        }
    }
}

/// The saved servers on the Cloudflare home, each opening its Cloudflare-only origin.
struct ServersCard: View {
    let servers: [CloudflareChoiceView]
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "Your servers")
            RunovaText(
                "How Cloudflare reaches each one: through a tunnel, or from Cloudflare's addresses only.",
                style: RunovaType.small, color: palette.mutedForeground)
            VStack(spacing: 0) {
                ForEach(servers, id: \.id) { server in
                    RunovaListRow(title: server.name, detail: "Cloudflare-only origin", icon: RunovaIcons.server, flat: true) {
                        intents.openOrigin(server.id)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .runovaGlass()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct OriginScreen: View {
    let origin: CloudflareOriginView
    let error: String?
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: "Cloudflare-only origin", subtitle: origin.serverName, onBack: intents.closeOrigin) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    RunovaText(
                        "Stops visitors from going around Cloudflare to the server's own address.",
                        style: RunovaType.small, color: palette.mutedForeground)
                    if origin.loading {
                        LoadingRows()
                    } else if let problem = origin.problem {
                        ErrorText(message: problem)
                    } else {
                        if let pending = origin.pending { OriginPendingCard(pending: pending, intents: intents) }
                        ModeCard(origin: origin, intents: intents)
                        if origin.mode == .tunnel {
                            if let tunnel = origin.tunnel {
                                TunnelCard(tunnel: tunnel, origin: origin, intents: intents)
                            } else if let problem = origin.tunnelProblem {
                                ErrorText(message: problem)
                            }
                        } else {
                            if let lock = origin.lock {
                                LockCard(lock: lock, origin: origin, intents: intents)
                            } else if let problem = origin.lockProblem {
                                ErrorText(message: problem)
                            }
                        }
                    }
                }
                .padding(16)
            }
            if let error { ErrorText(message: error).padding(16) }
        }
    }
}

private struct OriginPendingCard: View {
    let pending: CloudflarePendingChangeView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                RunovaIcon(glyph: RunovaIcons.clock, size: 14, color: palette.warning)
                RunovaText("A firewall change waits for you", style: RunovaType.title)
            }
            RunovaText(pending.summary, style: RunovaType.small)
            RunovaText(pending.deadlineLabel, style: RunovaType.small, color: palette.warning)
            Commands(commands: pending.commands)
            Wrap {
                RunovaButton(text: "Keep it", icon: RunovaIcons.check, action: intents.firewallKeep)
                RunovaButton(text: "Revert", kind: .danger, icon: RunovaIcons.undo, action: intents.firewallRevert)
            }
            RunovaText(
                "Keeping it checks that the computer still gets in over a new connection.",
                style: RunovaType.caption, color: palette.mutedForeground)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(palette.warning.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.warning.opacity(0.35), lineWidth: 1))
    }
}

private struct ModeCard: View {
    let origin: CloudflareOriginView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            RunovaText("How Cloudflare reaches this server", style: RunovaType.label)
            ChoiceChips(
                options: [(CloudflareOriginMode.tunnel, "Cloudflare Tunnel"), (.ips, "Cloudflare IPs only")],
                selected: origin.mode, enabled: !origin.modeLocked, onSelect: intents.originMode)
            RunovaText(
                origin.mode == .tunnel
                    ? "No open web ports: the server dials out to Cloudflare."
                    : "Ports 80 and 443 answer Cloudflare's addresses only.",
                style: RunovaType.small, color: palette.mutedForeground)
            if let note = origin.modeNote {
                RunovaText(note, style: RunovaType.small, color: palette.mutedForeground)
            }
        }
    }
}

private struct StateLine: View {
    let label: String
    let tone: CloudflareTone
    var working = false

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(tone.color(palette)).frame(width: 8, height: 8)
            RunovaText(label, style: RunovaType.labelStrong)
            Spacer(minLength: 0)
            if working { RunovaBadge(text: "Working", tone: .warning) }
        }
    }
}

private struct Lines: View {
    let lines: [String]
    let color: Color

    var body: some View {
        ForEach(lines, id: \.self) { RunovaText($0, style: RunovaType.small, color: color) }
    }
}

private struct LockCard: View {
    let lock: CloudflareOriginLockView
    let origin: CloudflareOriginView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 8) {
                StateLine(label: lock.stateLabel, tone: lock.tone)
                Lines(lines: lock.details, color: palette.mutedForeground)
                Lines(lines: lock.drift, color: palette.destructive)
                Lines(lines: lock.warnings, color: palette.warning)
                if origin.canAdmin && origin.pending == nil {
                    Wrap {
                        if let label = lock.enableLabel {
                            RunovaButton(text: label, icon: RunovaIcons.shield) { intents.lockOpen(true) }
                        }
                        if lock.enabled {
                            RunovaButton(text: "Turn off", kind: .danger) { intents.lockOpen(false) }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TunnelCard: View {
    let tunnel: CloudflareTunnelView
    let origin: CloudflareOriginView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                StateLine(label: tunnel.stateLabel, tone: tunnel.tone, working: tunnel.working)
                if let intro = tunnel.intro {
                    RunovaText(intro, style: RunovaType.small, color: palette.mutedForeground)
                }
                ForEach(tunnel.facts, id: \.label) { fact in
                    HStack(spacing: 8) {
                        RunovaText(fact.label, style: RunovaType.small, color: palette.mutedForeground)
                        Spacer(minLength: 0)
                        RunovaText(fact.value, style: RunovaType.small)
                    }
                }
                Lines(lines: tunnel.drift, color: palette.destructive)
                if let error = tunnel.lastError { ErrorText(message: error) }
                Lines(lines: tunnel.warnings, color: palette.warning)
                if let hint = tunnel.hint {
                    RunovaText(hint, style: RunovaType.small, color: palette.mutedForeground)
                }
                if tunnel.enabled && !tunnel.facts.isEmpty {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 0) {
                            RunovaText("Reopen SSH if the tunnel stays down", style: RunovaType.label)
                            RunovaText(tunnel.breakGlassText, style: RunovaType.small, color: palette.mutedForeground)
                        }
                        Spacer(minLength: 0)
                        RunovaToggle(
                            isOn: tunnel.breakGlass, label: "Reopen SSH if the tunnel stays down", enabled: origin.canOwn
                        ) { intents.tunnelBreakGlass($0, tunnel.breakGlassMinutes) }
                    }
                    if tunnel.breakGlass {
                        ChoiceChips(
                            options: breakGlassMinutes.map { ($0, minutesLabel($0)) }, selected: tunnel.breakGlassMinutes,
                            enabled: origin.canOwn
                        ) { intents.tunnelBreakGlass(true, $0) }
                    }
                }
                if origin.canAdmin {
                    Wrap {
                        if let label = tunnel.setUpLabel {
                            RunovaButton(text: label, icon: RunovaIcons.cloud, action: intents.tunnelSetupOpen)
                        }
                        if tunnel.canClosePorts {
                            RunovaButton(text: "Close ports 80 and 443", icon: RunovaIcons.lock, action: intents.tunnelPortsOpen)
                        }
                        if tunnel.canChangeSsh {
                            RunovaButton(text: "Change SSH access", kind: .soft, icon: RunovaIcons.key, action: intents.tunnelSshOpen)
                        }
                        if tunnel.canTurnOff {
                            RunovaButton(text: "Turn off", kind: .danger, action: intents.tunnelOffOpen)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct Commands: View {
    let commands: [String]

    @Environment(\.palette) private var palette

    var body: some View {
        if !commands.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(commands.enumerated()), id: \.offset) { _, command in
                    RunovaText(command, style: monoSmall)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(palette.foreground.opacity(0.05)))
        }
    }
}

struct OriginDialogScreen: View {
    let dialog: CloudflareOriginDialogView
    let intents: CloudflareIntents

    @State private var phrase = ""
    @State private var password = ""
    @State private var sshName: String

    @Environment(\.palette) private var palette

    init(dialog: CloudflareOriginDialogView, intents: CloudflareIntents) {
        self.dialog = dialog
        self.intents = intents
        _sshName = State(initialValue: dialog.sshName)
    }

    var body: some View {
        let d = dialog
        FormScreen(title: d.title, subtitle: nil, onBack: intents.closeOriginDialog) {
            RunovaText(d.description, style: RunovaType.small, color: palette.mutedForeground)
            if d.loading && d.steps.isEmpty { LoadingRows() }
            if let blocked = d.blocked { ErrorText(message: blocked) }
            kindFields
            rows
            if d.kind == .setup && !d.loading { sshField }
            if let title = d.firewallTitle { RunovaText(title, style: RunovaType.label) }
            Commands(commands: d.commands)
            ForEach(d.notes, id: \.self) { RunovaText($0, style: RunovaType.small, color: palette.mutedForeground) }
            if !d.steps.isEmpty { steps }
            if let expected = d.phrase { phraseFields(expected) }
            if let problem = d.problem { ErrorText(message: problem) }
            RunovaButton(
                text: d.saving ? "Working" : d.applyLabel, kind: d.danger ? .danger : .primary,
                enabled: d.canApply && !d.saving
                    && (d.phrase == nil || (!phrase.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty)),
                icon: RunovaIcons.check
            ) {
                if d.kind == .ssh { intents.tunnelSshApply(phrase, password) } else { intents.originApply() }
            }
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var kindFields: some View {
        let d = dialog
        switch d.kind {
        case .lockOn:
            SwitchRow(
                title: "Authenticated Origin Pulls",
                detail: "Also require Cloudflare's client certificate on HTTPS. It is turned on for the zones of this server's sites first.",
                icon: RunovaIcons.shield, isOn: d.aop, enabled: !d.loading, onChange: intents.lockSetAop)
        case .setup:
            if !d.loading && d.accounts.count > 1 {
                Field(label: "Cloudflare account") {
                    ChoiceChips(options: d.accounts.map { ($0.id, $0.name) }, selected: d.account, onSelect: intents.tunnelSetupAccount)
                }
            }
        case .off:
            Field(
                label: "Ports 80 and 443 afterwards",
                hint: d.reopenWeb
                    ? "Anyone can reach the sites at the server address again."
                    : "Turn the IP lock on next, or the sites stop answering until you do."
            ) {
                ChoiceChips(
                    options: [(true, "Open to everyone"), (false, "Keep closed for the IP lock")], selected: d.reopenWeb,
                    onSelect: intents.tunnelOffReopen)
            }
            SwitchRow(
                title: "Point the names back at the server", detail: "Proxied through Cloudflare, once the tunnel is gone.",
                icon: RunovaIcons.globe, isOn: d.pointBack, enabled: true, onChange: intents.tunnelOffPointBack)
        case .ssh:
            ForEach(d.sshModes, id: \.value) { mode in
                SshModeRow(mode: mode, chosen: mode.value == d.sshMode) { intents.tunnelSshMode(mode.value) }
            }
            if d.sshMode == "mesh" {
                if let address = d.meshAddress { RunovaText("Mesh address: \(address)", style: RunovaType.mono) }
                if d.canJoinMesh {
                    RunovaButton(
                        text: "Add to Mesh", kind: .soft, enabled: !d.saving, icon: RunovaIcons.network,
                        action: intents.tunnelJoinMesh)
                }
            }
            if let label = d.testLabel {
                RunovaButton(text: label, kind: .soft, enabled: d.canTest, icon: RunovaIcons.play, action: intents.tunnelSshTest)
                    .frame(maxWidth: .infinity)
            }
            if let probe = d.probe {
                RunovaText(probe, style: RunovaType.small, color: d.probeOk ? palette.primary : palette.warning)
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var rows: some View {
        let d = dialog
        if !d.rows.isEmpty {
            if let title = d.rowsTitle { RunovaText(title, style: RunovaType.label) }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(d.rows, id: \.label) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            RunovaText(row.label, style: RunovaType.mono, maxLines: 1)
                            if let chip = row.chip { RunovaBadge(text: chip, tone: .primary) }
                        }
                        RunovaText(row.text, style: RunovaType.small, color: row.ok ? palette.mutedForeground : palette.warning)
                    }
                    .padding(.vertical, 6)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .runovaGlass()
        }
        if let warning = d.rowsWarning {
            if d.kind == .setup {
                SwitchRow(
                    title: "Go ahead without them", detail: warning, icon: RunovaIcons.warning, isOn: d.acked, enabled: true,
                    onChange: intents.tunnelSetupAck)
            } else {
                RunovaText(warning, style: RunovaType.small, color: palette.warning)
            }
        }
    }

    @ViewBuilder private var sshField: some View {
        let d = dialog
        SwitchRow(
            title: "Give SSH a name on the tunnel, behind Cloudflare Access",
            detail: "Needed to close SSH's own port later and still get in from the app. Nothing about SSH changes now.",
            icon: RunovaIcons.key, isOn: d.routeSsh, enabled: true
        ) { intents.tunnelSetupSsh($0, sshName) }
        if d.routeSsh {
            Field(label: "SSH name") {
                RunovaTextField(value: $sshName, placeholder: "ssh.example.com", label: "SSH name")
                    .onChange(of: sshName) { intents.tunnelSetupSsh(true, $0) }
            }
            if let problem = d.sshNameProblem { ErrorText(message: problem) }
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(dialog.steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 10) {
                    RunovaIcon(glyph: stepIcon(step.state), size: 14, color: stepColor(step.state))
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText("\(index + 1). \(step.label)", style: RunovaType.small)
                        if let detail = step.detail {
                            RunovaText(detail, style: RunovaType.caption, color: palette.mutedForeground)
                        }
                    }
                }
            }
        }
    }

    private func stepIcon(_ state: CloudflareStepState) -> String {
        switch state {
        case .done: return RunovaIcons.success
        case .failed: return RunovaIcons.error
        case .running: return RunovaIcons.clock
        case .waiting: return RunovaIcons.minus
        }
    }

    private func stepColor(_ state: CloudflareStepState) -> Color {
        switch state {
        case .done: return palette.primary
        case .failed: return palette.destructive
        case .running: return palette.warning
        case .waiting: return palette.mutedForeground
        }
    }

    @ViewBuilder private func phraseFields(_ expected: String) -> some View {
        RunovaText(
            "No SSH connection will reach this server. Type the phrase to go ahead.", style: RunovaType.small,
            color: palette.destructive)
        Field(label: "Type \(expected)") {
            RunovaTextField(value: $phrase, placeholder: expected, label: "Confirmation phrase")
        }
        Field(label: "Your password on the server core") {
            RunovaTextField(
                value: $password, placeholder: "Password", secure: true, icon: RunovaIcons.key,
                label: "Password on the server core")
        }
    }
}

private struct SshModeRow: View {
    let mode: CloudflareSshModeView
    let chosen: Bool
    let onTap: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    RunovaText(
                        mode.title, style: RunovaType.label,
                        color: mode.available ? palette.foreground : palette.mutedForeground)
                    Spacer(minLength: 0)
                    if mode.now { RunovaBadge(text: "Now", tone: .neutral) }
                }
                RunovaText(mode.line, style: RunovaType.small, color: palette.mutedForeground)
                RunovaText(
                    mode.risk, style: RunovaType.caption, color: mode.available ? palette.warning : palette.mutedForeground)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(chosen ? palette.primary.opacity(0.10) : palette.foreground.opacity(0.04)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!mode.available)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
