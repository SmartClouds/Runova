import SwiftUI
import UIKit

/// What the remote screen can ask for. Sending and copying clipboards goes through the OS, so it is native.
struct RemoteIntents {
    var frames: RemoteFrames?
    var open: (Int64) -> Void = { _ in }
    var close: () -> Void = {}
    var submitPassword: (String) -> Void = { _ in }
    var usePassword: () -> Void = {}
    var pointer: (RemotePointer) -> Void = { _ in }
    var text: (String) -> Void = { _ in }
    var key: (RemoteKey) -> Void = { _ in }
    var sendClipboard: () -> Void = {}
    var copyClipboard: (String) -> Void = { _ in }
    var clipboardTaken: () -> Void = {}
    var dismissNote: () -> Void = {}
}

private let largestZoom: CGFloat = 5
private let zoomNoticeable: CGFloat = 0.01

/// Where the computer's screen sits inside the viewer, in the viewer's points.
struct ContentRect: Equatable {
    let left: CGFloat
    let top: CGFloat
    let width: CGFloat
    let height: CGFloat

    /// A point in the viewer as a position on the computer's screen, from 0 to 1.
    func normalized(_ point: CGPoint) -> (x: Double, y: Double) {
        let x = (Double(point.x) - Double(left)) / Double(width)
        let y = (Double(point.y) - Double(top)) / Double(height)
        return (min(max(x, 0), 1), min(max(y, 0), 1))
    }
}

private func placeAlong(box: CGFloat, content: CGFloat, pan: CGFloat) -> CGFloat {
    let centred = (box - content) / 2
    if content <= box { return centred }
    return min(max(centred + pan, box - content), 0)
}

/// Fits the computer's screen in the viewer, then applies the phone's own zoom and pan.
func fitContent(
    boxWidth: CGFloat, boxHeight: CGFloat, screenWidth: CGFloat, screenHeight: CGFloat,
    zoom: CGFloat, panX: CGFloat, panY: CGFloat
) -> ContentRect {
    guard screenWidth > 0, screenHeight > 0 else {
        return ContentRect(left: 0, top: 0, width: boxWidth, height: boxHeight)
    }
    let fit = min(boxWidth / screenWidth, boxHeight / screenHeight)
    let width = screenWidth * fit * zoom
    let height = screenHeight * fit * zoom
    return ContentRect(
        left: placeAlong(box: boxWidth, content: width, pan: panX),
        top: placeAlong(box: boxHeight, content: height, pan: panY),
        width: width, height: height)
}

private let shortcutKeys: [(label: String, key: RemoteKey)] = [
    ("Esc", .escape), ("Tab", .tab), ("Backspace", .backspace), ("Del", .delete),
    ("Up", .up), ("Down", .down), ("Left", .left), ("Right", .right), ("Home", .home), ("End", .end),
    ("Page up", .pageUp), ("Page down", .pageDown), ("Ctrl C", .ctrlC), ("Ctrl V", .ctrlV),
    ("Ctrl Z", .ctrlZ), ("Ctrl A", .ctrlA), ("Alt Tab", .altTab), ("Alt F4", .altF4), ("Win", .windows),
]

/// What a computer's "Remote" section shows while its screen is not open yet.
struct RemoteTab: View {
    let connection: ConnectionView
    let intents: RemoteIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 12) {
            RunovaIcon(glyph: RunovaIcons.remote, size: 36, color: palette.primary)
            RunovaText("Remote", style: RunovaType.title, alignment: .center)
            RunovaText(
                "See and use \(connection.systemName)'s screen. The rest of this computer's tools pause until you close it.",
                color: palette.mutedForeground, alignment: .center)
            RunovaButton(text: "Open screen") { intents.open(connection.systemId) }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A whole-screen takeover: connecting, asking for a password, or the computer's screen.
struct RemoteViewerScreen: View {
    let view: RemoteView
    let intents: RemoteIntents

    var body: some View {
        switch view.phase {
        case .live: LiveViewer(view: view, intents: intents)
        case .needsPassword: PasswordPrompt(view: view, intents: intents)
        case .failed: RemoteMessage(view: view, failed: true, intents: intents)
        default: RemoteMessage(view: view, failed: false, intents: intents)
        }
    }
}

private func waitingText(_ view: RemoteView) -> (title: String, detail: String) {
    let name = view.systemName
    switch view.phase {
    case .requesting: return ("Reaching \(name)", "Asking Runova where it is.")
    case .waitingForApproval: return ("Waiting at \(name)", "Someone at that computer has to say yes.")
    case .connecting: return ("Connecting", "Looking for the way to \(name).")
    case .securing: return ("Securing the connection", "Checking it really is \(name).")
    case .failed: return ("Couldn't open the screen", view.error ?? "Something went wrong.")
    default: return (name, "")
    }
}

private struct RemoteMessage: View {
    let view: RemoteView
    let failed: Bool
    let intents: RemoteIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let text = waitingText(view)
        VStack(spacing: 0) {
            RunovaTopBar(title: view.systemName, onBack: intents.close)
            VStack(spacing: 10) {
                RunovaIcon(
                    glyph: failed ? RunovaIcons.warning : RunovaIcons.remote, size: 36,
                    color: failed ? palette.destructive : palette.primary)
                RunovaText(text.title, style: RunovaType.title, alignment: .center)
                RunovaText(text.detail, color: palette.mutedForeground, alignment: .center)
                if failed {
                    RunovaButton(text: "Back", kind: .soft, action: intents.close).padding(.top, 6)
                } else if view.canUsePassword {
                    RunovaButton(text: "Use password instead", kind: .soft, action: intents.usePassword)
                        .padding(.top, 6)
                }
            }
            .padding(32)
            .frame(maxHeight: .infinity)
        }
    }
}

private struct PasswordPrompt: View {
    let view: RemoteView
    let intents: RemoteIntents

    @State private var password = ""
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: view.systemName, onBack: intents.close)
            VStack(alignment: .leading, spacing: 12) {
                RunovaText("Enter this computer's password", style: RunovaType.title)
                RunovaText(
                    "The password set for unattended access on \(view.systemName).",
                    color: palette.mutedForeground)
                RunovaTextField(value: $password, placeholder: "Password", secure: true)
                if let error = view.error {
                    RunovaText(error, style: RunovaType.small, color: palette.destructive)
                }
                RunovaButton(text: "Connect", enabled: !password.isEmpty) {
                    intents.submitPassword(password)
                    password = ""
                }
                .frame(maxWidth: .infinity)
            }
            .padding(24)
            Spacer(minLength: 0)
        }
    }
}

private struct LiveViewer: View {
    let view: RemoteView
    let intents: RemoteIntents

    @State private var keyboardOpen = false

    private var badge: (text: String, tone: BadgeTone) {
        if view.agent { return ("Agent", .warning) }
        return view.direct == true ? ("Direct", .primary) : ("Relay", .warning)
    }

    var body: some View {
        VStack(spacing: 0) {
            RunovaTopBar(title: view.systemName, onBack: intents.close) {
                RunovaBadge(text: badge.text, tone: badge.tone).padding(.trailing, 8)
            }
            ScreenCanvas(view: view, intents: intents)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let text = view.clipboard { ClipboardBar(text: text, intents: intents) }
            if let note = view.note { NoteBar(message: note, onDismiss: intents.dismissNote) }
            if keyboardOpen { KeyboardPanel(intents: intents) }
            Toolbar(keyboardOpen: keyboardOpen, onKeyboard: { keyboardOpen.toggle() }, intents: intents)
        }
    }
}

private struct ToolButton: View {
    let icon: String
    let label: String
    var active = false
    let action: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            RunovaIcon(glyph: icon, size: 16, color: active ? palette.primaryForeground : palette.secondaryForeground)
                .frame(width: 44, height: 44)
                .background(Circle().fill(active ? palette.primary : palette.secondary))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct Toolbar: View {
    let keyboardOpen: Bool
    let onKeyboard: () -> Void
    let intents: RemoteIntents

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            ToolButton(icon: RunovaIcons.keyboard, label: "Keyboard", active: keyboardOpen, action: onKeyboard)
            ToolButton(icon: RunovaIcons.copy, label: "Send clipboard", action: intents.sendClipboard)
            Spacer(minLength: 0)
            RunovaButton(text: "Close", kind: .soft, icon: RunovaIcons.close, action: intents.close)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(palette.card)
    }
}

private struct KeyboardPanel: View {
    let intents: RemoteIntents

    @State private var text = ""
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(shortcutKeys, id: \.label) { item in
                        RunovaChip(text: item.label) { intents.key(item.key) }
                    }
                }
            }
            HStack(spacing: 8) {
                RunovaTextField(value: $text, placeholder: "Type on the computer")
                RunovaButton(text: "Send", icon: RunovaIcons.send) {
                    if !text.isEmpty { intents.text(text) }
                    intents.key(.enter)
                    text = ""
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(palette.card)
    }
}

private struct ClipboardBar: View {
    let text: String
    let intents: RemoteIntents

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            RunovaText("The computer shared its clipboard.", style: RunovaType.small, maxLines: 1)
            Spacer(minLength: 0)
            RunovaChip(text: "Copy") { intents.copyClipboard(text) }
            RunovaChip(text: "Ignore", action: intents.clipboardTaken)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(palette.secondary)
    }
}

private struct NoteBar: View {
    let message: String
    let onDismiss: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: onDismiss) {
            RunovaText(message, style: RunovaType.small)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(palette.secondary)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The computer's screen, in the middle, and all touches on it.
private struct ScreenCanvas: View {
    let view: RemoteView
    let intents: RemoteIntents

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            Color.black
            if let frames = intents.frames, view.width > 0 {
                RemoteScreenLayer(frames: frames, screenWidth: CGFloat(view.width), screenHeight: CGFloat(view.height), pointer: intents.pointer)
            } else {
                RunovaText("Waiting for the screen", color: palette.mutedForeground)
            }
        }
        .clipped()
    }
}

/// Hosts the layer the screen is drawn on and turns touches into positions on it.
private struct RemoteScreenLayer: UIViewRepresentable {
    @ObservedObject var frames: RemoteFrames
    let screenWidth: CGFloat
    let screenHeight: CGFloat
    let pointer: (RemotePointer) -> Void

    func makeUIView(context: Context) -> RemoteScreenUIView {
        RemoteScreenUIView()
    }

    func updateUIView(_ view: RemoteScreenUIView, context: Context) {
        view.screenWidth = screenWidth
        view.screenHeight = screenHeight
        view.pointer = pointer
        view.show(frames.image)
    }
}

final class RemoteScreenUIView: UIView, UIGestureRecognizerDelegate {
    var screenWidth: CGFloat = 0 {
        didSet { setNeedsLayout() }
    }
    var screenHeight: CGFloat = 0 {
        didSet { setNeedsLayout() }
    }
    var pointer: ((RemotePointer) -> Void)?

    private let picture = CALayer()
    private var zoom: CGFloat = 1
    private var panOffset = CGPoint.zero
    private var dragLast = CGPoint.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        layer.addSublayer(picture)
        picture.contentsGravity = .resize
        addGestures()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func addGestures() {
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(onLongPress))
        longPress.minimumPressDuration = 0.5
        addGestureRecognizer(longPress)

        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap))
        tap.require(toFail: longPress)
        addGestureRecognizer(tap)

        let drag = UIPanGestureRecognizer(target: self, action: #selector(onDrag))
        drag.maximumNumberOfTouches = 1
        addGestureRecognizer(drag)

        let twoFingers = UIPanGestureRecognizer(target: self, action: #selector(onTwoFingers))
        twoFingers.minimumNumberOfTouches = 2
        twoFingers.maximumNumberOfTouches = 2
        twoFingers.delegate = self
        addGestureRecognizer(twoFingers)

        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch))
        pinch.delegate = self
        addGestureRecognizer(pinch)
    }

    /// A pinch and a two-finger drag are the same two fingers.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { true }

    private var content: ContentRect {
        fitContent(
            boxWidth: bounds.width, boxHeight: bounds.height, screenWidth: screenWidth, screenHeight: screenHeight,
            zoom: zoom, panX: panOffset.x, panY: panOffset.y)
    }

    private func relayout() {
        let rect = content
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.frame = CGRect(x: rect.left, y: rect.top, width: rect.width, height: rect.height)
        CATransaction.commit()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        relayout()
    }

    func show(_ image: CGImage?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.contents = image
        CATransaction.commit()
    }

    private func position(_ gesture: UIGestureRecognizer) -> (x: Double, y: Double) {
        content.normalized(gesture.location(in: self))
    }

    @objc private func onTap(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended else { return }
        let at = position(gesture)
        pointer?(.tap(x: at.x, y: at.y))
    }

    @objc private func onLongPress(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began else { return }
        let at = position(gesture)
        pointer?(.rightTap(x: at.x, y: at.y))
    }

    @objc private func onDrag(_ gesture: UIPanGestureRecognizer) {
        let at = position(gesture)
        switch gesture.state {
        case .began: pointer?(.dragStart(x: at.x, y: at.y))
        case .changed: pointer?(.dragMove(x: at.x, y: at.y))
        case .ended, .cancelled: pointer?(.dragEnd(x: at.x, y: at.y))
        default: break
        }
    }

    @objc private func onTwoFingers(_ gesture: UIPanGestureRecognizer) {
        guard gesture.state == .began || gesture.state == .changed else { return }
        let translation = gesture.translation(in: self)
        gesture.setTranslation(.zero, in: self)
        if zoom > 1.02 {
            let rect = content
            let roomX = max(0, (rect.width - bounds.width) / 2)
            let roomY = max(0, (rect.height - bounds.height) / 2)
            panOffset.x = min(max(panOffset.x + translation.x, -roomX), roomX)
            panOffset.y = min(max(panOffset.y + translation.y, -roomY), roomY)
            relayout()
        } else {
            let at = position(gesture)
            pointer?(.scroll(x: at.x, y: at.y, dx: Double(translation.x), dy: Double(translation.y)))
        }
    }

    @objc private func onPinch(_ gesture: UIPinchGestureRecognizer) {
        guard gesture.state == .changed else { return }
        if abs(gesture.scale - 1) > zoomNoticeable {
            zoom = min(max(zoom * gesture.scale, 1), largestZoom)
            if zoom <= 1 { panOffset = .zero }
            gesture.scale = 1
            relayout()
        }
    }
}
