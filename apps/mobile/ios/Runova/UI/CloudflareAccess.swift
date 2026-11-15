import SwiftUI

/// Everything the Access tab shows, under the switches and the tab strip.
struct AccessTab: View {
    let access: CloudflareAccessView
    let intents: CloudflareIntents

    var body: some View {
        if access.loading {
            LoadingRows()
        } else if let problem = access.problem {
            ErrorText(message: problem)
        } else {
            GateCard(access: access, intents: intents)
            LimitsCard(access: access, intents: intents)
        }
    }
}

private struct GateCard: View {
    let access: CloudflareAccessView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "Email code")
            RunovaText(
                "Visitors type their email, Cloudflare mails them a code, and only the people you list get in.",
                style: RunovaType.small, color: palette.mutedForeground)
            if !access.ready { SetupCard(access: access, intents: intents) }
            VStack(spacing: 0) {
                ForEach(access.hosts, id: \.hostname) { HostRow(host: $0, ready: access.ready, intents: intents) }
            }
            .padding(.vertical, 4)
            .runovaGlass()
        }
    }
}

private struct SetupCard: View {
    let access: CloudflareAccessView
    let intents: CloudflareIntents

    @State private var team = ""
    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                RunovaText("Turn on email codes for this Cloudflare account", style: RunovaType.title)
                RunovaText(
                    "Codes come from Cloudflare Zero Trust, whose free plan covers small teams."
                        + (access.needsTeam ? " Pick a team name for the sign-in page people see." : ""),
                    style: RunovaType.small, color: palette.mutedForeground)
                if access.needsTeam {
                    RunovaTextField(
                        value: Binding(get: { team }, set: { team = $0.lowercased() }), placeholder: "acme",
                        label: "Team name")
                    if !team.trimmingCharacters(in: .whitespaces).isEmpty {
                        RunovaText(
                            "\(team.trimmingCharacters(in: .whitespaces)).cloudflareaccess.com", style: monoSmall,
                            color: palette.mutedForeground)
                    }
                }
                RunovaButton(
                    text: "Turn on email codes",
                    enabled: !access.needsTeam || !team.trimmingCharacters(in: .whitespaces).isEmpty,
                    icon: RunovaIcons.envelope
                ) { intents.gatePrepare(team) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct HostRow: View {
    let host: CloudflareGateHostView
    let ready: Bool
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let on = host.state == .on
        let letThrough = host.core && on && !host.thisComputerPass
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                RunovaIcon(
                    glyph: on ? RunovaIcons.lock : RunovaIcons.unlock, size: 14,
                    color: on ? palette.primary : palette.mutedForeground)
                VStack(alignment: .leading, spacing: 4) {
                    RunovaText(host.hostname, style: RunovaType.mono, maxLines: 1)
                    if let role = host.roleLabel { RunovaBadge(text: role, tone: .primary) }
                    RunovaText(host.summary, style: RunovaType.small, color: palette.mutedForeground)
                }
                Spacer(minLength: 0)
                if on {
                    Button {
                        intents.gateEdit(host.hostname)
                    } label: {
                        RunovaIcon(glyph: RunovaIcons.edit, size: 14, color: palette.mutedForeground)
                            .frame(width: 32, height: 32)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Edit email code for \(host.hostname)")
                }
                if host.state != .elsewhere {
                    RunovaToggle(isOn: on, label: "Email code for \(host.hostname)", enabled: ready && host.proxied) {
                        intents.gateSwitch(host.hostname, $0)
                    }
                }
            }
            if host.canProxy || letThrough {
                Wrap {
                    if host.canProxy {
                        RunovaChip(text: "Turn on proxy", icon: RunovaIcons.cloud, tone: .primary) {
                            intents.gateProxy(host.hostname)
                        }
                    }
                    if letThrough {
                        RunovaChip(text: "Let this computer through", icon: RunovaIcons.key, tone: .primary) {
                            intents.gateLetThrough(host.hostname)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct LimitsCard: View {
    let access: CloudflareAccessView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "Limit by IP address")
            RunovaText(
                "Only the addresses you list can open a name or a path. Everyone else gets Cloudflare's block page.",
                style: RunovaType.small, color: palette.mutedForeground)
            RunovaChip(text: "Add IP limit", icon: RunovaIcons.add, tone: .primary) { intents.openIpLimit(nil) }
            if let problem = access.limitsProblem {
                ErrorText(message: problem)
            } else if access.limits.isEmpty {
                RunovaText(
                    "No IP limits yet. Keep an admin page to your office, or a whole name to your VPN's address.",
                    style: RunovaType.small, color: palette.mutedForeground)
            } else {
                VStack(spacing: 0) {
                    ForEach(access.limits, id: \.id) { LimitRow(limit: $0, intents: intents) }
                }
                .padding(.vertical, 4)
                .runovaGlass()
            }
        }
    }
}

private struct LimitRow: View {
    let limit: CloudflareIpLimitView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                RunovaText(
                    limit.target, style: RunovaType.mono, color: limit.enabled ? palette.foreground : palette.mutedForeground,
                    maxLines: 2)
                Wrap {
                    ForEach(Array(limit.ips.prefix(3)), id: \.self) { AddressPill(address: $0) }
                    if limit.ips.count > 3 {
                        RunovaText("+\(limit.ips.count - 3) more", style: RunovaType.caption, color: palette.mutedForeground)
                    }
                }
            }
            Spacer(minLength: 0)
            IconButton(glyph: RunovaIcons.edit, label: "Edit IP limit for \(limit.target)") { intents.openIpLimit(limit.id) }
            RunovaToggle(isOn: limit.enabled, label: "IP limit for \(limit.target)") {
                intents.ipLimitSetEnabled(limit.id, $0)
            }
            IconButton(glyph: RunovaIcons.trash, label: "Delete IP limit for \(limit.target)") {
                intents.ipLimitDelete(limit.id)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct IconButton: View {
    let glyph: String
    let label: String
    let action: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            RunovaIcon(glyph: glyph, size: 14, color: palette.mutedForeground)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct AddressPill: View {
    let address: String
    var onRemove: (() -> Void)?

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 4) {
            RunovaText(
                address,
                style: RunovaTextStyle(
                    size: 11, lineHeight: 14, weight: 400, tracking: 0, fontName: "JetBrainsMono-Regular"),
                color: palette.primary)
            if let onRemove {
                Button(action: onRemove) {
                    RunovaIcon(glyph: RunovaIcons.close, size: 10, color: palette.primary)
                        .frame(width: 20, height: 20)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(address)")
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, onRemove == nil ? 10 : 4)
        .padding(.vertical, 4)
        .background(Capsule().fill(palette.primary.opacity(0.12)))
    }
}

/// A field that turns typed or pasted text into chips once a separator ends an entry.
private struct EntryField: View {
    let placeholder: String
    let label: String
    let onEntries: (String) -> Void

    @State private var draft = ""

    var body: some View {
        HStack(spacing: 8) {
            RunovaTextField(
                value: Binding(
                    get: { draft },
                    set: { text in
                        if let last = text.last, last == "," || last == ";" || last.isWhitespace {
                            onEntries(text)
                            draft = ""
                        } else {
                            draft = text
                        }
                    }),
                placeholder: placeholder, label: label)
            RunovaChip(text: "Add", icon: RunovaIcons.add) {
                if !draft.trimmingCharacters(in: .whitespaces).isEmpty { onEntries(draft) }
                draft = ""
            }
        }
    }
}

private struct Problems: View {
    let lines: [String]

    @Environment(\.palette) private var palette

    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(lines, id: \.self) { RunovaText($0, style: RunovaType.small, color: palette.destructive) }
            }
        }
    }
}

private struct SayBack: View {
    let text: String
    let tone: Color
    let icon: String

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RunovaIcon(glyph: icon, size: 14, color: tone)
            RunovaText(text, style: RunovaType.small, color: palette.foreground)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(tone.opacity(0.10)))
    }
}

private let visitorSteps: [(String, String)] = [
    (RunovaIcons.lock, "They open the name"),
    (RunovaIcons.envelope, "Cloudflare mails a code"),
    (RunovaIcons.key, "The code lets them in"),
]

struct EmailGateScreen: View {
    let form: CloudflareEmailGateFormView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        FormScreen(
            title: form.existing ? "Email code for \(form.hostname)" : "Ask for an email code",
            subtitle: form.existing ? "Change who can get a code and how long they stay in." : form.hostname,
            onBack: intents.gateClose
        ) {
            if !form.existing {
                HStack(spacing: 8) {
                    ForEach(Array(visitorSteps.enumerated()), id: \.offset) { _, step in
                        VStack(spacing: 6) {
                            RunovaIcon(glyph: step.0, size: 14, color: palette.primary)
                            RunovaText(step.1, style: RunovaType.caption, alignment: .center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 14).fill(palette.foreground.opacity(0.04)))
                    }
                }
            }
            Field(
                label: "Who can get a code",
                hint: (form.fromLast ? "Filled in from the last list you used. " : "")
                    + "Add each one with Add or a comma. A domain like @company.com lets in everyone there."
            ) {
                VStack(alignment: .leading, spacing: 8) {
                    if !form.people.isEmpty {
                        Wrap {
                            ForEach(form.people, id: \.value) { person in
                                AddressPill(address: person.domain ? "@\(person.value)" : person.value) {
                                    intents.gateRemovePerson(person.value, person.domain)
                                }
                            }
                        }
                    }
                    EntryField(
                        placeholder: "ana@company.com, or @company.com", label: "Who can get a code",
                        onEntries: intents.gateAddPeople)
                    Problems(lines: form.invalid)
                }
            }
            Field(label: "Stay in for") {
                ChoiceChips(options: form.sessions.map { ($0.value, $0.label) }, selected: form.session) {
                    intents.gateSetSession($0)
                }
            }
            SayBack(
                text: form.preview, tone: form.people.isEmpty ? palette.mutedForeground : palette.primary,
                icon: RunovaIcons.lock)
            if let note = form.coreNote {
                SayBack(text: note, tone: palette.mutedForeground, icon: RunovaIcons.systems)
            }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(
                text: form.saving ? "Saving" : (form.existing ? "Save" : "Turn on email code"),
                enabled: !form.people.isEmpty && !form.saving, icon: RunovaIcons.lock, action: intents.gateSave
            )
            .frame(maxWidth: .infinity)
            if form.existing {
                RunovaButton(text: "Turn off", kind: .danger, icon: RunovaIcons.unlock) {
                    intents.gateTurnOff(form.hostname)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

struct IpLimitScreen: View {
    let form: CloudflareIpLimitFormView
    let intents: CloudflareIntents

    @State private var path: String
    @Environment(\.palette) private var palette

    init(form: CloudflareIpLimitFormView, intents: CloudflareIntents) {
        self.form = form
        self.intents = intents
        _path = State(initialValue: form.path)
    }

    var body: some View {
        FormScreen(
            title: form.ruleId != nil ? "Change the IP limit" : "Limit by IP address",
            subtitle: "Everyone not listed gets Cloudflare's block page.", onBack: intents.closeIpLimit
        ) {
            Field(label: "Name", hint: "Only names behind Cloudflare's proxy are listed. The others go straight to your server.") {
                ChoiceChips(options: form.names.map { ($0.value, $0.label) }, selected: form.hostname) {
                    intents.ipLimitSetName($0)
                }
            }
            Field(label: "Covers", hint: form.wholeSite ? "Let's Encrypt's certificate checks still get through." : nil) {
                ChoiceChips(options: [(true, "Every page"), (false, "One path")], selected: form.wholeSite) {
                    intents.ipLimitSetScope($0)
                }
            }
            if !form.wholeSite {
                Field(label: "Path") {
                    RunovaTextField(
                        value: Binding(get: { path }, set: { path = $0; intents.ipLimitSetPath($0) }),
                        placeholder: "/admin", label: "Path")
                }
                if let problem = form.pathProblem { ErrorText(message: problem) }
                Field(label: "Match") {
                    ChoiceChips(options: [(true, "Path and below"), (false, "Only this path")], selected: form.prefix) {
                        intents.ipLimitSetPrefix($0)
                    }
                }
            }
            Field(label: "Addresses that get in", hint: "A range like 198.51.100.0/24 covers a whole office or VPN.") {
                VStack(alignment: .leading, spacing: 8) {
                    if !form.ips.isEmpty {
                        Wrap {
                            ForEach(form.ips, id: \.self) { ip in
                                AddressPill(address: ip) { intents.ipLimitRemoveAddress(ip) }
                            }
                        }
                    }
                    EntryField(
                        placeholder: "203.0.113.10 or 198.51.100.0/24", label: "Addresses that get in",
                        onEntries: intents.ipLimitAddAddresses)
                    Problems(lines: form.invalid)
                    if form.canAddThisComputer, let ip = form.thisComputer {
                        RunovaChip(text: "This computer, \(ip)", icon: RunovaIcons.add, action: intents.ipLimitAddThisComputer)
                            .accessibilityLabel("Add this computer, \(ip)")
                    }
                }
            }
            SayBack(
                text: form.preview, tone: form.canSave ? palette.primary : palette.mutedForeground,
                icon: RunovaIcons.shield)
            if form.shutOut, let ip = form.thisComputer {
                SayBack(
                    text: "This computer (\(ip)) is not on the list, so it gets the block page too.",
                    tone: palette.warning, icon: RunovaIcons.warning)
            }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(
                text: form.saving ? "Saving" : (form.ruleId != nil ? "Save" : "Add limit"), enabled: form.canSave,
                icon: RunovaIcons.shield, action: intents.ipLimitSave
            )
            .frame(maxWidth: .infinity)
        }
    }
}
