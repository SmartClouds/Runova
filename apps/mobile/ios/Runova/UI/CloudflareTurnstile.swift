import SwiftUI
import UIKit

/// The Turnstile tab: the domain's widgets, each with its keys and a way in for its secret.
struct TurnstileTab: View {
    let zone: CloudflareZoneView
    let revealed: CloudflareRevealedSecretView?
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "Turnstile")
            RunovaText(
                "Cloudflare's check that tells people from bots on your forms, mostly without a puzzle.",
                style: RunovaType.small, color: palette.mutedForeground)
            RunovaChip(text: "Add widget", icon: RunovaIcons.add, tone: .primary, action: intents.newWidget)
        }
        if zone.turnstile.loading {
            LoadingRows()
        } else if let problem = zone.turnstile.problem {
            ErrorText(message: problem)
        } else if zone.turnstile.widgets.isEmpty {
            RunovaText("No widgets cover this domain yet.", style: RunovaType.small, color: palette.mutedForeground)
        } else {
            ForEach(zone.turnstile.widgets, id: \.sitekey) { widget in
                WidgetCard(
                    widget: widget, revealed: revealed?.sitekey == widget.sitekey ? revealed : nil, intents: intents)
            }
        }
    }
}

private struct WidgetCard: View {
    let widget: CloudflareWidgetView
    let revealed: CloudflareRevealedSecretView?
    let intents: CloudflareIntents

    @State private var snippetOpen = false
    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    RunovaText(widget.name, style: RunovaType.title, maxLines: 1)
                    Spacer(minLength: 0)
                    RunovaBadge(text: widget.modeLabel, tone: .primary)
                }
                RunovaText(widget.domains.joined(separator: ", "), style: RunovaType.small, color: palette.mutedForeground)
                KeyLine(label: "Site key", value: widget.sitekey)
                if let revealed {
                    KeyLine(label: "Secret", value: revealed.value)
                    RunovaChip(text: "Hide secret", icon: RunovaIcons.hide, action: intents.hideSecret)
                }
                Wrap {
                    if revealed == nil {
                        RunovaChip(text: "Show secret", icon: RunovaIcons.key, tone: .primary) {
                            intents.revealSecret(widget.sitekey)
                        }
                    }
                    RunovaChip(text: "Rotate secret", icon: RunovaIcons.refresh) { intents.rotateSecret(widget.sitekey, false) }
                    RunovaChip(text: "Edit", icon: RunovaIcons.edit) { intents.editWidget(widget.sitekey) }
                    RunovaChip(text: "HTML snippet", icon: RunovaIcons.code) { snippetOpen.toggle() }
                    RunovaChip(text: "Delete", icon: RunovaIcons.trash, tone: .danger) { intents.deleteWidget(widget.sitekey) }
                }
                if snippetOpen {
                    VStack(alignment: .leading, spacing: 8) {
                        RunovaText(
                            widget.snippet,
                            style: RunovaTextStyle(
                                size: 11, lineHeight: 14, weight: 400, tracking: 0, fontName: "JetBrainsMono-Regular")
                        )
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 12).fill(palette.foreground.opacity(0.05)))
                        RunovaChip(text: "Copy snippet", icon: RunovaIcons.copy) { UIPasteboard.general.string = widget.snippet }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct KeyLine: View {
    let label: String
    let value: String

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(label, style: RunovaType.caption, color: palette.mutedForeground)
                RunovaText(value, style: monoSmall, maxLines: 2)
            }
            Spacer(minLength: 0)
            RunovaChip(text: "Copy", icon: RunovaIcons.copy) { UIPasteboard.general.string = value }
        }
    }
}

/// The Servers tab: which saved servers hold a DNS token for this domain.
struct ServersTab: View {
    let zone: CloudflareZoneView
    let intents: CloudflareIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RunovaSectionTitle(text: "DNS tokens on your servers")
            RunovaText(
                "A server with a DNS token for \(zone.name) can get wildcard certificates, and certificates for names behind the proxy. The token can edit this domain's DNS and nothing else.",
                style: RunovaType.small, color: palette.mutedForeground)
        }
        if zone.servers.loading {
            LoadingRows()
        } else if let problem = zone.servers.problem {
            ErrorText(message: problem)
        } else if zone.servers.servers.isEmpty {
            RunovaText(
                "No saved servers yet. Add one in Deploy on the computer.", style: RunovaType.small,
                color: palette.mutedForeground)
        } else {
            ForEach(zone.servers.servers, id: \.id) { DnsServerCard(server: $0, intents: intents) }
        }
    }
}

private struct DnsServerCard: View {
    let server: CloudflareDnsServerView
    let intents: CloudflareIntents

    @State private var pasting = false
    @State private var token = ""
    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    RunovaText(server.name, style: RunovaType.title, maxLines: 1)
                    Spacer(minLength: 0)
                    if server.loading {
                        RunovaBadge(text: "Checking", tone: .neutral)
                    } else if server.hasToken {
                        RunovaBadge(text: "Has a token", tone: .success, dot: true)
                    } else {
                        RunovaBadge(text: "No token", tone: .neutral)
                    }
                }
                if !server.loading {
                    RunovaText(server.detail, style: RunovaType.small, color: palette.mutedForeground)
                }
                if let problem = server.problem { ErrorText(message: problem) }
                if !server.loading {
                    Wrap {
                        if server.hasToken {
                            RunovaChip(text: "Remove the token", icon: RunovaIcons.trash, tone: .danger) {
                                if !server.busy { intents.dnsTokenRemove(server.id) }
                            }
                        } else {
                            RunovaChip(text: "Make a token here", icon: RunovaIcons.key, tone: .primary) {
                                if !server.busy { intents.dnsTokenMint(server.id) }
                            }
                            RunovaChip(text: "Paste a token", icon: RunovaIcons.copy) { pasting.toggle() }
                        }
                    }
                }
                if pasting && !server.hasToken {
                    RunovaTextField(
                        value: $token, placeholder: "Paste the DNS token", secure: true, icon: RunovaIcons.key,
                        label: "DNS token for \(server.name)")
                    RunovaButton(
                        text: "Send to \(server.name)", kind: .soft,
                        enabled: !token.trimmingCharacters(in: .whitespaces).isEmpty && !server.busy, icon: RunovaIcons.lock
                    ) {
                        intents.dnsTokenPaste(server.id, token)
                        token = ""
                        pasting = false
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private let modeDetail = [
    "managed": "Shows a checkbox only when Cloudflare is unsure.",
    "non-interactive": "Shows a small box that never asks for a click.",
    "invisible": "Runs out of sight.",
]

struct WidgetScreen: View {
    let form: CloudflareWidgetFormView
    let intents: CloudflareIntents

    @State private var name: String
    @State private var domains: [String]
    @State private var domainDraft = ""
    @State private var mode: String
    @State private var clearance: String
    @State private var region: String
    @State private var offlabel: Bool
    @State private var ephemeral: Bool

    init(form: CloudflareWidgetFormView, intents: CloudflareIntents) {
        self.form = form
        self.intents = intents
        _name = State(initialValue: form.draft.name)
        _domains = State(initialValue: form.draft.domains)
        _mode = State(initialValue: form.draft.mode)
        _clearance = State(initialValue: form.draft.clearance)
        _region = State(initialValue: form.draft.region)
        _offlabel = State(initialValue: form.draft.offlabel)
        _ephemeral = State(initialValue: form.draft.ephemeralId)
    }

    var body: some View {
        FormScreen(title: form.title, subtitle: nil, onBack: intents.closeWidgetForm) {
            Field(label: "Name", hint: "Only you see it, to tell your widgets apart.") {
                RunovaTextField(value: $name, placeholder: "Contact form", label: "Widget name")
            }
            Field(label: "Domains", hint: "The widget works on these names and the names under them.") {
                VStack(alignment: .leading, spacing: 8) {
                    if !domains.isEmpty {
                        Wrap {
                            ForEach(domains, id: \.self) { domain in
                                RunovaChip(text: domain, icon: RunovaIcons.close, tone: .primary) {
                                    domains.removeAll { $0 == domain }
                                }
                            }
                        }
                    }
                    HStack(spacing: 8) {
                        RunovaTextField(value: $domainDraft, placeholder: "shop.example.com", label: "Add a domain")
                        RunovaChip(text: "Add", icon: RunovaIcons.add) {
                            let added = domainDraft.split(whereSeparator: { ",; \n".contains($0) })
                                .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
                                .filter { !$0.isEmpty }
                            for domain in added where !domains.contains(domain) { domains.append(domain) }
                            domainDraft = ""
                        }
                    }
                }
            }
            Field(label: "Mode", hint: modeDetail[mode]) {
                ChoiceChips(options: form.modes.map { ($0.value, $0.label) }, selected: mode) { mode = $0 }
            }
            Field(
                label: "Clearance",
                hint: "A solved widget also lets the visitor past Cloudflare challenges of this level on your site."
            ) {
                ChoiceChips(options: form.clearances.map { ($0.value, $0.label) }, selected: clearance) { clearance = $0 }
            }
            Field(label: "Region", hint: "China runs the check from inside mainland China, for visitors there.") {
                ChoiceChips(options: form.regions.map { ($0.value, $0.label) }, selected: region) { region = $0 }
            }
            SwitchRow(
                title: "Hide Cloudflare branding", detail: "Enterprise only.", icon: RunovaIcons.hide, isOn: offlabel,
                enabled: true
            ) { offlabel = $0 }
            SwitchRow(
                title: "Ephemeral visitor id", detail: "Enterprise only. Spots one bot across many addresses.",
                icon: RunovaIcons.account, isOn: ephemeral, enabled: true
            ) { ephemeral = $0 }
            if let problem = form.problem { ErrorText(message: problem) }
            RunovaButton(
                text: form.saving ? "Saving" : (form.sitekey == nil ? "Add widget" : "Save"),
                enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty && !domains.isEmpty && !form.saving,
                icon: RunovaIcons.check
            ) {
                intents.saveWidget(
                    WidgetDraft(
                        name: name, domains: domains, mode: mode, clearance: clearance, region: region,
                        offlabel: offlabel, ephemeralId: ephemeral))
            }
            .frame(maxWidth: .infinity)
        }
    }
}
