package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTokens
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.DiffLineKind
import uniffi.runova_ffi.DiffLineView
import uniffi.runova_ffi.GitBranchView
import uniffi.runova_ffi.GitDiffView
import uniffi.runova_ffi.GitFileView
import uniffi.runova_ffi.GitGroup
import uniffi.runova_ffi.GitScreen
import uniffi.runova_ffi.GitStashView
import uniffi.runova_ffi.GitStateView

/** What the git screens can ask for. */
data class GitIntents(
    val openDiff: (String, GitGroup) -> Unit = { _, _ -> },
    val closeDiff: () -> Unit = {},
    val openBranches: () -> Unit = {},
    val closeBranches: () -> Unit = {},
    val stage: (List<String>) -> Unit = {},
    val unstage: (List<String>) -> Unit = {},
    val discard: (String, GitGroup) -> Unit = { _, _ -> },
    val commit: (String, Boolean) -> Unit = { _, _ -> },
    val fetch: () -> Unit = {},
    val pull: () -> Unit = {},
    val push: () -> Unit = {},
    val checkout: (String) -> Unit = {},
    val createBranch: (String) -> Unit = {},
    val deleteBranch: (String) -> Unit = {},
    val stashPush: (String?) -> Unit = {},
    val stashPop: (String) -> Unit = {},
    val stashDrop: (String) -> Unit = {},
    val resolve: (String, String) -> Unit = { _, _ -> },
    val abort: () -> Unit = {},
)

private val GroupTitles = listOf(
    GitGroup.CONFLICT to "Conflicts",
    GitGroup.STAGED to "Staged",
    GitGroup.UNSTAGED to "Changes",
    GitGroup.UNTRACKED to "Untracked",
)

private fun aheadBehind(state: GitStateView): String? = when {
    state.upstream == null -> null
    state.ahead == 0u && state.behind == 0u -> "Up to date"
    else -> "${state.ahead} ahead, ${state.behind} behind"
}

private fun changeDetail(file: GitFileView): String? = when {
    file.conflict != null -> "In conflict"
    file.binary -> "Binary file"
    file.additions != null || file.deletions != null -> "+${file.additions ?: 0u} -${file.deletions ?: 0u}"
    else -> null
}

/** A sub-screen of git that replaces the whole device screen, or null for the normal tabs. */
@Composable
fun GitOverlay(view: AppView, intents: AppIntents): Boolean {
    val diff = view.git.diff
    if (diff != null) {
        DiffScreen(diff, intents.git)
        return true
    }
    if (view.git.branchesOpen) {
        BranchesScreen(view.git, intents.git)
        return true
    }
    return false
}

@Composable
fun GitChangesScreen(view: AppView, intents: GitIntents) {
    val state = view.git.state
    when {
        view.selectedProject == null -> RunovaEmptyState(
            RunovaIcons.Git,
            "Choose a project",
            "Pick one in Projects to see its changes.",
        )
        state == null && view.git.loading -> LoadingRows()
        state == null -> RunovaEmptyState(RunovaIcons.Git, "No changes to show", "Nothing has loaded yet.")
        !state.isRepo -> RunovaEmptyState(
            RunovaIcons.Git,
            "Not a git repository",
            "This project's folder isn't tracked by git.",
        )
        else -> LoadedChanges(state, intents)
    }
}

@Composable
private fun LoadedChanges(state: GitStateView, intents: GitIntents) {
    val colors = RunovaTheme.colors
    val staged = state.files.any { it.group == GitGroup.STAGED }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            item { BranchCard(state, intents) }
            state.operation?.let { operation ->
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RunovaIcon(RunovaIcons.Warning, size = 14.dp, color = colors.warning)
                        RunovaText("A $operation is in progress", Modifier.weight(1f).padding(start = 8.dp))
                        RunovaChip("Stop", intents.abort)
                    }
                }
            }
            GroupTitles.forEach { (group, title) ->
                val entries = state.files.filter { it.group == group }
                if (entries.isNotEmpty()) {
                    item(key = title) {
                        RunovaText(title, Modifier.padding(top = 12.dp, bottom = 4.dp), RunovaType.caption, colors.mutedForeground)
                    }
                    items(entries, key = { "$title/${it.path}" }) { FileRow(it, intents) }
                }
            }
            if (state.files.isEmpty()) {
                item {
                    RunovaText("Nothing to commit", Modifier.padding(top = 24.dp), color = colors.mutedForeground)
                }
            }
        }
        if (staged) CommitBox(intents)
    }
}

@Composable
private fun BranchCard(state: GitStateView, intents: GitIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RunovaChip(state.branch ?: "Detached", intents.openBranches)
                aheadBehind(state)?.let {
                    RunovaText(it, Modifier.padding(start = 10.dp), RunovaType.small, colors.mutedForeground)
                }
            }
            if (state.hasRemote) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    RunovaChip("Fetch", intents.fetch)
                    RunovaChip("Pull", intents.pull)
                    RunovaChip("Push", intents.push)
                }
            }
        }
    }
}

@Composable
private fun FileRow(file: GitFileView, intents: GitIntents) {
    val conflict = file.group == GitGroup.CONFLICT
    RunovaListRow(
        title = file.path,
        detail = changeDetail(file),
        icon = RunovaIcons.Folder,
        onClick = if (conflict) null else ({ intents.openDiff(file.path, file.group) }),
        trailing = {
            when (file.group) {
                GitGroup.CONFLICT -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    RunovaChip("Mine", { intents.resolve(file.path, "ours") })
                    RunovaChip("Theirs", { intents.resolve(file.path, "theirs") })
                }
                GitGroup.STAGED -> RunovaChip("Unstage", { intents.unstage(listOf(file.path)) })
                GitGroup.UNSTAGED -> RunovaChip("Stage", { intents.stage(listOf(file.path)) })
                GitGroup.UNTRACKED -> RunovaChip("Add", { intents.stage(listOf(file.path)) })
            }
        },
    )
}

@Composable
private fun CommitBox(intents: GitIntents) {
    var message by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        RunovaTextField(message, { message = it }, "Commit message")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaButton(
                "Commit",
                onClick = {
                    intents.commit(message, false)
                    message = ""
                },
                Modifier.weight(1f),
                kind = ButtonKind.Soft,
                enabled = message.isNotBlank(),
            )
            RunovaButton(
                "Commit and push",
                onClick = {
                    intents.commit(message, true)
                    message = ""
                },
                Modifier.weight(1f),
                enabled = message.isNotBlank(),
            )
        }
    }
}

@Composable
private fun DiffScreen(diff: GitDiffView, intents: GitIntents) {
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(diff.path, onBack = intents.closeDiff)
        Row(Modifier.padding(start = 16.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            when (diff.group) {
                GitGroup.STAGED -> RunovaChip("Unstage", { intents.unstage(listOf(diff.path)) })
                GitGroup.UNSTAGED, GitGroup.UNTRACKED -> {
                    RunovaChip("Stage", { intents.stage(listOf(diff.path)) })
                    RunovaChip("Discard", { intents.discard(diff.path, diff.group) })
                }
                GitGroup.CONFLICT -> {}
            }
        }
        when {
            diff.loading -> LoadingRows()
            diff.tooLarge -> RunovaEmptyState(
                RunovaIcons.Warning,
                "Too large to show on a phone",
                "Open it in Runova on the computer.",
            )
            diff.binary -> RunovaEmptyState(RunovaIcons.Warning, "Binary file", "There's no text to compare.")
            diff.lines.isEmpty() -> RunovaEmptyState(RunovaIcons.Check, "No differences", "")
            else -> LazyColumn(Modifier.fillMaxSize().background(RunovaTokens.Terminal.background)) {
                items(diff.lines) { DiffLine(it) }
            }
        }
    }
}

@Composable
private fun DiffLine(line: DiffLineView) {
    val theme = RunovaTokens.Terminal
    val (fill, ink) = when (line.kind) {
        DiffLineKind.ADDED -> theme.green.copy(alpha = 0.16f) to theme.foreground
        DiffLineKind.REMOVED -> theme.red.copy(alpha = 0.16f) to theme.foreground
        DiffLineKind.HUNK -> Color.Transparent to theme.brightBlack
        DiffLineKind.CONTEXT -> Color.Transparent to theme.foreground
    }
    BasicText(
        line.text,
        Modifier.fillMaxWidth().background(fill).padding(horizontal = 10.dp, vertical = 1.dp),
        style = RunovaType.mono.copy(color = ink),
    )
}

@Composable
private fun BranchesScreen(git: GitScreen, intents: GitIntents) {
    val colors = RunovaTheme.colors
    var name by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar("Branches", onBack = intents.closeBranches)
        Row(
            Modifier.padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RunovaTextField(name, { name = it }, "New branch name", Modifier.weight(1f))
            RunovaButton(
                "Create",
                onClick = {
                    intents.createBranch(name)
                    name = ""
                },
                enabled = name.isNotBlank(),
            )
        }
        LazyColumn(contentPadding = PaddingValues(16.dp)) {
            items(git.branches, key = { "b/${it.name}" }) { BranchRow(it, intents) }
            item(key = "stash-title") {
                Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    RunovaText("Stashes", Modifier.weight(1f), RunovaType.caption, colors.mutedForeground)
                    RunovaChip("Stash changes", { intents.stashPush(null) })
                }
            }
            items(git.stashes, key = { "s/${it.reference}" }) { StashRow(it, intents) }
        }
    }
}

@Composable
private fun BranchRow(branch: GitBranchView, intents: GitIntents) {
    RunovaListRow(
        title = branch.name,
        detail = if (branch.local) null else "On the remote",
        icon = RunovaIcons.Git,
        onClick = if (branch.current) null else ({ intents.checkout(branch.name) }),
        trailing = {
            when {
                branch.current -> RunovaBadge("Current")
                branch.local -> RunovaChip("Delete", { intents.deleteBranch(branch.name) })
                else -> Box {}
            }
        },
    )
}

@Composable
private fun StashRow(stash: GitStashView, intents: GitIntents) {
    RunovaListRow(
        title = stash.message,
        detail = stash.reference,
        icon = RunovaIcons.Folder,
        trailing = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                RunovaChip("Pop", { intents.stashPop(stash.reference) })
                RunovaChip("Drop", { intents.stashDrop(stash.reference) })
            }
        },
    )
}
