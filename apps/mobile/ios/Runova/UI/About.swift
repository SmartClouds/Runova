import SwiftUI

private let websiteUrl = URL(string: "https://runovahq.com")!
private let sourceUrl = URL(string: "https://github.com/SmartClouds/Runova")!
private let smartCloudsUrl = URL(string: "https://smartclouds.co")!

/// About Runova, drawn as the desktop's dialog is: lit from behind, with the maker's credit at the foot.
struct AboutSheet: View {
    let version: String
    var year = Calendar.current.component(.year, from: Date())
    let onClose: () -> Void

    @Environment(\.palette) private var palette
    @Environment(\.openURL) private var openURL

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 20)
        ZStack {
            Color.black.opacity(0.62)
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)
            ScrollView {
                VStack(spacing: 0) {
                    ZStack(alignment: .topTrailing) {
                        RadialGradient(
                            colors: [palette.primary.opacity(0.24), .clear],
                            center: UnitPoint(x: 0.5, y: 0.2), startRadius: 0, endRadius: 220
                        )
                        .allowsHitTesting(false)
                        content
                        Button(action: onClose) {
                            RunovaIcon(glyph: RunovaIcons.close, size: 14, color: palette.mutedForeground)
                                .frame(width: 40, height: 40)
                                .background(Circle().fill(palette.foreground.opacity(0.05)))
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Close")
                        .padding(8)
                    }
                    palette.foreground.opacity(0.08).frame(height: 1)
                    footer
                }
                .background(shape.fill(palette.popover))
                .clipShape(shape)
                .overlay(shape.strokeBorder(palette.foreground.opacity(0.1), lineWidth: 1))
                .padding(16)
                .frame(maxWidth: .infinity)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            RunovaLogo(size: 88)
            Spacer().frame(height: 10)
            HStack(spacing: 8) {
                RunovaText("Runova", style: RunovaType.heading)
                RunovaText("v\(version)", style: RunovaType.caption, color: palette.primary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(palette.primary.opacity(0.13)))
            }
            Spacer().frame(height: 14)
            paragraph(
                "Runova is an Agentic Development Environment (ADE) for AI coding agents. "
                    + "This app keeps your computers, terminals, git and deployments within reach.")
            Spacer().frame(height: 8)
            paragraph(
                "The name joins two words: a runway, where launches happen, and a nova, a new star. "
                    + "Your ideas take off here.")
            Spacer().frame(height: 8)
            RunovaText(
                "It's free and open source under the MIT license.", style: RunovaType.small,
                color: palette.foreground.opacity(0.82), alignment: .center)
            Spacer().frame(height: 20)
            HStack(spacing: 8) {
                RunovaButton(text: "Website", kind: .soft, icon: RunovaIcons.globe) { openURL(websiteUrl) }
                    .frame(maxWidth: .infinity)
                RunovaButton(text: "Source", kind: .soft, icon: RunovaIcons.code) { openURL(sourceUrl) }
                    .frame(maxWidth: .infinity)
            }
            Spacer().frame(height: 18)
            paragraph("Runova is built and maintained by SmartClouds.")
        }
        .padding(.horizontal, 24)
        .padding(.top, 32)
        .padding(.bottom, 22)
    }

    private var footer: some View {
        Button {
            openURL(smartCloudsUrl)
        } label: {
            HStack(spacing: 10) {
                if let logo = brandImage("smartclouds_logo", "webp") {
                    Image(uiImage: logo).resizable().scaledToFit().frame(width: 45, height: 24)
                }
                VStack(alignment: .leading, spacing: 0) {
                    RunovaSectionTitle(text: "A product of")
                    RunovaText("SmartClouds", style: RunovaType.labelStrong)
                }
                Spacer(minLength: 0)
                RunovaText("\u{00A9} \(String(year))", style: RunovaType.small, color: palette.mutedForeground)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func paragraph(_ text: String) -> some View {
        RunovaText(text, style: RunovaType.small, color: palette.mutedForeground, alignment: .center)
    }
}
