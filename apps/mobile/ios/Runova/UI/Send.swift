import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A file picked on the phone: the app's handle on its bytes, and where it goes on the other side.
struct StagedFile: Identifiable, Equatable {
    let handle: String
    let path: String
    let size: Int64
    var id: String { handle }
}

/// What is picked and not sent yet (E113). It stays on the phone's side because the picks are
/// the phone's own files; the core gets the list when Send is pressed.
final class SendPicks: ObservableObject {
    @Published var files: [StagedFile] = []
    @Published var open = false
    @Published var target: Int64?
    @Published var note = ""

    func add(_ more: [StagedFile]) {
        let have = Set(files.map(\.handle))
        files.append(contentsOf: more.filter { !have.contains($0.handle) })
    }

    func remove(_ handles: Set<String>) {
        files.removeAll { handles.contains($0.handle) }
    }
}

/// What the Send files screen can ask for. The pickers are drawn here; staging is the model's.
struct SendIntents {
    var picks = SendPicks()
    var stageFiles: ([URL]) -> Void = { _ in }
    var stageFolder: (URL) -> Void = { _ in }
    var stagePhotos: ([PhotosPickerItem]) -> Void = { _ in }
    var send: (Int64, [StagedFile], String?) -> Void = { _, _, _ in }
    var cancel: (String) -> Void = { _ in }
    var retry: (String) -> Void = { _ in }
    var dismiss: (String) -> Void = { _ in }
    var clearFinished: () -> Void = {}
    var dismissError: () -> Void = {}
}

private let livePhases: Set<SendPhase> = [.connecting, .waiting, .sending, .reconnecting]
private let waitingPhases: Set<SendPhase> = [.connecting, .waiting, .reconnecting]

/// The tile a file leads with, by what its name says it is.
func sendKind(_ name: String) -> (icon: String, tone: BadgeTone) {
    let ext = (name as NSString).pathExtension.lowercased()
    switch ext {
    case "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg", "raw", "dng": return (RunovaIcons.image, .primary)
    case "mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp": return (RunovaIcons.video, .warning)
    case "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus": return (RunovaIcons.mic, .success)
    case "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz": return (RunovaIcons.stash, .neutral)
    case "kt", "rs", "ts", "tsx", "js", "py", "java", "swift", "go", "c", "cpp", "h", "cs", "json", "yml", "yaml", "sh":
        return (RunovaIcons.code, .primary)
    case "pdf", "doc", "docx", "txt", "md", "rtf", "odt", "xls", "xlsx", "csv", "ppt", "pptx", "pages", "key":
        return (RunovaIcons.logs, .neutral)
    default: return (RunovaIcons.file, .neutral)
    }
}

/// A picked folder shows as one row, with everything in it.
struct StagedGroup: Identifiable {
    let id: String
    let title: String
    let folder: Bool
    let files: [StagedFile]
}

func stagedGroups(_ files: [StagedFile]) -> [StagedGroup] {
    var order: [String] = []
    var members: [String: [StagedFile]] = [:]
    for file in files {
        let parts = file.path.split(separator: "/", maxSplits: 1)
        let key = parts.count > 1 ? "dir:\(parts[0])" : "file:\(file.handle)"
        if members[key] == nil { order.append(key) }
        members[key, default: []].append(file)
    }
    return order.map { key in
        let group = members[key] ?? []
        let folder = key.hasPrefix("dir:")
        return StagedGroup(id: key, title: folder ? String(key.dropFirst(4)) : group[0].path, folder: folder, files: group)
    }
}

/// The Send files screen: what to send, where to, and every send so far.
struct SendFilesScreen: View {
    let screen: SendScreen
    let intents: SendIntents
    let onClose: () -> Void

    @ObservedObject private var picks: SendPicks
    @State private var importing = false
    @State private var importingFolder = false
    @State private var photos: [PhotosPickerItem] = []
    @Environment(\.palette) private var palette

    init(screen: SendScreen, intents: SendIntents, onClose: @escaping () -> Void) {
        self.screen = screen
        self.intents = intents
        self.onClose = onClose
        self._picks = ObservedObject(wrappedValue: intents.picks)
    }

    private var live: [SendBatchView] { screen.batches.filter { livePhases.contains($0.phase) } }
    private var finished: [SendBatchView] { screen.batches.filter { !livePhases.contains($0.phase) } }

    var body: some View {
        RunovaScreen(title: "Send files", subtitle: "To your computers and your team's", onBack: onClose) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // What is going now comes first; what has finished waits below the composer.
                    if !live.isEmpty {
                        RunovaSectionTitle(text: "Sending")
                        ForEach(live, id: \.batchId) { BatchCard(batch: $0, intents: intents) }
                    }
                    RunovaSectionTitle(text: "Files")
                    if picks.files.isEmpty { emptyPick } else { stagedCard }
                    RunovaSectionTitle(text: "Send to")
                    TargetPicker(targets: screen.targets, picks: picks)
                    RunovaTextField(
                        value: $picks.note, placeholder: "Add a note (optional)", icon: RunovaIcons.edit,
                        label: "A note for the other side")
                    sendAction
                    if !finished.isEmpty {
                        HStack {
                            RunovaSectionTitle(text: "Sent")
                            Spacer(minLength: 0)
                            RunovaChip(text: "Clear finished", action: intents.clearFinished)
                        }
                        .padding(.top, 8)
                        ForEach(finished, id: \.batchId) { BatchCard(batch: $0, intents: intents) }
                    }
                }
                .padding(16)
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result, !urls.isEmpty { intents.stageFiles(urls) }
        }
        .background(
            Color.clear.fileImporter(isPresented: $importingFolder, allowedContentTypes: [.folder]) { result in
                if case .success(let url) = result { intents.stageFolder(url) }
            }
        )
        .onChange(of: photos) { items in
            guard !items.isEmpty else { return }
            intents.stagePhotos(items)
            photos = []
        }
    }

    private var pickers: some View {
        HStack(spacing: 8) {
            RunovaChip(text: picks.files.isEmpty ? "Files" : "Add files", icon: RunovaIcons.file, tone: .primary) {
                importing = true
            }
            PhotosPicker(selection: $photos, matching: .any(of: [.images, .videos])) {
                HStack(spacing: 6) {
                    RunovaIcon(glyph: RunovaIcons.image, size: 12, color: palette.foreground.opacity(0.88))
                    RunovaText("Photos", style: RunovaType.smallMedium, color: palette.foreground.opacity(0.88), maxLines: 1)
                }
                .padding(.horizontal, 13)
                .frame(minHeight: 36)
                .background(
                    Capsule()
                        .fill(palette.foreground.opacity(0.05))
                        .overlay(Capsule().strokeBorder(palette.foreground.opacity(0.08), lineWidth: 1)))
            }
            .buttonStyle(.plain)
            RunovaChip(text: "Folder", icon: RunovaIcons.folder) { importingFolder = true }
        }
    }

    private var emptyPick: some View {
        let shape = RoundedRectangle(cornerRadius: 20)
        return VStack(spacing: 10) {
            RunovaHeroIcon(icon: RunovaIcons.send)
            RunovaText("Pick what to send", style: RunovaType.title)
            RunovaText(
                "Files, photos or a whole folder. They go straight to the computer, encrypted all the way.",
                color: palette.mutedForeground, alignment: .center)
            pickers.padding(.top, 2)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .background(shape.fill(palette.primary.opacity(0.04)))
        .overlay(shape.strokeBorder(palette.primary.opacity(0.22), lineWidth: 1))
    }

    private var stagedCard: some View {
        RunovaCard(padding: 0) {
            VStack(spacing: 0) {
                ForEach(stagedGroups(picks.files)) { group in
                    let bytes = UInt64(max(0, group.files.reduce(0) { $0 + $1.size }))
                    let kind = group.folder ? (icon: RunovaIcons.folder, tone: BadgeTone.warning) : sendKind(group.title)
                    HStack(spacing: 12) {
                        RunovaIconTile(icon: kind.icon, tone: kind.tone)
                        VStack(alignment: .leading, spacing: 0) {
                            RunovaText(group.title, style: RunovaType.labelStrong, maxLines: 1)
                            RunovaText(
                                group.folder ? filesSummary(count: UInt32(group.files.count), bytes: bytes) : fileSizeLabel(bytes: bytes),
                                style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                        }
                        Spacer(minLength: 0)
                        Button {
                            picks.remove(Set(group.files.map(\.handle)))
                        } label: {
                            RunovaIcon(glyph: RunovaIcons.close, size: 12, color: palette.mutedForeground)
                                .frame(width: 40, height: 40)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Take out \(group.title)")
                    }
                    .padding(.leading, 12)
                    .padding(.trailing, 4)
                    .padding(.vertical, 8)
                }
                Rectangle().fill(palette.border.opacity(0.6)).frame(height: 1)
                HStack {
                    let bytes = UInt64(max(0, picks.files.reduce(0) { $0 + $1.size }))
                    RunovaText(
                        filesSummary(count: UInt32(picks.files.count), bytes: bytes), style: RunovaType.smallMedium,
                        color: palette.mutedForeground, maxLines: 1)
                    Spacer(minLength: 0)
                    RunovaChip(text: "Clear", icon: RunovaIcons.trash, tone: .danger) { picks.files.removeAll() }
                }
                .padding(.leading, 16)
                .padding(.trailing, 12)
                .padding(.top, 12)
                pickers.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }
        }
    }

    private var chosen: SendTargetView? {
        screen.targets.first { $0.systemId == picks.target && $0.canReceive }
    }

    private var sendAction: some View {
        let target = chosen
        let ready = !picks.files.isEmpty && target != nil
        let missing: String? =
            picks.files.isEmpty ? "Pick files to send first." : (target == nil ? "Choose a computer to send to." : nil)
        return VStack(spacing: 8) {
            if let error = screen.error {
                HStack(spacing: 10) {
                    RunovaIcon(glyph: RunovaIcons.warning, size: 13, color: palette.destructive)
                    RunovaText(error, style: RunovaType.small, color: palette.destructive)
                    Spacer(minLength: 0)
                    Button(action: intents.dismissError) {
                        RunovaIcon(glyph: RunovaIcons.close, size: 11, color: palette.destructive)
                            .frame(width: 36, height: 36)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss the error")
                }
                .padding(.leading, 12)
                .padding(.trailing, 4)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 14).fill(palette.destructive.opacity(0.1)))
            }
            RunovaButton(
                text: sendButtonLabel(count: UInt32(picks.files.count), computer: target?.name), enabled: ready,
                icon: RunovaIcons.send
            ) {
                guard let system = target?.systemId else { return }
                let note = picks.note.trimmingCharacters(in: .whitespacesAndNewlines)
                intents.send(system, picks.files, note.isEmpty ? nil : note)
                picks.files.removeAll()
                picks.note = ""
            }
            .frame(maxWidth: .infinity)
            if let missing {
                RunovaText(missing, style: RunovaType.small, color: palette.mutedForeground, alignment: .center)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

private struct TargetPicker: View {
    let targets: [SendTargetView]
    @ObservedObject var picks: SendPicks

    @Environment(\.palette) private var palette

    var body: some View {
        if targets.isEmpty {
            RunovaText(
                "No computers to send to yet. Sign in to Runova on a computer with this account and it shows up here.",
                color: palette.mutedForeground)
        } else {
            let own = targets.filter(\.own)
            let team = targets.filter { !$0.own }
            VStack(alignment: .leading, spacing: 8) {
                if !own.isEmpty {
                    if !team.isEmpty { label("My computers") }
                    ForEach(own, id: \.systemId) { card($0) }
                }
                if !team.isEmpty {
                    label("Teammates' computers")
                    ForEach(team, id: \.systemId) { card($0) }
                }
            }
        }
    }

    private func label(_ text: String) -> some View {
        RunovaText(text, style: RunovaType.caption, color: palette.mutedForeground).padding(.leading, 4).padding(.top, 2)
    }

    private func card(_ target: SendTargetView) -> some View {
        let selected = picks.target == target.systemId && target.canReceive
        let shape = RoundedRectangle(cornerRadius: 16)
        return Button {
            picks.target = target.systemId
        } label: {
            HStack(spacing: 12) {
                ZStack(alignment: .bottomTrailing) {
                    RunovaIconTile(icon: RunovaIcons.systems, tone: target.canReceive ? .primary : .neutral)
                    Circle()
                        .fill(target.online ? palette.success : palette.mutedForeground.opacity(0.6))
                        .frame(width: 6, height: 6)
                        .padding(2)
                        .background(Circle().fill(palette.background))
                }
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText(target.name, style: RunovaType.labelStrong, maxLines: 1)
                    RunovaText(
                        target.reason ?? platformLabel(target.platform), style: RunovaType.small,
                        color: palette.mutedForeground, maxLines: 2)
                }
                Spacer(minLength: 0)
                ZStack {
                    Circle().fill(selected ? palette.primary : Color.clear)
                    Circle().strokeBorder(selected ? palette.primary : palette.foreground.opacity(0.2), lineWidth: 1.5)
                    if selected { RunovaIcon(glyph: RunovaIcons.check, size: 11, color: palette.primaryForeground) }
                }
                .frame(width: 22, height: 22)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(shape.fill(selected ? palette.primary.opacity(0.08) : palette.foreground.opacity(0.03)))
            .overlay(
                shape.strokeBorder(
                    selected ? palette.primary.opacity(0.85) : palette.foreground.opacity(0.08),
                    lineWidth: selected ? 1.5 : 1)
            )
            .contentShape(shape)
            .opacity(target.canReceive ? 1 : 0.55)
        }
        .buttonStyle(.plain)
        .disabled(!target.canReceive)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

func platformLabel(_ platform: String) -> String {
    switch platform {
    case "windows": return "Windows"
    case "macos": return "macOS"
    case "linux": return "Linux"
    default: return platform
    }
}

private struct BatchCard: View {
    let batch: SendBatchView
    let intents: SendIntents

    @State private var expanded = false
    @Environment(\.palette) private var palette

    private var tone: BadgeTone {
        switch batch.phase {
        case .done: return .success
        case .declined, .failed, .expired: return .danger
        case .cancelled: return .neutral
        default: return .primary
        }
    }

    private var ink: Color {
        switch batch.phase {
        case .done: return palette.success
        case .declined, .failed, .expired: return palette.destructive
        default: return palette.mutedForeground
        }
    }

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    RunovaIconTile(icon: batch.phase == .done ? RunovaIcons.check : RunovaIcons.send, tone: tone)
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(batch.title, style: RunovaType.labelStrong, maxLines: 1)
                        RunovaText(batch.sizeLabel, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                    }
                    Spacer(minLength: 0)
                    if livePhases.contains(batch.phase) {
                        RunovaText("\(batch.percent)%", style: RunovaType.labelStrong, color: palette.primary)
                    }
                }
                if let note = batch.note {
                    RunovaText("“\(note)”", style: RunovaType.small, color: palette.mutedForeground, maxLines: 3).italic()
                }
                SendRunway(percent: Int(batch.percent), phase: batch.phase)
                RunovaText(batch.status, style: RunovaType.small, color: ink)
                    .accessibilityAddTraits(.updatesFrequently)
                HStack(spacing: 8) {
                    if batch.canCancel {
                        RunovaChip(text: "Cancel", icon: RunovaIcons.close, tone: .danger) { intents.cancel(batch.batchId) }
                    }
                    if batch.canRetry {
                        RunovaChip(text: "Send again", icon: RunovaIcons.refresh, tone: .primary) { intents.retry(batch.batchId) }
                    }
                    if batch.canDismiss {
                        RunovaChip(text: "Dismiss") { intents.dismiss(batch.batchId) }
                    }
                    if !batch.files.isEmpty {
                        RunovaChip(text: expanded ? "Hide files" : "Show files", icon: RunovaIcons.processes) { expanded.toggle() }
                    }
                }
                if expanded {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(batch.files, id: \.transferId) { FileLine(file: $0) }
                        if batch.moreFiles > 0 {
                            RunovaText("And \(batch.moreFiles) more", style: RunovaType.small, color: palette.mutedForeground)
                        }
                    }
                }
            }
        }
    }
}

private struct FileLine: View {
    let file: SendFileView

    @Environment(\.palette) private var palette

    var body: some View {
        let kind = sendKind(file.name)
        HStack(spacing: 10) {
            RunovaIconTile(icon: kind.icon, tone: kind.tone, size: 28)
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(file.name, style: RunovaType.smallMedium, maxLines: 1)
                RunovaText(
                    file.error ?? [file.folder, file.sizeLabel].compactMap { $0 }.joined(separator: " · "),
                    style: RunovaType.caption, color: file.error != nil ? palette.destructive : palette.mutedForeground,
                    maxLines: 2)
            }
            Spacer(minLength: 0)
            switch file.state {
            case .done: RunovaIcon(glyph: RunovaIcons.success, size: 14, color: palette.success, label: "Arrived")
            case .failed: RunovaIcon(glyph: RunovaIcons.error, size: 14, color: palette.destructive, label: "Failed")
            case .skipped: RunovaIcon(glyph: RunovaIcons.minus, size: 14, color: palette.mutedForeground, label: "Skipped")
            case .sending: RunovaText("\(file.percent)%", style: RunovaType.caption, color: palette.primary)
            case .queued:
                RunovaIcon(glyph: RunovaIcons.clock, size: 13, color: palette.mutedForeground.opacity(0.6), label: "Waiting")
            }
        }
        .padding(.vertical, 6)
    }
}

/// How far a send is, drawn as a runway: a dashed centre line the progress runs along, a lit head
/// while bytes move, and a soft sweep while it waits for the other side.
struct SendRunway: View {
    let percent: Int
    let phase: SendPhase

    @Environment(\.palette) private var palette
    @Environment(\.runovaMotion) private var motion
    @State private var sweep: CGFloat = 0

    private var ink: Color {
        switch phase {
        case .done: return palette.success
        case .declined, .failed, .expired: return palette.destructive
        case .cancelled: return palette.mutedForeground
        default: return palette.primary
        }
    }

    var body: some View {
        let fill = phase == .done ? 1 : min(1, max(0, CGFloat(percent) / 100))
        GeometryReader { geometry in
            let width = geometry.size.width
            let reach = width * fill
            ZStack(alignment: .leading) {
                Capsule().fill(palette.foreground.opacity(0.07)).frame(height: 6)
                Path { path in
                    path.move(to: CGPoint(x: 6, y: 6))
                    path.addLine(to: CGPoint(x: max(6, width - 6), y: 6))
                }
                .stroke(palette.foreground.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [5, 5]))
                if reach > 0 {
                    Capsule()
                        .fill(LinearGradient(colors: [ink.opacity(0.45), ink], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, reach), height: 6)
                }
                if phase == .sending && reach > 0 {
                    Circle().fill(ink.opacity(0.22)).frame(width: 14, height: 14).offset(x: reach - 7)
                    Circle().fill(ink).frame(width: 8, height: 8).offset(x: reach - 4)
                }
                if waitingPhases.contains(phase) && motion {
                    Capsule()
                        .fill(LinearGradient(colors: [.clear, ink.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing))
                        .frame(width: 112, height: 6)
                        .offset(x: -112 + (width + 112) * sweep)
                        .onAppear {
                            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { sweep = 1 }
                        }
                }
            }
            .frame(height: 12)
            .clipShape(Rectangle())
        }
        .frame(height: 12)
        .accessibilityElement()
        .accessibilityLabel("Progress")
        .accessibilityValue("\(phase == .done ? 100 : percent) percent")
    }
}

/// The line on the Systems tab while files are going, which opens the Send files screen.
struct SendingStrip: View {
    let screen: SendScreen
    let onOpen: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        if let label = screen.progressLabel {
            let shape = RoundedRectangle(cornerRadius: 16)
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        RunovaIcon(glyph: RunovaIcons.send, size: 13, color: palette.primary)
                        RunovaText(label, style: RunovaType.smallMedium, maxLines: 1)
                        Spacer(minLength: 0)
                        RunovaIcon(glyph: RunovaIcons.forward, size: 10, color: palette.mutedForeground)
                    }
                    SendRunway(percent: Int(screen.progressPercent), phase: .sending)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(shape.fill(palette.primary.opacity(0.08)))
                .overlay(shape.strokeBorder(palette.primary.opacity(0.22), lineWidth: 1))
                .contentShape(shape)
            }
            .buttonStyle(.plain)
        }
    }
}

/// The Systems tab's way in.
struct SendFilesButton: View {
    let onOpen: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: onOpen) {
            RunovaIcon(glyph: RunovaIcons.send, size: 15, color: palette.primary)
                .frame(width: 40, height: 40)
                .background(Circle().fill(palette.primary.opacity(0.13)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Send files")
        .padding(.trailing, 4)
    }
}
