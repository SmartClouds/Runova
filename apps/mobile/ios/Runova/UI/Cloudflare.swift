import SwiftUI

/// Cloudflare's own page for API tokens, where the user makes one for Runova.
private let tokenPage = URL(string: "https://dash.cloudflare.com/profile/api-tokens")!

private let recordTypes = ["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "SRV"]
private let proxiableTypes: Set<String> = ["A", "AAAA", "CNAME"]
private let caaTags: [(String, String)] = [("issue", "Issue"), ("issuewild", "Issue wildcard"), ("iodef", "Report to")]

/// The TTLs the desktop's editor offers, in seconds. 1 is Cloudflare's "Auto".
private let ttls: [(UInt32, String)] = [
    (1, "Auto"), (60, "1 min"), (300, "5 min"), (1800, "30 min"),
    (3600, "1 hr"), (18000, "5 hr"), (43200, "12 hr"), (86400, "1 day"),
]

struct CloudflareIntents {
    var openZone: (String) -> Void = { _ in }
    var closeZone: () -> Void = {}
    var setDevMode: (Bool) -> Void = { _ in }
    var setUnderAttack: (Bool) -> Void = { _ in }
    var setAiBotsBlocked: (Bool) -> Void = { _ in }
    var newRecord: () -> Void = {}
    var editRecord: (String) -> Void = { _ in }
    var closeRecordForm: () -> Void = {}
    var saveRecord: (RecordDraft) -> Void = { _ in }
    var setProxied: (String, Bool) -> Void = { _, _ in }
    var deleteRecord: (String) -> Void = { _ in }
    var openTokenForm: (String?) -> Void = { _ in }
    var closeTokenForm: () -> Void = {}
    var saveToken: (String, String) -> Void = { _, _ in }
    var checkToken: (String) -> Void = { _ in }
    var removeToken: (String) -> Void = { _ in }
    var openAddDomain: (String) -> Void = { _ in }
    var closeAddDomain: () -> Void = {}
    var addDomain: (String, String) -> Void = { _, _ in }
    var checkActivation: () -> Void = {}
    var openPointDomain: () -> Void = {}
    var closePointDomain: () -> Void = {}
    var previewPointDomain: (String, String, Bool, Bool) -> Void = { _, _, _, _ in }
    var applyPointDomain: () -> Void = {}
    var openTab: (CloudflareTab) -> Void = { _ in }
    var changeSetting: (String, String) -> Void = { _, _ in }
    var setRuleEnabled: (String, Bool) -> Void = { _, _ in }
    var deleteRule: (String) -> Void = { _ in }
    var openRuleBuilder: () -> Void = {}
    var closeRuleBuilder: () -> Void = {}
    var addRule: (String, String, String, Bool, String) -> Void = { _, _, _, _, _ in }
    var openAccessRuleForm: () -> Void = {}
    var closeAccessRuleForm: () -> Void = {}
    var addAccessRule: (String, String, String) -> Void = { _, _, _ in }
    var deleteAccessRule: (String) -> Void = { _ in }
    var purgeEverything: () -> Void = {}
    var purgeUrls: (String) -> Void = { _ in }
}

extension CloudflareTone {
    var badge: BadgeTone {
        switch self {
        case .good: return .success
        case .warning: return .warning
        case .bad: return .danger
        }
    }
}

/// Lays chips out in rows, wrapping onto the next line rather than running off the edge.
struct Wrap: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// A form, a domain or the token page takes over the whole device screen.
struct CloudflareOverlay: View {
    let view: AppView
    let intents: CloudflareIntents

    static func shows(_ view: AppView) -> Bool {
        let screen = view.cloudflare
        return screen.tokenForm != nil || screen.addDomain != nil || screen.zone != nil
    }

    var body: some View {
        let screen = view.cloudflare
        if let form = screen.tokenForm {
            TokenScreen(form: form, error: view.error, intents: intents)
        } else if let form = screen.addDomain {
            AddDomainScreen(form: form, intents: intents)
        } else if let zone = screen.zone {
            if let form = screen.recordForm {
                RecordScreen(form: form, intents: intents)
            } else if let point = screen.pointDomain {
                PointDomainScreen(form: point, intents: intents)
            } else if let builder = screen.ruleBuilder {
                RuleBuilderScreen(form: builder, intents: intents)
            } else if let access = screen.accessRuleForm {
                AccessRuleScreen(form: access, intents: intents)
            } else {
                ZoneScreen(zone: zone, error: view.error, intents: intents)
            }
        }
    }
}

struct CloudflareTab: View {
    let view: AppView
    let intents: CloudflareIntents

    var body: some View {
        let screen = view.cloudflare
        if let problem = screen.problem {
            RunovaEmptyState(icon: RunovaIcons.warning, title: "Can't open Cloudflare", detail: problem, tone: .warning)
        } else if screen.loading && screen.accounts.isEmpty {
            LoadingRows()
        } else if !screen.configured {
            VStack(spacing: 0) {
                RunovaEmptyState(
                    icon: RunovaIcons.cloud, title: "Connect Cloudflare",
                    detail: "Manage domains, DNS and security from here. The token is saved on the computer, not on this phone.")
                RunovaButton(text: "Connect an account", icon: RunovaIcons.add) { intents.openTokenForm(nil) }
            }
            .padding(24)
            .frame(maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(spacing: 12) {
                    ForEach(screen.accounts, id: \.id) { AccountCard(account: $0, intents: intents) }
                    RunovaButton(text: "Connect another account", kind: .soft, icon: RunovaIcons.add) {
                        intents.openTokenForm(nil)
                    }
                    .frame(maxWidth: .infinity)
                }
                .padding(16)
            }
        }
    }
}

private struct AccountCard: View {
    let account: CloudflareAccountView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    RunovaIconTile(icon: RunovaIcons.cloud, tone: account.tone.badge)
                    RunovaText(account.label, style: RunovaType.title, maxLines: 1)
                    Spacer(minLength: 0)
                    RunovaBadge(text: account.statusLabel, tone: account.tone.badge, dot: true)
                }
                if let detail = account.detail {
                    RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground)
                }
                ForEach(account.missing, id: \.self) { permission in
                    HStack(spacing: 8) {
                        RunovaIcon(glyph: RunovaIcons.key, size: 12, color: palette.warning)
                        RunovaText(permission, style: monoSmall)
                    }
                }
                Wrap {
                    if !account.locked {
                        RunovaChip(text: "Check token", icon: RunovaIcons.refresh) { intents.checkToken(account.id) }
                    }
                    RunovaChip(text: "Replace token", icon: RunovaIcons.key) { intents.openTokenForm(account.id) }
                    RunovaChip(text: "Remove", icon: RunovaIcons.trash, tone: .danger) { intents.removeToken(account.id) }
                }
            }
            .padding(16)
            if account.zonesLoading {
                RunovaSkeleton(width: 300).padding(16)
            } else if let problem = account.zonesProblem {
                RunovaText(problem, style: RunovaType.small, color: palette.destructive)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach(account.zones, id: \.id) { zone in
                        RunovaListRow(
                            title: zone.name, detail: "\(zone.statusLabel) · \(zone.plan)", icon: RunovaIcons.globe,
                            iconTone: zone.active ? .primary : .warning, flat: true
                        ) { intents.openZone(zone.id) }
                    }
                }
                .padding(.horizontal, 8)
            }
            if !account.locked {
                RunovaChip(text: "Add a domain", icon: RunovaIcons.add, tone: .primary) { intents.openAddDomain(account.id) }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 14)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .runovaGlass()
    }
}

/// The mono style at the small size, for addresses and permission names.
let monoSmall = RunovaTextStyle(
    size: 12, lineHeight: 16, weight: 400, tracking: 0, fontName: "JetBrainsMono-Regular")

private struct ZoneScreen: View {
    let zone: CloudflareZoneView
    let error: String?
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: zone.name, subtitle: "\(zone.statusLabel) · \(zone.plan)", onBack: intents.closeZone) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if zone.pending { PendingCard(zone: zone, intents: intents) }
                    if let toggles = zone.toggles { TogglesCard(toggles: toggles, intents: intents) }
                    ZoneTabs(selected: zone.tab, onSelect: intents.openTab)
                    if zone.tab != .dns {
                        ZoneTabContent(zone: zone, intents: intents)
                    } else {
                        dns
                    }
                }
                .padding(16)
            }
            if let error { RunovaText(error, style: RunovaType.small, color: palette.destructive).padding(16) }
        }
    }

    @ViewBuilder private var dns: some View {
        RunovaSectionTitle(text: "DNS records")
        Wrap {
            RunovaChip(text: "Add record", icon: RunovaIcons.add, tone: .primary, action: intents.newRecord)
            RunovaChip(text: "Point to a server", icon: RunovaIcons.server, action: intents.openPointDomain)
        }
        if zone.dns.loading {
            LoadingRows()
        } else if let problem = zone.dns.problem {
            RunovaText(problem, style: RunovaType.small, color: palette.destructive)
        } else if zone.dns.records.isEmpty {
            RunovaText("No records yet.", style: RunovaType.small, color: palette.mutedForeground)
        } else {
            VStack(spacing: 0) {
                ForEach(zone.dns.records, id: \.id) { RecordRow(record: $0, intents: intents) }
            }
            .padding(.vertical, 4)
            .runovaGlass()
        }
    }
}

private struct PendingCard: View {
    let zone: CloudflareZoneView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    RunovaIcon(glyph: RunovaIcons.clock, color: palette.warning)
                    RunovaText("Waiting for name servers", style: RunovaType.title)
                }
                RunovaText(
                    "At your registrar, replace the name servers with these. It can take a few hours to switch over.",
                    style: RunovaType.small, color: palette.mutedForeground)
                ForEach(zone.nameServers, id: \.self) { RunovaText($0, style: RunovaType.mono) }
                RunovaButton(text: "Check again", kind: .soft, icon: RunovaIcons.refresh, action: intents.checkActivation)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TogglesCard: View {
    let toggles: CloudflareTogglesView
    let intents: CloudflareIntents

    var body: some View {
        VStack(spacing: 0) {
            SwitchRow(
                title: "Development mode", detail: toggles.devModeDetail, icon: RunovaIcons.bolt, isOn: toggles.devMode,
                enabled: toggles.devModeEditable && !toggles.saving, onChange: intents.setDevMode)
            SwitchRow(
                title: "I'm Under Attack", detail: toggles.underAttack ? "On, visitors are checked" : "Off",
                icon: RunovaIcons.shield, isOn: toggles.underAttack,
                enabled: toggles.underAttackEditable && !toggles.saving, onChange: intents.setUnderAttack)
            if toggles.aiBotsAvailable {
                SwitchRow(
                    title: "Block AI bots", detail: toggles.aiBotsDetail, icon: RunovaIcons.ban,
                    isOn: toggles.aiBotsBlocked, enabled: !toggles.saving, onChange: intents.setAiBotsBlocked)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .runovaGlass()
    }
}

struct SwitchRow: View {
    let title: String
    let detail: String
    let icon: String
    let isOn: Bool
    let enabled: Bool
    let onChange: (Bool) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            RunovaIcon(glyph: icon, color: isOn ? palette.primary : palette.mutedForeground)
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(title, style: RunovaType.label)
                RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground)
            }
            Spacer(minLength: 0)
            RunovaToggle(isOn: isOn, label: title, enabled: enabled, onChange: onChange)
        }
        .padding(.vertical, 10)
    }
}

private struct RecordRow: View {
    let record: CloudflareRecordView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            Button {
                intents.editRecord(record.id)
            } label: {
                HStack(spacing: 10) {
                    RunovaText(record.recordType, style: RunovaType.caption, color: palette.mutedForeground)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 6).fill(palette.foreground.opacity(0.06)))
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(record.name, style: RunovaType.labelStrong, maxLines: 1)
                        RunovaText(
                            (record.priority.map { "\($0)  " } ?? "") + record.content, style: monoSmall,
                            color: palette.mutedForeground, maxLines: 1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!record.editable)
            if record.proxiable {
                ProxyPill(record: record, intents: intents)
            } else {
                RunovaText(record.ttlLabel, style: RunovaType.caption, color: palette.mutedForeground)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

/// Cloudflare's orange cloud: through the proxy, or straight to the server.
private struct ProxyPill: View {
    let record: CloudflareRecordView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = record.proxied ? palette.warning : palette.mutedForeground
        Button {
            intents.setProxied(record.id, !record.proxied)
        } label: {
            HStack(spacing: 5) {
                RunovaIcon(glyph: RunovaIcons.cloud, size: 12, color: ink)
                RunovaText(record.proxied ? "Proxied" : "DNS only", style: RunovaType.caption, color: ink)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(record.proxied ? palette.warning.opacity(0.14) : palette.foreground.opacity(0.06)))
        }
        .buttonStyle(.plain)
        .disabled(!record.editable)
        .accessibilityLabel("Proxy for \(record.name) \(record.recordType)")
    }
}

struct FormScreen<Content: View>: View {
    let title: String
    let subtitle: String?
    let onBack: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        RunovaScreen(title: title, subtitle: subtitle, onBack: onBack) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) { content() }.padding(16)
            }
        }
    }
}

struct Field<Content: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder let content: () -> Content

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaText(label, style: RunovaType.label)
            content()
            if let hint { RunovaText(hint, style: RunovaType.small, color: palette.mutedForeground) }
        }
    }
}

struct ChoiceChips<Value: Hashable>: View {
    let options: [(Value, String)]
    let selected: Value
    let onSelect: (Value) -> Void

    var body: some View {
        Wrap {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let chosen = option.0 == selected
                RunovaChip(text: option.1, icon: chosen ? RunovaIcons.check : nil, tone: chosen ? .primary : .soft) {
                    onSelect(option.0)
                }
                .accessibilityLabel(chosen ? "\(option.1), chosen" : option.1)
            }
        }
    }
}

struct ErrorText: View {
    let message: String

    @Environment(\.palette) private var palette

    var body: some View { RunovaText(message, style: RunovaType.small, color: palette.destructive) }
}

private func digits(_ text: String, max: Int = 5) -> String { String(text.filter(\.isNumber).prefix(max)) }

private struct RecordScreen: View {
    let form: CloudflareRecordFormView
    let intents: CloudflareIntents

    @State private var type: String
    @State private var name: String
    @State private var content: String
    @State private var ttl: UInt32
    @State private var proxied: Bool
    @State private var priority: String
    @State private var comment: String
    @State private var caaFlags: String
    @State private var caaTag: String
    @State private var caaValue: String
    @State private var srvPriority: String
    @State private var srvWeight: String
    @State private var srvPort: String
    @State private var srvTarget: String

    @Environment(\.palette) private var palette

    init(form: CloudflareRecordFormView, intents: CloudflareIntents) {
        self.form = form
        self.intents = intents
        let start = form.draft
        _type = State(initialValue: start.recordType)
        _name = State(initialValue: start.name)
        _content = State(initialValue: start.content)
        _ttl = State(initialValue: start.ttl)
        _proxied = State(initialValue: start.proxied)
        _priority = State(initialValue: String(start.priority))
        _comment = State(initialValue: start.comment)
        _caaFlags = State(initialValue: String(start.caaFlags))
        _caaTag = State(initialValue: start.caaTag)
        _caaValue = State(initialValue: start.caaValue)
        _srvPriority = State(initialValue: String(start.srvPriority))
        _srvWeight = State(initialValue: String(start.srvWeight))
        _srvPort = State(initialValue: String(start.srvPort))
        _srvTarget = State(initialValue: start.srvTarget)
    }

    private var proxiable: Bool { proxiableTypes.contains(type) }

    var body: some View {
        FormScreen(title: form.title, subtitle: form.zoneName, onBack: intents.closeRecordForm) {
            if form.recordId == nil {
                Field(label: "Type") { ChoiceChips(options: recordTypes.map { ($0, $0) }, selected: type) { type = $0 } }
            }
            Field(label: "Name", hint: "Use @ for \(form.zoneName) itself, or a name like www.") {
                RunovaTextField(value: $name, placeholder: "@ or www", label: "Name")
            }
            switch type {
            case "A":
                Field(label: "IPv4 address") { RunovaTextField(value: $content, placeholder: "203.0.113.10", label: "IPv4 address") }
            case "AAAA":
                Field(label: "IPv6 address") { RunovaTextField(value: $content, placeholder: "2001:db8::1", label: "IPv6 address") }
            case "CNAME":
                Field(label: "Target", hint: "The name this one points at.") {
                    RunovaTextField(value: $content, placeholder: "example.net", label: "Target")
                }
            case "TXT":
                Field(label: "Content") {
                    RunovaTextField(value: $content, placeholder: "v=spf1 include:example.net ~all", label: "Content")
                }
            case "MX":
                Field(label: "Mail server") { RunovaTextField(value: $content, placeholder: "mx.example.net", label: "Mail server") }
                Field(label: "Priority", hint: "Lower numbers are tried first.") {
                    RunovaTextField(value: digitsOnly($priority), placeholder: "10", label: "Priority")
                }
            case "CAA":
                Field(label: "Tag") { ChoiceChips(options: caaTags, selected: caaTag) { caaTag = $0 } }
                Field(label: "Value", hint: "Such as letsencrypt.org") {
                    RunovaTextField(value: $caaValue, placeholder: "letsencrypt.org", label: "Value")
                }
                Field(label: "Flags") { RunovaTextField(value: digitsOnly($caaFlags, max: 3), placeholder: "0", label: "Flags") }
            case "SRV":
                Field(label: "Target") { RunovaTextField(value: $srvTarget, placeholder: "sip.example.com", label: "Target") }
                RunovaText("Priority, weight and port", style: RunovaType.label)
                HStack(spacing: 8) {
                    RunovaTextField(value: digitsOnly($srvPriority), placeholder: "Priority", label: "Priority")
                    RunovaTextField(value: digitsOnly($srvWeight), placeholder: "Weight", label: "Weight")
                    RunovaTextField(value: digitsOnly($srvPort), placeholder: "Port", label: "Port")
                }
            default:
                EmptyView()
            }
            if proxiable {
                SwitchRow(
                    title: "Proxy through Cloudflare", detail: "Hides the server's address and adds caching and protection.",
                    icon: RunovaIcons.cloud, isOn: proxied, enabled: true
                ) { proxied = $0 }
            }
            if proxiable && proxied {
                RunovaText("TTL is Auto while the record is proxied.", style: RunovaType.small, color: palette.mutedForeground)
            } else {
                Field(label: "TTL") { ChoiceChips(options: ttls, selected: ttl) { ttl = $0 } }
            }
            Field(label: "Comment", hint: "Only you see it, in Cloudflare.") {
                RunovaTextField(value: $comment, placeholder: "Optional", label: "Comment")
            }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(text: form.saving ? "Saving" : "Save record", enabled: !form.saving, icon: RunovaIcons.check) {
                intents.saveRecord(draft)
            }
            .frame(maxWidth: .infinity)
            if let id = form.recordId {
                RunovaButton(text: "Delete record", kind: .danger, icon: RunovaIcons.trash) { intents.deleteRecord(id) }
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private var draft: RecordDraft {
        RecordDraft(
            recordType: type, name: name, content: content, ttl: ttl, proxied: proxied,
            priority: UInt32(priority) ?? 0, comment: comment,
            caaFlags: UInt8(min(255, Int(caaFlags) ?? 0)), caaTag: caaTag, caaValue: caaValue,
            srvPriority: UInt32(srvPriority) ?? 0, srvWeight: UInt32(srvWeight) ?? 0, srvPort: UInt32(srvPort) ?? 0,
            srvTarget: srvTarget)
    }

    private func digitsOnly(_ binding: Binding<String>, max: Int = 5) -> Binding<String> {
        Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = digits($0, max: max) })
    }
}

private struct TokenScreen: View {
    let form: CloudflareTokenFormView
    let error: String?
    let intents: CloudflareIntents

    @State private var label = ""
    @State private var token = ""
    @Environment(\.openURL) private var openURL

    var body: some View {
        let replacing = form.accountId != nil
        FormScreen(
            title: replacing ? "Replace token" : "Connect Cloudflare", subtitle: form.accountLabel,
            onBack: intents.closeTokenForm
        ) {
            RunovaCard {
                VStack(alignment: .leading, spacing: 8) {
                    Step(number: 1, text: "Open Cloudflare's API tokens page and create a token for Runova.")
                    Step(number: 2, text: "Give it the permissions Runova lists on the computer, for all zones.")
                    Step(number: 3, text: "Paste it here. It's checked and saved on the computer, never on this phone.")
                    RunovaButton(text: "Open Cloudflare's token page", kind: .soft, icon: RunovaIcons.external) {
                        openURL(tokenPage)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !replacing {
                Field(label: "Account name", hint: "What you call this account, such as Work.") {
                    RunovaTextField(value: $label, placeholder: "Work", label: "Account name")
                }
            }
            Field(label: "API token", hint: "You'll confirm it's you before the token leaves this phone.") {
                RunovaTextField(
                    value: $token, placeholder: "Paste the token", secure: true, icon: RunovaIcons.key, label: "API token")
            }
            if let problem = form.problem ?? error { ErrorText(message: problem) }
            RunovaButton(
                text: form.saving ? "Checking the token" : (replacing ? "Replace token" : "Connect"),
                enabled: !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !form.saving,
                icon: RunovaIcons.lock
            ) { intents.saveToken(token, label) }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct Step: View {
    let number: Int
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RunovaText("\(number)", style: RunovaType.caption, color: palette.primary)
                .frame(width: 20, height: 20)
                .background(Circle().fill(palette.primary.opacity(0.14)))
            RunovaText(text, style: RunovaType.small)
        }
    }
}

private struct AddDomainScreen: View {
    let form: CloudflareAddDomainView
    let intents: CloudflareIntents

    @State private var name = ""
    @State private var account: String?

    var body: some View {
        let chosen = account ?? form.choices.first?.id ?? ""
        FormScreen(title: "Add a domain", subtitle: nil, onBack: intents.closeAddDomain) {
            Field(label: "Domain", hint: "Cloudflare gives you two name servers to set at your registrar.") {
                RunovaTextField(value: $name, placeholder: "example.com", icon: RunovaIcons.globe, label: "Domain")
            }
            if form.loading {
                RunovaSkeleton(width: 300)
            } else if form.choices.count > 1 {
                Field(label: "Cloudflare account") {
                    ChoiceChips(options: form.choices.map { ($0.id, $0.name) }, selected: chosen) { account = $0 }
                }
            }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(
                text: form.saving ? "Adding" : "Add domain",
                enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty && !chosen.isEmpty && !form.saving,
                icon: RunovaIcons.add
            ) { intents.addDomain(name, chosen) }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct PointDomainScreen: View {
    let form: CloudflarePointDomainView
    let intents: CloudflareIntents

    @State private var name = "@"
    @State private var server: String?
    @State private var www = true
    @State private var proxied = true
    @State private var stale = false

    @Environment(\.palette) private var palette

    var body: some View {
        let chosen = server ?? form.servers.first?.id ?? ""
        FormScreen(title: "Point to a server", subtitle: form.zoneName, onBack: intents.closePointDomain) {
            Field(label: "Name", hint: "@ is \(form.zoneName) itself.") {
                RunovaTextField(
                    value: Binding(get: { name }, set: { name = $0; stale = true }), placeholder: "@ or app", label: "Name")
            }
            Field(label: "Server") {
                if form.servers.isEmpty && !form.loading {
                    RunovaText(
                        "No saved servers yet. Add one in Deploy on the computer.", style: RunovaType.small,
                        color: palette.mutedForeground)
                } else {
                    ChoiceChips(options: form.servers.map { ($0.id, $0.name) }, selected: chosen) {
                        server = $0
                        stale = true
                    }
                }
            }
            SwitchRow(
                title: "Also point www", detail: "www.\(form.zoneName) goes to the same server.", icon: RunovaIcons.globe,
                isOn: www, enabled: true
            ) { www = $0; stale = true }
            SwitchRow(
                title: "Through Cloudflare's proxy", detail: "Hides the server's address.", icon: RunovaIcons.cloud,
                isOn: proxied, enabled: true
            ) { proxied = $0; stale = true }
            RunovaButton(text: "Preview changes", kind: .soft, enabled: !chosen.isEmpty && !form.loading, icon: RunovaIcons.show) {
                stale = false
                intents.previewPointDomain(name, chosen, www, proxied)
            }
            .frame(maxWidth: .infinity)
            if let plan = form.plan, !stale {
                RunovaCard {
                    VStack(alignment: .leading, spacing: 10) {
                        RunovaText(plan.summary, style: RunovaType.label)
                        ForEach(Array(plan.changes.enumerated()), id: \.offset) { _, change in
                            HStack(spacing: 10) {
                                RunovaBadge(text: change.actionLabel, tone: change.tone.badge)
                                VStack(alignment: .leading, spacing: 0) {
                                    RunovaText(
                                        "\(change.recordType)  \(change.name)  →  \(change.content)", style: monoSmall,
                                        maxLines: 1)
                                    if let previous = change.previous {
                                        RunovaText("was \(previous)", style: RunovaType.caption, color: palette.mutedForeground)
                                    }
                                    if let reason = change.reason {
                                        RunovaText(reason, style: RunovaType.caption, color: palette.mutedForeground)
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(
                text: form.saving ? "Applying" : "Apply",
                enabled: form.plan?.upToDate == false && !stale && !form.saving, icon: RunovaIcons.check,
                action: intents.applyPointDomain
            )
            .frame(maxWidth: .infinity)
        }
    }
}
