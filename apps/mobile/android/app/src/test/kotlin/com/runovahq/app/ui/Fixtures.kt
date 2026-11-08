package com.runovahq.app.ui

import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ConfirmView
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.GitScreen
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.StatusScreen
import uniffi.runova_ffi.SystemView
import uniffi.runova_ffi.TerminalItem
import uniffi.runova_ffi.TerminalProcessView
import uniffi.runova_ffi.TerminalView

val emptyGit = GitScreen(null, false, null, false, emptyList(), emptyList())
val emptyStatus = StatusScreen(null, false, emptyList(), emptyList(), null)

/** One place to build what the core publishes, so a new screen changes only this function. */
fun appView(
    auth: AuthState = AuthState.SIGNED_IN,
    systems: List<SystemView> = emptyList(),
    connection: ConnectionView? = null,
    projects: List<ProjectView> = emptyList(),
    projectsLoading: Boolean = false,
    selected: String? = null,
    terminals: List<TerminalItem> = emptyList(),
    terminal: TerminalView? = null,
    processes: List<TerminalProcessView> = emptyList(),
    git: GitScreen = emptyGit,
    status: StatusScreen = emptyStatus,
    notice: String? = null,
    confirm: ConfirmView? = null,
    error: String? = null,
) = AppView(
    auth,
    true,
    systems,
    false,
    connection,
    projects,
    projectsLoading,
    selected,
    terminals,
    false,
    terminal,
    processes,
    git,
    status,
    false,
    notice,
    confirm,
    error,
)
