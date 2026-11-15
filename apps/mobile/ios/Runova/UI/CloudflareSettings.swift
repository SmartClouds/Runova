import SwiftUI

/// The tabs of a domain, in the desktop's order.
private let zoneTabs: [(CloudflareTab, String)] = [
    (.dns, "DNS"), (.ssl, "SSL/TLS"), (.caching, "Caching"), (.security, "Security"),
]

/// A choice with more options than this folds away behind its current value.
private let foldFrom = 7

private let ruleKinds: [(String, String, String)] = [
    ("block-countries", "Block countries", "Visitors from these countries get an error page."),
    ("challenge-path", "Challenge a path", "Visitors to a page, such as a login, prove they are human first."),
    ("allow-ips", "Allow IP addresses", "Requests from these addresses skip the other custom rules."),
]

private let accessModes: [(String, String)] = [
    ("block", "Block"), ("managed_challenge", "Managed challenge"), ("challenge", "Interactive challenge"),
    ("js_challenge", "JavaScript challenge"), ("whitelist", "Allow"),
]

/// The desktop's tab strip, as a row of pills.
struct ZoneTabs: View {
    let selected: CloudflareTab
    let onSelect: (CloudflareTab) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(zoneTabs.enumerated()), id: \.offset) { _, entry in
                let on = entry.0 == selected
                Button {
                    onSelect(entry.0)
                } label: {
                    RunovaText(
                        entry.1, style: RunovaType.labelStrong, color: on ? palette.primary : palette.mutedForeground,
                        maxLines: 1
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(on ? palette.primary.opacity(0.14) : Color.clear))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(palette.foreground.opacity(0.05)))
    }
}

/// Everything a tab other than DNS shows, under the switches and the tab strip.
struct ZoneTabContent: View {
    let zone: CloudflareZoneView
    let intents: CloudflareIntents

    var body: some View {
        if zone.settings.isEmpty { LoadingRows() }
        ForEach(Array(zone.settings.enumerated()), id: \.offset) { _, group in
            GroupCard(group: group, intents: intents)
        }
        switch zone.tab {
        case .caching:
            PurgeCard(intents: intents)
        case .security:
            RulesCard(zone: zone, intents: intents)
            AccessRulesCard(zone: zone, intents: intents)
        default:
            EmptyView()
        }
    }
}

private struct GroupCard: View {
    let group: CloudflareSettingsGroup
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: group.title)
            RunovaText(group.detail, style: RunovaType.small, color: palette.mutedForeground)
            VStack(spacing: 0) {
                ForEach(group.items, id: \.key) { SettingItem(item: $0, intents: intents) }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .runovaGlass()
        }
    }
}

private struct SettingItem: View {
    let item: CloudflareSettingView
    let intents: CloudflareIntents

    @State private var open = false
    @Environment(\.palette) private var palette

    var body: some View {
        if item.kind == .switch {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(item.title, style: RunovaType.label)
                        RunovaText(item.detail, style: RunovaType.small, color: palette.mutedForeground)
                    }
                    Spacer(minLength: 0)
                    RunovaToggle(isOn: item.on, label: item.title, enabled: item.editable) {
                        intents.changeSetting(item.key, $0 ? "on" : "off")
                    }
                }
                .padding(.vertical, 10)
                if let note = item.note { Note(text: note, tone: item.noteTone) }
            }
        } else {
            let current = item.options.first { $0.value == item.value }?.label ?? item.value
            let folds = item.options.count >= foldFrom
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(item.title, style: RunovaType.label)
                        RunovaText(item.detail, style: RunovaType.small, color: palette.mutedForeground)
                    }
                    Spacer(minLength: 0)
                    if folds {
                        RunovaChip(text: current, icon: open ? RunovaIcons.close : RunovaIcons.edit) { open.toggle() }
                            .accessibilityLabel("\(item.title): \(current)")
                    }
                }
                if !folds || open {
                    ChoiceChips(options: item.options.map { ($0.value, $0.label) }, selected: item.value) { value in
                        open = false
                        if value != item.value && item.editable { intents.changeSetting(item.key, value) }
                    }
                }
                if let note = item.note { Note(text: note, tone: item.noteTone) }
            }
            .padding(.vertical, 10)
        }
    }
}

private struct Note: View {
    let text: String
    let tone: CloudflareTone

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = tone == .bad ? palette.destructive : (tone == .warning ? palette.warning : palette.mutedForeground)
        HStack(alignment: .top, spacing: 8) {
            if tone != .good { RunovaIcon(glyph: RunovaIcons.warning, size: 12, color: ink) }
            RunovaText(text, style: RunovaType.small, color: ink)
        }
        .padding(.bottom, 6)
    }
}

private struct PurgeCard: View {
    let intents: CloudflareIntents

    @State private var urls = ""
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "Purge cache")
            RunovaText(
                "Cloudflare keeps copies of your files close to visitors. Purge them when a change does not show up.",
                style: RunovaType.small, color: palette.mutedForeground)
            RunovaCard {
                VStack(alignment: .leading, spacing: 10) {
                    RunovaTextArea(value: $urls, placeholder: "https://example.com/style.css, one per line", minHeight: 72)
                    Wrap {
                        RunovaButton(
                            text: "Purge these files", kind: .soft,
                            enabled: !urls.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, icon: RunovaIcons.file
                        ) { intents.purgeUrls(urls) }
                        RunovaButton(
                            text: "Purge everything", kind: .danger, icon: RunovaIcons.eraser, action: intents.purgeEverything)
                    }
                }
            }
        }
    }
}

private struct RulesCard: View {
    let zone: CloudflareZoneView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "WAF custom rules")
            RunovaText(
                "Cloudflare runs them top to bottom. An allow rule skips the ones below it.", style: RunovaType.small,
                color: palette.mutedForeground)
            RunovaChip(text: "Add rule", icon: RunovaIcons.add, tone: .primary, action: intents.openRuleBuilder)
            if zone.rules.loading {
                LoadingRows()
            } else if let problem = zone.rules.problem {
                ErrorText(message: problem)
            } else if zone.rules.custom.isEmpty {
                RunovaText(
                    "No custom rules yet. Add one to block countries, challenge a login page or let your office through.",
                    style: RunovaType.small, color: palette.mutedForeground)
            } else {
                VStack(spacing: 0) {
                    ForEach(zone.rules.custom, id: \.id) { RuleRow(rule: $0, intents: intents) }
                }
                .padding(.vertical, 4)
                .runovaGlass()
            }
        }
    }
}

private struct RuleRow: View {
    let rule: CloudflareRuleView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                RunovaText(rule.description, style: RunovaType.labelStrong, maxLines: 2)
                RunovaBadge(text: rule.actionLabel, tone: rule.tone.badge)
                RunovaText(rule.expression, style: monoSmall, color: palette.mutedForeground, maxLines: 2)
            }
            Spacer(minLength: 0)
            RunovaToggle(isOn: rule.enabled, label: rule.description) { intents.setRuleEnabled(rule.id, $0) }
            TrashButton(label: "Delete the rule \(rule.description)") { intents.deleteRule(rule.id) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct AccessRulesCard: View {
    let zone: CloudflareZoneView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "IP access rules")
            RunovaText(
                "Block, challenge or allow an address, a range, a country or a network for the whole domain.",
                style: RunovaType.small, color: palette.mutedForeground)
            RunovaChip(text: "Add access rule", icon: RunovaIcons.add, tone: .primary, action: intents.openAccessRuleForm)
            if let problem = zone.rules.accessProblem {
                ErrorText(message: problem)
            } else if zone.rules.access.isEmpty {
                RunovaText("No access rules yet.", style: RunovaType.small, color: palette.mutedForeground)
            } else {
                VStack(spacing: 0) {
                    ForEach(zone.rules.access, id: \.id) { AccessRow(rule: $0, intents: intents) }
                }
                .padding(.vertical, 4)
                .runovaGlass()
            }
        }
    }
}

private struct AccessRow: View {
    let rule: CloudflareAccessRuleView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                RunovaText(rule.value, style: RunovaType.mono)
                RunovaText(
                    [rule.targetLabel, rule.notes].filter { !$0.isEmpty }.joined(separator: " · "), style: RunovaType.small,
                    color: palette.mutedForeground, maxLines: 1)
            }
            Spacer(minLength: 0)
            RunovaBadge(text: rule.modeLabel, tone: rule.tone.badge)
            TrashButton(label: "Delete the access rule for \(rule.value)") { intents.deleteAccessRule(rule.id) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct TrashButton: View {
    let label: String
    let action: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            RunovaIcon(glyph: RunovaIcons.trash, size: 14, color: palette.mutedForeground)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct RuleBuilderScreen: View {
    let form: CloudflareFormView
    let intents: CloudflareIntents

    @State private var kind = "block-countries"
    @State private var countries = ""
    @State private var path = ""
    @State private var prefix = false
    @State private var ips = ""
    @State private var description = ""

    private var filled: Bool {
        let text = kind == "block-countries" ? countries : (kind == "challenge-path" ? path : ips)
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        FormScreen(
            title: "Add a custom rule", subtitle: "Runs for every request, before it reaches your server.",
            onBack: intents.closeRuleBuilder
        ) {
            Field(label: "Rule") {
                VStack(spacing: 8) {
                    ForEach(Array(ruleKinds.enumerated()), id: \.offset) { _, entry in
                        KindRow(label: entry.1, detail: entry.2, chosen: entry.0 == kind) { kind = entry.0 }
                    }
                }
            }
            switch kind {
            case "block-countries":
                Field(label: "Country codes", hint: "Two-letter codes separated by commas, such as CN, RU. T1 stands for Tor.") {
                    RunovaTextField(value: $countries, placeholder: "CN, RU", label: "Country codes")
                }
            case "challenge-path":
                Field(label: "Path") { RunovaTextField(value: $path, placeholder: "/wp-login.php", label: "Path") }
                Field(label: "Match") {
                    ChoiceChips(
                        options: [(false, "Exactly this path"), (true, "This path and everything under it")],
                        selected: prefix
                    ) { prefix = $0 }
                }
            default:
                Field(
                    label: "Addresses and ranges",
                    hint: "One per line, or separated by commas, such as 203.0.113.10 or 2001:db8::/32."
                ) {
                    RunovaTextArea(value: $ips, placeholder: "203.0.113.10", minHeight: 72)
                }
            }
            Field(label: "Description", hint: "Left empty, it is written from the rule.") {
                RunovaTextField(value: $description, placeholder: "Optional", label: "Description")
            }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(text: form.saving ? "Adding" : "Add rule", enabled: filled && !form.saving, icon: RunovaIcons.shield) {
                intents.addRule(kind, kind == "block-countries" ? countries : ips, path, prefix, description)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct KindRow: View {
    let label: String
    let detail: String
    let chosen: Bool
    let action: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if chosen {
                    RunovaIcon(glyph: RunovaIcons.success, size: 16, color: palette.primary)
                } else {
                    Circle().strokeBorder(palette.mutedForeground.opacity(0.6), lineWidth: 1.5).frame(width: 16, height: 16)
                }
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText(label, style: RunovaType.label)
                    RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14).fill(
                    chosen ? palette.primary.opacity(0.10) : palette.foreground.opacity(0.04))
            )
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
    }
}

struct AccessRuleScreen: View {
    let form: CloudflareFormView
    let intents: CloudflareIntents

    @State private var value = ""
    @State private var mode = "block"
    @State private var notes = ""

    var body: some View {
        FormScreen(title: "Add an access rule", subtitle: "For the whole domain.", onBack: intents.closeAccessRuleForm) {
            Field(label: "Address, range, country or network", hint: "Such as 203.0.113.10, 203.0.113.0/24, DE or AS13335.") {
                RunovaTextField(value: $value, placeholder: "203.0.113.0/24", label: "Address, range, country or network")
            }
            Field(label: "Action") { ChoiceChips(options: accessModes, selected: mode) { mode = $0 } }
            Field(label: "Notes") { RunovaTextField(value: $notes, placeholder: "Optional", label: "Notes") }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(
                text: form.saving ? "Adding" : "Add access rule",
                enabled: !value.trimmingCharacters(in: .whitespaces).isEmpty && !form.saving, icon: RunovaIcons.shield
            ) { intents.addAccessRule(value, mode, notes) }
            .frame(maxWidth: .infinity)
        }
    }
}
