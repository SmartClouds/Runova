import SwiftUI
import UIKit

struct PromptIntents {
    var generate: (String, String, String) -> Void = { _, _, _ in }
    var cancel: () -> Void = {}
    var taken: () -> Void = {}
    var send: (String, String?) -> Void = { _, _ in }
}

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

    var body: some View {
        if let session = sessions.first(where: { $0.workflowId == workflow.id }) {
            AutoFixPanel(session: session, intents: intents)
        } else if let run = workflow.run, run.state == .running || run.state == .queued || run.state == .failed {
            HStack(spacing: 6) {
                if run.state == .failed {
                    RunovaChip(text: "Fix with AI", icon: RunovaIcons.sparkles, tone: .primary) {
                        intents.fixWithAi(workflow.id)
                    }
                }
                RunovaChip(text: "Auto-fix", icon: RunovaIcons.wand) { intents.autoFixStart(workflow.id) }
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

private struct PromptsForm: View {
    let view: AppView
    let options: PromptOptionsView
    let intents: PromptIntents

    @State private var request = ""
    @State private var type: String?
    @State private var target: String?
    @State private var prompt = ""
    @Environment(\.palette) private var palette

    private var pickedType: String { type ?? options.types.first(where: { $0 == "Bug Fix" }) ?? options.types.first ?? "" }
    private var pickedTarget: String { target ?? options.defaultTarget ?? options.targets.first?.name ?? "" }
    private var blank: Bool { request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        let screen = view.prompts
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                RunovaSectionTitle(text: "What do you want done?")
                RunovaTextArea(value: $request, placeholder: "Describe the job in your own words", minHeight: 84)
                RunovaSectionTitle(text: "Kind of prompt").padding(.top, 6)
                ChipRow(items: options.types, selected: pickedType) { type = $0 }
                RunovaSectionTitle(text: "Written for").padding(.top, 6)
                ChipRow(items: options.targets.map(\.name), selected: pickedTarget) { target = $0 }
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
                if !prompt.isEmpty {
                    RunovaSectionTitle(text: "Your prompt").padding(.top, 6)
                    RunovaTextArea(value: $prompt, placeholder: "Your prompt", minHeight: 160)
                    HStack(spacing: 8) {
                        RunovaButton(text: "Copy", kind: .soft, icon: RunovaIcons.copy) {
                            UIPasteboard.general.string = prompt
                        }
                        .frame(maxWidth: .infinity)
                        RunovaButton(text: "Send to agent", enabled: view.selectedProject != nil, icon: RunovaIcons.send) {
                            intents.send(prompt, options.targets.first(where: { $0.name == pickedTarget })?.id)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    if view.selectedProject == nil {
                        RunovaText(
                            "Choose a project to send it to an agent.", style: RunovaType.small,
                            color: palette.mutedForeground)
                    }
                }
            }
            .padding(16)
        }
        .onChange(of: screen.result) { result in
            guard let result else { return }
            prompt = result
            intents.taken()
        }
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
