import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `TasksTest.kt`, for the comparison with Android (E124).
@MainActor
final class TasksTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: "483921", direct: true, error: nil)
    private let project = ProjectView(
        id: "p1", name: "Northwind shop", tags: [], pinned: true, hasRepository: true, iconBgColor: nil,
        iconColor: nil)

    private func row(_ id: String, _ title: String, _ status: String, _ label: String) -> TaskRowView {
        TaskRowView(id: id, title: title, status: status, statusLabel: label, meta: "P1 · M001 · 1 of 3 criteria")
    }

    private var overview: TasksOverviewView {
        TasksOverviewView(
            exists: true, title: "Gift cards at checkout", modeLabel: "Plan mode, no context budget",
            goal: "Shoppers pay with a gift card.", progressLabel: "3 of 7 tasks done", percent: 43,
            countsLabel: "2 to do, 1 in progress, 1 blocked",
            milestones: [
                TaskMilestoneView(
                    id: "M001", title: "Pay with a card", status: "active", target: "2026-12-12", label: "3 of 4 done",
                    percent: 75)
            ],
            needsYou: [row("T005", "Split a payment", "blocked", "Blocked")],
            questions: [TaskRefView(id: "Q001", title: "Can a gift card pay for shipping?")],
            recordsLabel: "1 open workaround, 2 open risks",
            run: TaskRunView(label: "Running T004", canPause: true, canResume: false), canStart: false)
    }

    private var detail: TaskDetailView {
        TaskDetailView(
            row: row("T004", "Show the new total", "testing", "Testing"), priority: "p1", size: "m",
            milestone: "M001", due: nil, attemptLabel: "Attempt 2",
            sections: [TaskSectionView(heading: "Goal", text: "The summary shows what the card paid.")],
            acceptance: [
                TaskCheckView(index: 0, text: "Shows the new total", checked: true),
                TaskCheckView(index: 1, text: "Removing the card puts it back", checked: false),
            ],
            handoff: TaskHandoffView(
                summary: "Carries on, tests passed, session 1",
                sections: [TaskSectionView(heading: "Next step", text: "Put the old total back.")]),
            journal: [
                TaskJournalView(heading: "2026-11-28 09:30 session 1", lines: ["Result: continue", "Tests: passed"])
            ],
            body: "## Goal\n\nThe summary shows what the card paid.\n",
            moves: [TaskMoveView(status: "todo", label: "To do"), TaskMoveView(status: "done", label: "Done")])
    }

    private func screen(detail: TaskDetailView? = nil, split: TaskSplitView? = nil) -> TasksScreen {
        TasksScreen(
            overview: overview,
            tasks: [row("T001", "Gift card field", "done", "Done"), row("T005", "Split a payment", "blocked", "Blocked")],
            loading: false, openTask: detail?.row.id, detail: detail, recordsKind: nil, records: [],
            split: split ?? noTasks.split)
    }

    private func onTasks(_ tasks: TasksScreen) -> AppView {
        appView(connection: connected, projects: [project], selected: "p1", tasks: tasks)
    }

    func testOverviewSnapshot() throws {
        try renderSnapshot(onTasks(screen()), "tasks-overview", tab: "tasks")
    }

    func testDetailSnapshot() throws {
        try renderSnapshot(onTasks(screen(detail: detail)), "tasks-detail", tab: "tasks")
    }

    func testTheDetailDrawsOverTheTabs() {
        let view = onTasks(screen(detail: detail))
        XCTAssertEqual(view.tasks.detail?.row.id, "T004")
        XCTAssertEqual(view.tasks.openTask, "T004")
        XCTAssertFalse(view.tasks.detail?.moves.contains { $0.status == "testing" } ?? true)
    }

    func testIntentsCarryWhatTheScreensSend() {
        var redone: (String, String?, Bool)?
        var split: (String, Bool)?
        let intents = TaskIntents(
            redo: { redone = ($0, $1, $2) },
            split: { split = ($0, $1) })
        intents.redo("T004", nil, false)
        intents.split("Gift card balance", true)
        XCTAssertEqual(redone?.0, "T004")
        XCTAssertEqual(redone?.2, false)
        XCTAssertEqual(split?.0, "Gift card balance")
        XCTAssertEqual(split?.1, true)
    }
}
