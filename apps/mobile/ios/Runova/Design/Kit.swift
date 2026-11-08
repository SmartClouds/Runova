import SwiftUI

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

enum ButtonKind { case primary, soft, ghost, danger }

/// A pill, as the desktop's default buttons are.
struct RunovaButton: View {
    let text: String
    var kind: ButtonKind = .primary
    var enabled = true
    var icon: String?
    let action: () -> Void

    @Environment(\.palette) private var palette

    private var colors: (fill: Color, ink: Color) {
        switch kind {
        case .primary: return (palette.primary, palette.primaryForeground)
        case .soft: return (palette.secondary, palette.secondaryForeground)
        case .ghost: return (.clear, palette.foreground)
        case .danger: return (palette.destructive, palette.destructiveForeground)
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon { RunovaIcon(glyph: icon, size: 14, color: colors.ink) }
                RunovaText(text, style: RunovaType.label, color: colors.ink, maxLines: 1)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background(Capsule().fill(colors.fill.opacity(enabled ? 1 : 0.5)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

struct RunovaCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: () -> Content

    @Environment(\.palette) private var palette

    var body: some View {
        content()
            .padding(padding)
            .background(RoundedRectangle(cornerRadius: RunovaShape.lg).fill(palette.card))
    }
}

enum BadgeTone { case neutral, primary, success, warning, danger }

struct RunovaBadge: View {
    let text: String
    var tone: BadgeTone = .neutral

    @Environment(\.palette) private var palette

    var body: some View {
        let ink: Color = {
            switch tone {
            case .neutral: return palette.mutedForeground
            case .primary: return palette.primary
            case .success: return palette.success
            case .warning: return palette.warning
            case .danger: return palette.destructive
            }
        }()
        RunovaText(text, style: RunovaType.caption, color: ink, maxLines: 1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(tone == .neutral ? palette.secondary : ink.opacity(0.15)))
    }
}

/// A row that opens something: icon, title, optional detail, and what is at the end.
struct RunovaListRow: View {
    let title: String
    var detail: String?
    var icon: String?
    var onTap: (() -> Void)?

    @Environment(\.palette) private var palette

    private var row: some View {
        HStack(spacing: 12) {
            if let icon {
                RunovaIcon(glyph: icon, color: palette.secondaryForeground)
                    .frame(width: 36, height: 36)
                    .background(RoundedRectangle(cornerRadius: RunovaShape.md).fill(palette.secondary))
            }
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(title, style: RunovaType.label, maxLines: 1)
                if let detail {
                    RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                }
            }
            Spacer(minLength: 0)
            if onTap != nil {
                RunovaIcon(glyph: RunovaIcons.forward, size: 12, color: palette.mutedForeground)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 56)
        .contentShape(Rectangle())
    }

    var body: some View {
        if let onTap {
            Button(action: onTap) { row }.buttonStyle(.plain)
        } else {
            row
        }
    }
}

struct RunovaTextField: View {
    @Binding var value: String
    let placeholder: String
    var secure = false

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack(alignment: .leading) {
            if value.isEmpty {
                RunovaText(placeholder, color: palette.mutedForeground, maxLines: 1)
            }
            Group {
                if secure {
                    SecureField("", text: $value)
                } else {
                    TextField("", text: $value)
                }
            }
                .font(RunovaType.body.font)
                .tint(palette.primary)
                .foregroundColor(palette.foreground)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 12)
        .frame(height: 44)
        .background(
            RoundedRectangle(cornerRadius: RunovaShape.md)
                .fill(palette.secondary)
                .overlay(RoundedRectangle(cornerRadius: RunovaShape.md).stroke(palette.input, lineWidth: 1))
        )
    }
}

struct RunovaTopBar<Trailing: View>: View {
    let title: String
    var onBack: (() -> Void)?
    @ViewBuilder var trailing: () -> Trailing

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            if let onBack {
                Button(action: onBack) {
                    RunovaIcon(glyph: RunovaIcons.back).frame(width: 44, height: 44).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back")
            } else {
                Color.clear.frame(width: 8, height: 8)
            }
            RunovaText(title, style: RunovaType.heading, maxLines: 1)
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.horizontal, 8)
        .frame(height: 52)
    }
}

extension RunovaTopBar where Trailing == EmptyView {
    init(title: String, onBack: (() -> Void)? = nil) {
        self.init(title: title, onBack: onBack) { EmptyView() }
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
                Capsule().fill(palette.secondary)
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
                Capsule().fill(isOn ? palette.primary : palette.secondary)
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

/// A small control: a terminal key, a filter, a shortcut.
struct RunovaChip: View {
    let text: String
    let action: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            RunovaText(text, style: RunovaType.label, color: palette.secondaryForeground, maxLines: 1)
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background(RoundedRectangle(cornerRadius: RunovaShape.sm).fill(palette.secondary))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct TabItem: Identifiable {
    let id: String
    let title: String
    let icon: String
}

struct RunovaBottomBar: View {
    let tabs: [TabItem]
    let selected: String
    let onSelect: (String) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs) { tab in
                let ink = tab.id == selected ? palette.primary : palette.mutedForeground
                Button {
                    onSelect(tab.id)
                } label: {
                    VStack(spacing: 0) {
                        RunovaIcon(glyph: tab.icon, size: 18, color: ink)
                        RunovaText(tab.title, style: RunovaType.caption, color: ink, maxLines: 1)
                    }
                    .frame(maxWidth: .infinity, minHeight: 60)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(height: 60)
        .background(palette.card)
    }
}

struct RunovaEmptyState: View {
    let icon: String
    let title: String
    let detail: String

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 8) {
            RunovaIcon(glyph: icon, size: 28, color: palette.mutedForeground)
            RunovaText(title, style: RunovaType.title, alignment: .center)
            RunovaText(detail, color: palette.mutedForeground, alignment: .center)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }
}

/// Where content will be while it loads.
struct RunovaSkeleton: View {
    var width: CGFloat

    @Environment(\.palette) private var palette

    var body: some View {
        RoundedRectangle(cornerRadius: RunovaShape.sm)
            .fill(palette.muted)
            .frame(width: width, height: 14)
    }
}
