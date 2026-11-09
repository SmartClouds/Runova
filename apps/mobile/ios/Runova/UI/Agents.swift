import SwiftUI
import UIKit

struct PromptIntents {
    var generate: (String, String, String) -> Void = { _, _, _ in }
    var cancel: () -> Void = {}
    var taken: () -> Void = {}
    var send: (String, String?, String?, String?) -> Void = { _, _, _, _ in }
    var loadLibrary: (String?) -> Void = { _ in }
    var saveTemplate: (String, String, String, String) -> Void = { _, _, _, _ in }
    var deleteTemplate: (String) -> Void = { _ in }
    var schedule: (PromptScheduleInput) -> Void = { _ in }
    var cancelScheduled: (String) -> Void = { _ in }
}

/// Which sheet a workflow's chips have opened.
struct FixSheet: Equatable {
    let workflowId: Int64
    let auto: Bool
}

private let defaultChoice = "Default"

private func toneOf(_ tone: AutoFixTone) -> BadgeTone {
    switch tone {
    case .working: return .primary
    case .attention: return .warning
    case .done: return .success
    case .failed: return .danger
    case .stopped: return .neutral
    }
}

/// Under a workflow: what can be done about its run, or how the fix in progress is going.
struct WorkflowFixes: View {
    let workflow: WorkflowView
    let sessions: [AutoFixSessionView]
    let intents: PipelineIntents
    let onSheet: (FixSheet) -> Void

    var body: some View {
        if let session = sessions.first(where: { $0.workflowId == workflow.id }) {
            AutoFixPanel(session: session, intents: intents)
        } else if let run = workflow.run, run.state == .running || run.state == .queued || run.state == .failed {
            HStack(spacing: 6) {
                if run.state == .failed {
                    RunovaChip(text: "Fix with AI", icon: RunovaIcons.sparkles, tone: .primary) {
                        onSheet(FixSheet(workflowId: workflow.id, auto: false))
                    }
                }
                RunovaChip(text: "Auto-fix", icon: RunovaIcons.wand) {
                    onSheet(FixSheet(workflowId: workflow.id, auto: true))
                }
            }
        }
    }
}

/// Says what is about to happen on the computer, and takes the choice of agent.
struct FixAgentSheet: View {
    let sheet: FixSheet
    let branch: String?
    let options: PromptOptionsView?
    let intents: PipelineIntents
    let onClose: () -> Void

    @State private var cli: String?
    @State private var model: String?
    @State private var effort: String?
    @Environment(\.palette) private var palette

    private var target: PromptTargetView? { options?.targets.first { $0.name == cli } }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.6).ignoresSafeArea().onTapGesture(perform: onClose)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    RunovaIconTile(icon: sheet.auto ? RunovaIcons.wand : RunovaIcons.sparkles, size: 38)
                    RunovaText(sheet.auto ? "Turn on auto-fix?" : "Fix this run with AI?", style: RunovaType.heading)
                }
                RunovaText(
                    sheet.auto
                        ? "If this run fails, an agent on this computer fixes it, then commits and pushes to \(branch ?? "this branch"). It tries up to the limit in your Settings."
                        : "An agent starts on this computer with the failure in hand. You can follow it here and answer it. Nothing is pushed unless you ask it to.",
                    style: RunovaType.small, color: palette.mutedForeground)
                if let options {
                    RunovaSectionTitle(text: "Agent").padding(.top, 4)
                    ChipRow(items: [defaultChoice] + options.targets.map(\.name), selected: cli ?? defaultChoice) { name in
                        cli = name == defaultChoice ? nil : name
                        model = nil
                        effort = nil
                    }
                    AgentModelRows(target: target, model: $model, effort: $effort)
                }
                RunovaButton(
                    text: sheet.auto ? "Turn on auto-fix" : "Start the agent",
                    icon: sheet.auto ? RunovaIcons.wand : RunovaIcons.sparkles
                ) {
                    if sheet.auto {
                        intents.autoFixStart(sheet.workflowId, target?.id, model, effort)
                    } else {
                        intents.fixWithAi(sheet.workflowId, target?.id, model, effort)
                    }
                    onClose()
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
            }
            .padding(20)
            .background(
                RoundedRectangle(cornerRadius: 24).fill(palette.popover).ignoresSafeArea(edges: .bottom)
            )
        }
    }
}

private struct AgentModelRows: View {
    let target: PromptTargetView?
    @Binding var model: String?
    @Binding var effort: String?

    var body: some View {
        let models = target?.models ?? []
        if !models.isEmpty {
            RunovaSectionTitle(text: "Model").padding(.top, 4)
            ChipRow(
                items: [defaultChoice] + models.map(\.label),
                selected: models.first { $0.value == model }?.label ?? defaultChoice
            ) { label in
                model = models.first { $0.label == label }?.value
                effort = nil
            }
            let efforts = models.first { $0.value == model }?.efforts ?? []
            if !efforts.isEmpty {
                RunovaSectionTitle(text: "Effort").padding(.top, 4)
                ChipRow(items: [defaultChoice] + efforts, selected: effort ?? defaultChoice) { picked in
                    effort = picked == defaultChoice ? nil : picked
                }
            }
        }
    }
}

private struct AutoFixPanel: View {
    let session: AutoFixSessionView
    let intents: PipelineIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                RunovaIcon(glyph: RunovaIcons.wand, size: 13, color: palette.primary)
                RunovaText("Auto-fix", style: RunovaType.labelStrong)
                Spacer(minLength: 0)
                RunovaBadge(text: session.phaseLabel, tone: toneOf(session.tone), dot: true)
            }
            if let message = session.message {
                RunovaText(message, style: RunovaType.small, color: palette.mutedForeground)
            }
            if !session.timeline.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(session.timeline.indices, id: \.self) { index in
                        HStack(spacing: 8) {
                            Circle()
                                .fill(index == session.timeline.count - 1 ? palette.primary : palette.foreground.opacity(0.25))
                                .frame(width: 6, height: 6)
                            RunovaText(session.timeline[index], style: RunovaType.small, color: palette.mutedForeground)
                        }
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if let agent = session.agentSession {
                        RunovaChip(text: "Watch the agent", icon: RunovaIcons.terminal, tone: .primary) {
                            intents.watchAgent(agent)
                        }
                    }
                    if session.canStop {
                        RunovaChip(text: "Stop", icon: RunovaIcons.stop, tone: .danger) { intents.autoFixStop(session.id) }
                    }
                    if session.canRetry {
                        RunovaChip(text: "Try again", icon: RunovaIcons.refresh) { intents.autoFixRetry(session.id) }
                    }
                    if session.canCommit {
                        RunovaChip(text: "Commit now", icon: RunovaIcons.commit) { intents.autoFixCommit(session.id) }
                    }
                    if session.canDismiss {
                        RunovaChip(text: "Clear", icon: RunovaIcons.close) { intents.autoFixDismiss(session.id) }
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(shape.fill(palette.foreground.opacity(0.04)))
        .overlay(shape.strokeBorder(palette.foreground.opacity(0.08), lineWidth: 1))
    }
}

/// Describe the job, let the computer write the prompt, then send it to an agent.
struct PromptsTab: View {
    let view: AppView
    let intents: PromptIntents

    var body: some View {
        if let options = view.prompts.options {
            PromptsForm(view: view, options: options, intents: intents)
        } else {
            LoadingRows()
        }
    }
}

private let delays: [(String, Int64)] = [
    ("In 30 min", 1_800_000), ("In 1 hour", 3_600_000), ("In 3 hours", 10_800_000), ("In 8 hours", 28_800_000),
    ("Tomorrow", 86_400_000),
]

private struct PromptsForm: View {
    let view: AppView
    let options: PromptOptionsView
    let intents: PromptIntents

    @State private var library: String?
    @State private var request = ""
    @State private var type: String?
    @State private var target: String?
    @State private var model: String?
    @State private var effort: String?
    @State private var prompt = ""
    @State private var naming = false
    @State private var name = ""
    @State private var scheduling = false
    @Environment(\.palette) private var palette

    private var pickedType: String { type ?? options.types.first(where: { $0 == "Bug Fix" }) ?? options.types.first ?? "" }
    private var pickedTarget: String { target ?? options.defaultTarget ?? options.targets.first?.name ?? "" }
    private var chosen: PromptTargetView? { options.targets.first { $0.name == pickedTarget } }
    private var blank: Bool { request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        if let section = library {
            PromptLibrary(
                section: section, screen: view.prompts, onSection: { library = $0 }, intents: intents
            ) { useType, useTarget, content, raw in
                type = useType
                target = useTarget
                prompt = content
                if let raw { request = raw }
                library = nil
            }
        } else {
            form
        }
    }

    private var form: some View {
        let screen = view.prompts
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    RunovaChip(text: "Templates", icon: RunovaIcons.file) { library = "Templates" }
                    RunovaChip(text: "History", icon: RunovaIcons.history) { library = "History" }
                    RunovaChip(text: "Scheduled", icon: RunovaIcons.clock) { library = "Scheduled" }
                }
                RunovaSectionTitle(text: "What do you want done?").padding(.top, 4)
                RunovaTextArea(value: $request, placeholder: "Describe the job in your own words", minHeight: 84)
                RunovaSectionTitle(text: "Kind of prompt").padding(.top, 6)
                ChipRow(items: options.types, selected: pickedType) { type = $0 }
                RunovaSectionTitle(text: "Written for").padding(.top, 6)
                ChipRow(items: options.targets.map(\.name), selected: pickedTarget) { name in
                    target = name
                    model = nil
                    effort = nil
                }
                RunovaButton(
                    text: screen.generating ? "Stop" : "Generate prompt",
                    kind: screen.generating ? .danger : .primary,
                    enabled: screen.generating || !blank,
                    icon: screen.generating ? RunovaIcons.stop : RunovaIcons.sparkles
                ) {
                    if screen.generating {
                        intents.cancel()
                    } else {
                        intents.generate(
                            request.trimmingCharacters(in: .whitespacesAndNewlines), pickedType, pickedTarget)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
                if screen.generating {
                    RunovaText("The AI on this computer is writing it.", style: RunovaType.small, color: palette.primary)
                }
                if let error = screen.error {
                    RunovaText(error, style: RunovaType.small, color: palette.destructive)
                }
                if !prompt.isEmpty { result }
            }
            .padding(16)
        }
        .onChange(of: screen.result) { result in
            guard let result else { return }
            prompt = result
            intents.taken()
        }
    }

    @ViewBuilder private var result: some View {
        RunovaSectionTitle(text: "Your prompt").padding(.top, 6)
        RunovaTextArea(value: $prompt, placeholder: "Your prompt", minHeight: 160)
        AgentModelRows(target: chosen, model: $model, effort: $effort)
        HStack(spacing: 8) {
            RunovaButton(text: "Copy", kind: .soft, icon: RunovaIcons.copy) {
                UIPasteboard.general.string = prompt
            }
            .frame(maxWidth: .infinity)
            RunovaButton(text: "Send to agent", enabled: view.selectedProject != nil, icon: RunovaIcons.send) {
                intents.send(prompt, chosen?.id, model, effort)
            }
            .frame(maxWidth: .infinity)
        }
        HStack(spacing: 6) {
            RunovaChip(text: "Save as template", icon: RunovaIcons.file) { naming.toggle() }
            if view.selectedProject != nil {
                RunovaChip(text: "Schedule", icon: RunovaIcons.clock) { scheduling.toggle() }
            }
        }
        if naming {
            HStack(spacing: 8) {
                RunovaTextField(value: $name, placeholder: "Template name", icon: RunovaIcons.file)
                RunovaButton(text: "Save", enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty) {
                    intents.saveTemplate(name.trimmingCharacters(in: .whitespaces), pickedType, pickedTarget, prompt)
                    name = ""
                    naming = false
                }
            }
        }
        if scheduling {
            ChipRow(items: delays.map(\.0), selected: "") { label in
                guard let delay = delays.first(where: { $0.0 == label })?.1 else { return }
                let raw = request.trimmingCharacters(in: .whitespacesAndNewlines)
                intents.schedule(
                    PromptScheduleInput(
                        rawInput: raw.isEmpty ? String(prompt.prefix(80)) : raw, promptType: pickedType, target: pickedTarget,
                        content: prompt, inMs: delay, cliId: chosen?.id, model: model, effort: effort))
                scheduling = false
            }
        }
        if view.selectedProject == nil {
            RunovaText(
                "Choose a project to send it to an agent.", style: RunovaType.small, color: palette.mutedForeground)
        }
    }
}

private struct PromptLibrary: View {
    let section: String
    let screen: PromptsScreen
    let onSection: (String?) -> Void
    let intents: PromptIntents
    let onUse: (String, String, String, String?) -> Void

    @State private var query = ""
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    RunovaChip(text: "Back", icon: RunovaIcons.back) { onSection(nil) }
                    ForEach(["Templates", "History", "Scheduled"], id: \.self) { item in
                        RunovaChip(text: item, tone: item == section ? .primary : .soft) { onSection(item) }
                    }
                }
                switch section {
                case "Templates": templates
                case "History": history
                default: scheduled
                }
            }
            .padding(16)
        }
        .onAppear { intents.loadLibrary(nil) }
    }

    @ViewBuilder private var templates: some View {
        if screen.templates.isEmpty { note("Save a prompt as a template and it shows up here.") }
        ForEach(screen.templates, id: \.id) { one in
            HStack(spacing: 8) {
                Button {
                    onUse(one.promptType, one.targetAi, one.content, nil)
                } label: {
                    RunovaListRow(
                        title: one.name, detail: "\(one.promptType), for \(one.targetAi)", icon: RunovaIcons.file, flat: true
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                RunovaChip(text: "Delete", icon: RunovaIcons.trash, tone: .danger) { intents.deleteTemplate(one.id) }
            }
            .padding(.trailing, 12)
            .rowCard()
        }
    }

    @ViewBuilder private var history: some View {
        HStack(spacing: 8) {
            RunovaTextField(value: $query, placeholder: "Search your prompts", icon: RunovaIcons.search)
            RunovaChip(text: "Search") {
                let term = query.trimmingCharacters(in: .whitespaces)
                intents.loadLibrary(term.isEmpty ? nil : term)
            }
        }
        if screen.history.isEmpty { note("Prompts you generate show up here.") }
        ForEach(screen.history, id: \.id) { one in
            RunovaListRow(title: one.rawInput, detail: one.meta, icon: RunovaIcons.history, iconTone: .neutral) {
                onUse(one.promptType, one.targetAi, one.content, one.rawInput)
            }
        }
    }

    @ViewBuilder private var scheduled: some View {
        if screen.scheduled.isEmpty { note("Nothing is waiting in this project.") }
        ForEach(screen.scheduled, id: \.id) { one in
            HStack(spacing: 8) {
                RunovaListRow(title: one.summary, detail: one.whenLabel, icon: RunovaIcons.clock, flat: true)
                RunovaChip(text: "Cancel", icon: RunovaIcons.close, tone: .danger) { intents.cancelScheduled(one.id) }
            }
            .padding(.trailing, 12)
            .rowCard()
        }
        RunovaText(
            "Scheduled prompts start only while Runova is running on this computer.", style: RunovaType.small,
            color: palette.mutedForeground)
    }

    private func note(_ text: String) -> some View {
        RunovaText(text, color: palette.mutedForeground).padding(.vertical, 12)
    }
}

private struct ChipRow: View {
    let items: [String]
    let selected: String
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.self) { item in
                    RunovaChip(text: item, tone: item == selected ? .primary : .soft) { onPick(item) }
                }
            }
        }
    }
}
