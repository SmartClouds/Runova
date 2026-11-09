import SwiftUI

// Drawn from the desktop's own rules in index.css and the page kit: content on a rounded island
// inside darker chrome, glass cards with a bright top edge, pill fields and buttons with a hairline
// washed from the foreground, tinted icon tiles, and a soft glow on what matters most.

extension RunovaType {
    static let labelStrong = RunovaTextStyle(size: 13, lineHeight: 18, weight: 600)
    static let smallMedium = RunovaTextStyle(size: 12, lineHeight: 16, weight: 500)
    static let overline = RunovaTextStyle(size: 10, lineHeight: 14, weight: 600, tracking: 0.08)
}

private let cardRadius = RunovaShape.lg + 2
private let tileRadius: CGFloat = 12

/// The desktop's `.glass`: a see-through card whose top edge catches the light.
struct RunovaGlass: ViewModifier {
    var radius: CGFloat = cardRadius

    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let dark = scheme == .dark
        let shape = RoundedRectangle(cornerRadius: radius)
        content
            .background(shape.fill(palette.card.opacity(dark ? 0.55 : 0.6)))
            .clipShape(shape)
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [
                            dark ? palette.foreground.opacity(0.17) : Color.white.opacity(0.9),
                            palette.foreground.opacity(dark ? 0.09 : 0.08),
                        ],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1))
    }
}

/// A soft light around something, drawn in layers so both apps paint exactly the same.
private struct Glow: View {
    let color: Color
    var corner: CGFloat = 999

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: corner + 8).fill(color.opacity(0.06)).padding(-8)
            RoundedRectangle(cornerRadius: corner + 5).fill(color.opacity(0.09)).padding(-5)
            RoundedRectangle(cornerRadius: corner + 2.5).fill(color.opacity(0.14)).padding(-2.5)
        }
    }
}

extension View {
    func runovaGlass() -> some View { modifier(RunovaGlass()) }

    /// A row in a list, as its own glass card.
    func rowCard() -> some View {
        modifier(RunovaGlass()).padding(.vertical, 4)
    }
}

/// Text at a fixed line height, as Compose draws it, so the two apps lay out the same.
struct RunovaText: View {
    let text: String
    var style: RunovaTextStyle = RunovaType.body
    var color: Color?
    var maxLines: Int?
    var alignment: TextAlignment = .leading

    @Environment(\.palette) private var palette

    init(
        _ text: String, style: RunovaTextStyle = RunovaType.body, color: Color? = nil,
        maxLines: Int? = nil, alignment: TextAlignment = .leading
    ) {
        self.text = text
        self.style = style
        self.color = color
        self.maxLines = maxLines
        self.alignment = alignment
    }

    var body: some View {
        Text(text)
            .font(style.font)
            .tracking(style.size * style.tracking)
            .lineSpacing(max(0, style.lineHeight - style.uiFont.lineHeight))
            .multilineTextAlignment(alignment)
            .lineLimit(maxLines)
            .truncationMode(.tail)
            .foregroundColor(color ?? palette.foreground)
            .frame(minHeight: style.lineHeight)
    }
}

/// One glyph from the bundled icon font. Without a label it is decoration.
struct RunovaIcon: View {
    let glyph: String
    var size: CGFloat = 16
    var color: Color?
    var label: String?

    @Environment(\.palette) private var palette

    var body: some View {
        let icon = Text(glyph)
            .font(.custom("FontAwesome7Free-Solid", fixedSize: size * 0.875))
            .foregroundColor(color ?? palette.foreground)
            .frame(width: size, height: size)
        if let label {
            icon.accessibilityLabel(label)
        } else {
            icon.accessibilityHidden(true)
        }
    }
}

enum ButtonKind { case primary, soft, ghost, danger, tint }

/// A pill, as the desktop's buttons are. Only the main action has weight and a glow.
struct RunovaButton: View {
    let text: String
    var kind: ButtonKind = .primary
    var enabled = true
    var icon: String?
    let action: () -> Void

    @Environment(\.palette) private var palette

    private var ink: Color {
        switch kind {
        case .primary: return palette.primaryForeground
        case .soft, .ghost: return palette.foreground.opacity(0.88)
        case .danger: return palette.destructive
        case .tint: return palette.primary
        }
    }

    @ViewBuilder private var surface: some View {
        switch kind {
        case .primary:
            ZStack {
                if enabled { Glow(color: palette.primary) }
                Capsule().fill(palette.primary.opacity(enabled ? 1 : 0.5))
            }
        case .soft:
            Capsule()
                .fill(palette.foreground.opacity(0.05))
                .overlay(Capsule().strokeBorder(palette.foreground.opacity(0.08), lineWidth: 1))
        case .ghost: Color.clear
        case .danger: Capsule().fill(palette.destructive.opacity(0.12))
        case .tint: Capsule().fill(palette.primary.opacity(0.13))
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon { RunovaIcon(glyph: icon, size: 14, color: ink) }
                RunovaText(text, style: RunovaType.labelStrong, color: ink, maxLines: 1)
            }
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background(surface)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

struct RunovaCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .runovaGlass()
    }
}

/// Where a page's content sits, rounded inside the darker chrome as on the desktop.
struct RunovaIsland<Content: View>: View {
    @ViewBuilder let content: () -> Content

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: RunovaShape.island)
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(palette.background)
            .clipShape(shape)
            .overlay(shape.strokeBorder(palette.border.opacity(0.7), lineWidth: 1))
            .padding(.horizontal, 6)
    }
}

/// A whole page: its title on the chrome, and its content on the island.
struct RunovaScreen<Trailing: View, Content: View>: View {
    let title: String
    var subtitle: String?
    var onBack: (() -> Void)?
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            RunovaTopBar(title: title, subtitle: subtitle, onBack: onBack, trailing: trailing)
            RunovaIsland(content: content).padding(.bottom, 6)
        }
    }
}

extension RunovaScreen where Trailing == EmptyView {
    init(
        title: String, subtitle: String? = nil, onBack: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, subtitle: subtitle, onBack: onBack, trailing: { EmptyView() }, content: content)
    }
}

enum BadgeTone { case neutral, primary, success, warning, danger }

extension RunovaPalette {
    func ink(_ tone: BadgeTone) -> Color {
        switch tone {
        case .neutral: return mutedForeground
        case .primary: return primary
        case .success: return success
        case .warning: return warning
        case .danger: return destructive
        }
    }
}

/// A status as a small tinted pill, with a dot when it is a live state.
struct RunovaBadge: View {
    let text: String
    var tone: BadgeTone = .neutral
    var dot = false

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = palette.ink(tone)
        HStack(spacing: 6) {
            if dot { Circle().fill(ink).frame(width: 6, height: 6) }
            RunovaText(text, style: RunovaType.caption, color: ink, maxLines: 1)
        }
        .padding(.horizontal, 9)
        .frame(height: 22)
        .background(Capsule().fill(tone == .neutral ? palette.foreground.opacity(0.07) : ink.opacity(0.13)))
    }
}

/// An icon on its tinted tile, which the desktop's cards and rows lead with.
struct RunovaIconTile: View {
    let icon: String
    var tone: BadgeTone = .primary
    var size: CGFloat = 36

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = tone == .neutral ? palette.foreground.opacity(0.8) : palette.ink(tone)
        RunovaIcon(glyph: icon, size: size * 0.44, color: ink)
            .frame(width: size, height: size)
            .background(
                RoundedRectangle(cornerRadius: tileRadius)
                    .fill(tone == .neutral ? palette.foreground.opacity(0.06) : ink.opacity(0.13)))
    }
}

/// The big glowing tile at the head of an empty state or a form.
struct RunovaHeroIcon: View {
    let icon: String
    var tone: BadgeTone = .primary

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = palette.ink(tone)
        let shape = RoundedRectangle(cornerRadius: 18)
        RunovaIcon(glyph: icon, size: 24, color: ink)
            .frame(width: 60, height: 60)
            .background(
                ZStack {
                    Glow(color: ink, corner: 18)
                    // Keeps the glow outside the tile, which is see-through.
                    shape.fill(palette.background)
                    shape.fill(ink.opacity(0.13))
                }
            )
            .overlay(shape.strokeBorder(ink.opacity(0.28), lineWidth: 1))
    }
}

/// The small uppercase heading the desktop's menu puts over its groups.
struct RunovaSectionTitle: View {
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaText(
            text.uppercased(), style: RunovaType.overline, color: palette.mutedForeground.opacity(0.75), maxLines: 1)
    }
}

/// A row that opens something. It is its own glass card, unless `flat` because it sits inside one.
struct RunovaListRow: View {
    let title: String
    var detail: String?
    var icon: String?
    var iconTone: BadgeTone = .primary
    var flat = false
    var onTap: (() -> Void)?

    @Environment(\.palette) private var palette

    private var row: some View {
        HStack(spacing: 12) {
            if let icon { RunovaIconTile(icon: icon, tone: iconTone) }
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(title, style: RunovaType.labelStrong, maxLines: 1)
                if let detail {
                    RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                }
            }
            Spacer(minLength: 0)
            if onTap != nil {
                RunovaIcon(glyph: RunovaIcons.forward, size: 11, color: palette.mutedForeground.opacity(0.7))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 60)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var framed: some View {
        if flat { row } else { row.rowCard() }
    }

    var body: some View {
        if let onTap {
            Button(action: onTap) { framed }.buttonStyle(.plain)
        } else {
            framed
        }
    }
}

/// A pill field, as the desktop's are, that lights up while it has focus.
struct RunovaTextField: View {
    @Binding var value: String
    let placeholder: String
    var secure = false
    var icon: String?

    @State private var revealed = false
    @FocusState private var focused: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            if let icon { RunovaIcon(glyph: icon, size: 14, color: palette.mutedForeground) }
            ZStack(alignment: .leading) {
                if value.isEmpty {
                    RunovaText(placeholder, color: palette.mutedForeground.opacity(0.75), maxLines: 1)
                }
                Group {
                    if secure && !revealed {
                        SecureField("", text: $value)
                    } else {
                        TextField("", text: $value)
                    }
                }
                .focused($focused)
                .font(RunovaType.body.font)
                .tint(palette.primary)
                .foregroundColor(palette.foreground)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
            if secure {
                Button {
                    revealed.toggle()
                } label: {
                    RunovaIcon(
                        glyph: revealed ? RunovaIcons.hide : RunovaIcons.show, size: 14, color: palette.mutedForeground
                    )
                    .frame(width: 34, height: 34)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(revealed ? "Hide password" : "Show password")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, secure ? 6 : 16)
        .frame(height: 44)
        .background(
            ZStack {
                if focused { Glow(color: palette.primary) }
                // Keeps the glow outside the field, which is see-through.
                Capsule().fill(palette.background)
                Capsule().fill(palette.foreground.opacity(0.05))
                Capsule().strokeBorder(
                    focused ? palette.primary.opacity(0.5) : palette.foreground.opacity(0.08), lineWidth: 1)
            }
        )
    }
}

/// A page's title on the chrome, with a line about it when there is one.
struct RunovaTopBar<Trailing: View>: View {
    let title: String
    var subtitle: String?
    var onBack: (() -> Void)?
    @ViewBuilder var trailing: () -> Trailing

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            if let onBack {
                Button(action: onBack) {
                    RunovaIcon(glyph: RunovaIcons.back, size: 14)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(palette.foreground.opacity(0.05)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back")
                Color.clear.frame(width: 10, height: 10)
            } else {
                Color.clear.frame(width: 8, height: 8)
            }
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(title, style: RunovaType.title, maxLines: 1)
                if let subtitle {
                    RunovaText(subtitle, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                }
            }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.horizontal, 8)
        .frame(height: 56)
    }
}

extension RunovaTopBar where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, onBack: (() -> Void)? = nil) {
        self.init(title: title, subtitle: subtitle, onBack: onBack) { EmptyView() }
    }
}

/// How full something is. It warns near the limit, as the desktop's status bar does.
struct RunovaProgress: View {
    let percent: Double

    @Environment(\.palette) private var palette

    private var fill: Color {
        if percent >= 90 { return palette.destructive }
        if percent >= 75 { return palette.warning }
        return palette.primary
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(palette.foreground.opacity(0.08))
                Capsule().fill(fill).frame(width: geometry.size.width * min(max(percent / 100, 0), 1))
            }
        }
        .frame(height: 6)
    }
}

/// On or off. Drawn here so it is the same switch on both apps.
struct RunovaToggle: View {
    let isOn: Bool
    let label: String
    let onChange: (Bool) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button {
            onChange(!isOn)
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(isOn ? palette.primary : palette.foreground.opacity(0.1))
                Circle()
                    .fill(isOn ? palette.primaryForeground : palette.mutedForeground)
                    .frame(width: 22, height: 22)
                    .padding(3)
            }
            .frame(width: 46, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "On" : "Off")
    }
}

enum ChipTone { case soft, primary, danger }

/// A small pill control: a terminal key, a filter, a shortcut.
struct RunovaChip: View {
    let text: String
    var icon: String?
    var tone: ChipTone = .soft
    let action: () -> Void

    @Environment(\.palette) private var palette

    private var ink: Color {
        switch tone {
        case .soft: return palette.foreground.opacity(0.88)
        case .primary: return palette.primary
        case .danger: return palette.destructive
        }
    }

    @ViewBuilder private var surface: some View {
        switch tone {
        case .soft:
            Capsule()
                .fill(palette.foreground.opacity(0.05))
                .overlay(Capsule().strokeBorder(palette.foreground.opacity(0.08), lineWidth: 1))
        case .primary: Capsule().fill(palette.primary.opacity(0.13))
        case .danger: Capsule().fill(palette.destructive.opacity(0.12))
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { RunovaIcon(glyph: icon, size: 12, color: ink) }
                RunovaText(text, style: RunovaType.smallMedium, color: ink, maxLines: 1)
            }
            .padding(.horizontal, 13)
            .frame(minHeight: 36)
            .background(surface)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct TabItem: Identifiable {
    let id: String
    let title: String
    let icon: String
}

/// The tab bar, on the chrome, with the desktop menu's tinted pill and accent mark.
struct RunovaBottomBar: View {
    let tabs: [TabItem]
    let selected: String
    let onSelect: (String) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs) { tab in
                let on = tab.id == selected
                let ink = on ? palette.primary : palette.mutedForeground
                Button {
                    onSelect(tab.id)
                } label: {
                    VStack(spacing: 2) {
                        RunovaIcon(glyph: tab.icon, size: 17, color: ink)
                        RunovaText(tab.title, style: RunovaType.caption, color: ink, maxLines: 1)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(RoundedRectangle(cornerRadius: 12).fill(on ? palette.primary.opacity(0.13) : Color.clear))
                    .overlay(alignment: .top) {
                        if on {
                            Capsule()
                                .fill(palette.primary)
                                .frame(width: 22, height: 3)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .frame(height: 62)
    }
}

struct RunovaEmptyState: View {
    let icon: String
    let title: String
    let detail: String
    var tone: BadgeTone = .primary

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 10) {
            RunovaHeroIcon(icon: icon, tone: tone).padding(.bottom, 8)
            RunovaText(title, style: RunovaType.title, alignment: .center)
            if !detail.isEmpty {
                RunovaText(detail, color: palette.mutedForeground, alignment: .center)
            }
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }
}

/// Where content will be while it loads.
struct RunovaSkeleton: View {
    var width: CGFloat

    @Environment(\.palette) private var palette

    var body: some View {
        Capsule()
            .fill(palette.foreground.opacity(0.07))
            .frame(width: width, height: 14)
    }
}
