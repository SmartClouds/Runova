import SwiftUI

/// What the Tasks screens can ask the core to do (E124).
struct TaskIntents {
    var open: (String) -> Void = { _ in }
    var close: () -> Void = {}
    var setStatus: (String, String) -> Void = { _, _ in }
    var toggle: (String, UInt32, Bool) -> Void = { _, _, _ in }
    var create: (String, String?) -> Void = { _, _ in }
    var update: (String, TaskEditInput) -> Void = { _, _ in }
    var showRecords: (String?) -> Void = { _ in }
    var setRecordStatus: (String, String, String) -> Void = { _, _, _ in }
    var answer: (String, String) -> Void = { _, _ in }
    var addRecord: (String, String, String?) -> Void = { _, _, _ in }
    var redo: (String, String?, Bool) -> Void = { _, _, _ in }
    var split: (String, Bool) -> Void = { _, _ in }
    var cancelSplit: () -> Void = {}
    var addSplit: () -> Void = {}
    var discardSplit: () -> Void = {}
    var start: () -> Void = {}
    var pause: () -> Void = {}
    var resume: () -> Void = {}
}

private let taskViews = ["Overview", "Tasks", "Records", "Split"]
private let recordKinds: [(String, String)] = [
    ("decision", "Decisions"), ("workaround", "Workarounds"), ("risk", "Risks"),
    ("question", "Questions"), ("milestone", "Milestones"),
]
private let priorities = ["p0", "p1", "p2", "p3"]

private func tone(of status: String) -> BadgeTone {
    switch status {
    case "done": return .success
    case "blocked": return .danger
    case "testing": return .warning
    case "in-progress": return .primary
    default: return .neutral
    }
}

private func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

struct TasksTab: View {
    let view: AppView
    let intents: TaskIntents
    @State private var tab = "Overview"

    var body: some View {
        if view.selectedProject == nil {
            RunovaEmptyState(
                icon: RunovaIcons.folder, title: "Choose a project",
                detail: "Pick a project on the Projects tab to see its plan and tasks.")
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(taskViews, id: \.self) { name in
                            RunovaChip(text: name, tone: tab == name ? .primary : .soft) {
                                tab = name
                                if name == "Records", view.tasks.recordsKind == nil { intents.showRecords("decision") }
                            }
                            .accessibilityAddTraits(tab == name ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                }
                Group {
                    switch tab {
                    case "Tasks": TaskListView(tasks: view.tasks.tasks, intents: intents)
                    case "Records":
                        RecordsView(kind: view.tasks.recordsKind, records: view.tasks.records, intents: intents)
                    case "Split": SplitView(split: view.tasks.split, intents: intents)
                    default: OverviewView(overview: view.tasks.overview, loading: view.tasks.loading, intents: intents)
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
    }
}

private struct ProgressLine: View {
    let percent: UInt8
    let label: String
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.foreground.opacity(0.1))
                    Capsule().fill(palette.primary)
                        .frame(width: geometry.size.width * CGFloat(percent) / 100)
                }
            }
            .frame(height: 6)
            .accessibilityLabel(label)
            RunovaText(label, style: RunovaType.small, color: palette.mutedForeground)
        }
    }
}

private struct TaskRow: View {
    let task: TaskRowView
    let intents: TaskIntents

    var body: some View {
        HStack(spacing: 8) {
            RunovaListRow(
                title: "\(task.id) \(task.title)", detail: task.meta.isEmpty ? nil : task.meta,
                onTap: { intents.open(task.id) })
            RunovaBadge(text: task.statusLabel, tone: tone(of: task.status))
        }
    }
}

private struct OverviewView: View {
    let overview: TasksOverviewView?
    let loading: Bool
    let intents: TaskIntents
    @Environment(\.palette) private var palette

    var body: some View {
        if let overview {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    RunovaCard {
                        VStack(alignment: .leading, spacing: 6) {
                            RunovaText(overview.title, style: RunovaType.heading)
                            RunovaText(overview.modeLabel, style: RunovaType.small, color: palette.mutedForeground)
                            if let goal = overview.goal { RunovaText(goal) }
                            ProgressLine(percent: overview.percent, label: overview.progressLabel)
                            RunovaText(overview.countsLabel, style: RunovaType.small, color: palette.mutedForeground)
                            if let records = overview.recordsLabel {
                                RunovaText(records, style: RunovaType.small, color: palette.mutedForeground)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    RunovaCard {
                        HStack(spacing: 8) {
                            RunovaText(overview.run?.label ?? "Not running", style: RunovaType.labelStrong)
                            Spacer()
                            if overview.run?.canPause == true {
                                RunovaButton(text: "Pause", kind: .soft, icon: RunovaIcons.stop, action: intents.pause)
                            } else if overview.run?.canResume == true {
                                RunovaButton(text: "Go on", icon: RunovaIcons.play, action: intents.resume)
                            } else if overview.canStart {
                                RunovaButton(text: "Run the tasks", icon: RunovaIcons.play, action: intents.start)
                            }
                        }
                    }
                    if !overview.milestones.isEmpty {
                        RunovaSectionTitle(text: "Milestones")
                        ForEach(overview.milestones, id: \.id) { milestone in
                            RunovaCard {
                                VStack(alignment: .leading, spacing: 4) {
                                    RunovaText("\(milestone.id) \(milestone.title)", style: RunovaType.labelStrong)
                                    if let target = milestone.target {
                                        RunovaText("Target \(target)", style: RunovaType.small, color: palette.mutedForeground)
                                    }
                                    ProgressLine(percent: milestone.percent, label: milestone.label)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    if !overview.needsYou.isEmpty || !overview.questions.isEmpty {
                        RunovaSectionTitle(text: "Needs you")
                        ForEach(overview.needsYou, id: \.id) { task in TaskRow(task: task, intents: intents) }
                        ForEach(overview.questions, id: \.id) { question in
                            RunovaListRow(title: "\(question.id) \(question.title)", icon: RunovaIcons.info, iconTone: .warning)
                        }
                    }
                }
                .padding(16)
            }
        } else if loading {
            LoadingRows()
        } else {
            RunovaEmptyState(
                icon: RunovaIcons.doneAll, title: "No plan yet", detail: "Split work into tasks from the Split tab.")
        }
    }
}

private struct TaskListView: View {
    let tasks: [TaskRowView]
    let intents: TaskIntents
    @State private var title = ""
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    RunovaTextField(value: $title, placeholder: "A new task")
                    RunovaButton(text: "Add", enabled: !trimmed(title).isEmpty, icon: RunovaIcons.add) {
                        intents.create(trimmed(title), nil)
                        title = ""
                    }
                }
                if tasks.isEmpty {
                    RunovaText("No tasks yet.", style: RunovaType.small, color: palette.mutedForeground).padding(.top, 12)
                }
                ForEach(tasks, id: \.id) { task in TaskRow(task: task, intents: intents) }
            }
            .padding(16)
        }
    }
}

private struct Sections: View {
    let sections: [TaskSectionView]

    var body: some View {
        ForEach(sections, id: \.heading) { section in
            VStack(alignment: .leading, spacing: 2) {
                RunovaSectionTitle(text: section.heading)
                RunovaText(section.text, style: RunovaType.small)
            }
        }
    }
}

private struct RecordsView: View {
    let kind: String?
    let records: [TaskRecordView]
    let intents: TaskIntents
    @State private var title = ""
    @State private var text = ""
    @State private var answers: [String: String] = [:]
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(recordKinds, id: \.0) { id, label in
                            RunovaChip(text: label, tone: kind == id ? .primary : .soft) { intents.showRecords(id) }
                                .accessibilityAddTraits(kind == id ? .isSelected : [])
                        }
                    }
                }
                if let kind {
                    RunovaCard {
                        VStack(alignment: .leading, spacing: 8) {
                            RunovaTextField(value: $title, placeholder: "Title of a new one")
                            RunovaTextField(value: $text, placeholder: "What it says (optional)")
                            RunovaButton(text: "Add", enabled: !trimmed(title).isEmpty, icon: RunovaIcons.add) {
                                intents.addRecord(kind, trimmed(title), trimmed(text).isEmpty ? nil : trimmed(text))
                                title = ""
                                text = ""
                            }
                        }
                    }
                }
                if records.isEmpty {
                    RunovaText(
                        "None yet. Sessions write them as they work.", style: RunovaType.small,
                        color: palette.mutedForeground)
                }
                ForEach(records, id: \.id) { record in
                    RunovaCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                RunovaText("\(record.id) \(record.title)", style: RunovaType.labelStrong)
                                Spacer()
                                RunovaBadge(text: record.status)
                            }
                            ForEach(record.details, id: \.heading) { line in
                                RunovaText("\(line.heading): \(line.text)", style: RunovaType.small, color: palette.mutedForeground)
                            }
                            Sections(sections: record.sections)
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(record.statuses.filter { $0 != record.status }, id: \.self) { status in
                                        RunovaChip(text: status) {
                                            if let kind { intents.setRecordStatus(kind, record.id, status) }
                                        }
                                    }
                                }
                            }
                            if kind == "question", record.status == "open" {
                                let answer = Binding(
                                    get: { answers[record.id] ?? "" }, set: { answers[record.id] = $0 })
                                RunovaTextField(value: answer, placeholder: "Your answer")
                                RunovaButton(
                                    text: "Answer", kind: .soft, enabled: !trimmed(answer.wrappedValue).isEmpty
                                ) { intents.answer(record.id, trimmed(answer.wrappedValue)) }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(16)
        }
    }
}

private struct SplitView: View {
    let split: TaskSplitView
    let intents: TaskIntents
    @State private var request = ""
    @State private var planOnly = false
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                RunovaTextField(value: $request, placeholder: "What should the tasks deliver?")
                HStack(spacing: 6) {
                    RunovaChip(text: "Fit the context budget", tone: planOnly ? .soft : .primary) { planOnly = false }
                    RunovaChip(text: "Plan only", tone: planOnly ? .primary : .soft) { planOnly = true }
                }
                RunovaText(
                    planOnly
                        ? "Parts sized by what they deliver, each with a full spec, and no context budget."
                        : "Tasks sized to the context one AI session holds.",
                    style: RunovaType.small, color: palette.mutedForeground)
                if split.running {
                    HStack {
                        RunovaText("Planning on your computer…", style: RunovaType.small)
                        Spacer()
                        RunovaButton(text: "Stop", kind: .ghost, action: intents.cancelSplit)
                    }
                } else {
                    RunovaButton(text: "Plan tasks", enabled: !trimmed(request).isEmpty, icon: RunovaIcons.sparkles) {
                        intents.split(trimmed(request), planOnly)
                    }
                }
                if let error = split.error { RunovaText(error, style: RunovaType.small, color: palette.destructive) }
                if let summary = split.summary {
                    RunovaCard {
                        VStack(alignment: .leading, spacing: 6) {
                            RunovaText(summary)
                            ForEach(split.entries, id: \.self) { RunovaText($0, style: RunovaType.small) }
                            if let extras = split.extras {
                                RunovaText(extras, style: RunovaType.small, color: palette.mutedForeground)
                            }
                            HStack(spacing: 8) {
                                RunovaButton(text: "Add to the board", icon: RunovaIcons.check, action: intents.addSplit)
                                RunovaButton(text: "Discard", kind: .ghost, action: intents.discardSplit)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(16)
        }
    }
}

/// One task on its own screen: status, criteria, spec, handoff, journal, edit and redo.
struct TaskDetailScreen: View {
    let detail: TaskDetailView
    let busy: Bool
    let intents: TaskIntents
    @State private var editing = false
    @State private var title = ""
    @State private var priority: String?
    @State private var keep = true
    @Environment(\.palette) private var palette

    var body: some View {
        let task = detail.row
        RunovaScreen(title: task.id, subtitle: task.title, onBack: intents.close) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        RunovaBadge(text: task.statusLabel, tone: tone(of: task.status))
                        if let attempt = detail.attemptLabel { RunovaBadge(text: attempt) }
                    }
                    if !task.meta.isEmpty {
                        RunovaText(task.meta, style: RunovaType.small, color: palette.mutedForeground)
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(detail.moves, id: \.status) { move in
                                RunovaChip(text: move.label) { intents.setStatus(task.id, move.status) }
                            }
                        }
                    }
                    if !detail.acceptance.isEmpty {
                        RunovaSectionTitle(text: "Acceptance criteria")
                        ForEach(detail.acceptance, id: \.index) { check in
                            Button {
                                intents.toggle(task.id, check.index, !check.checked)
                            } label: {
                                HStack(spacing: 10) {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 5)
                                            .fill(check.checked ? palette.primary : palette.foreground.opacity(0.05))
                                        RoundedRectangle(cornerRadius: 5)
                                            .stroke(check.checked ? palette.primary : palette.foreground.opacity(0.3), lineWidth: 1.5)
                                        if check.checked {
                                            RunovaIcon(glyph: RunovaIcons.check, size: 11, color: palette.primaryForeground)
                                        }
                                    }
                                    .frame(width: 18, height: 18)
                                    RunovaText(check.text, style: RunovaType.small)
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .accessibilityLabel(check.text)
                            .accessibilityAddTraits(check.checked ? .isSelected : [])
                        }
                    }
                    Sections(sections: detail.sections)
                    if let handoff = detail.handoff {
                        RunovaCard {
                            VStack(alignment: .leading, spacing: 8) {
                                RunovaText("Handoff", style: RunovaType.labelStrong)
                                RunovaText(handoff.summary, style: RunovaType.small, color: palette.mutedForeground)
                                Sections(sections: handoff.sections)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if !detail.journal.isEmpty {
                        RunovaSectionTitle(text: "Journal")
                        ForEach(detail.journal.reversed(), id: \.heading) { entry in
                            RunovaText(entry.heading, style: RunovaType.labelStrong)
                            RunovaText(entry.lines.joined(separator: " · "), style: RunovaType.small, color: palette.mutedForeground)
                        }
                    }
                    RunovaCard {
                        VStack(alignment: .leading, spacing: 8) {
                            if editing {
                                RunovaTextField(value: $title, placeholder: "Title")
                                HStack(spacing: 6) {
                                    ForEach(priorities, id: \.self) { value in
                                        RunovaChip(text: value.uppercased(), tone: priority == value ? .primary : .soft) {
                                            priority = priority == value ? nil : value
                                        }
                                    }
                                }
                                RunovaButton(text: "Save", enabled: !trimmed(title).isEmpty) {
                                    intents.update(
                                        task.id,
                                        TaskEditInput(
                                            title: trimmed(title), priority: priority, size: detail.size, due: detail.due))
                                    editing = false
                                }
                            } else {
                                RunovaButton(text: "Edit", kind: .soft, icon: RunovaIcons.edit) {
                                    title = task.title
                                    priority = detail.priority
                                    editing = true
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    RunovaCard {
                        VStack(alignment: .leading, spacing: 8) {
                            RunovaText("Redo with another agent", style: RunovaType.labelStrong)
                            HStack(spacing: 6) {
                                RunovaChip(text: "Learn from this attempt", tone: keep ? .primary : .soft) { keep = true }
                                RunovaChip(text: "From the spec alone", tone: keep ? .soft : .primary) { keep = false }
                            }
                            RunovaButton(
                                text: "Redo", kind: .soft, enabled: task.status != "in-progress", icon: RunovaIcons.undo
                            ) { intents.redo(task.id, nil, keep) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(16)
            }
        }
    }
}
