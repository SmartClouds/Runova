package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaShape
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.NotificationDestination
import uniffi.runova_ffi.NotificationItemView
import uniffi.runova_ffi.NotificationsScreen

data class NotificationIntents(
    val open: (Long) -> Unit = {},
    val dismissBanner: () -> Unit = {},
    val markAllRead: () -> Unit = {},
    val openSettings: () -> Unit = {},
    val closeSettings: () -> Unit = {},
    val setEnabled: (String, Boolean) -> Unit = { _, _ -> },
)

/** Which tab a notification opens, which depends on whether a computer is open. */
fun tabFor(destination: NotificationDestination, connected: Boolean): String = when (destination) {
    NotificationDestination.MONITORS -> if (connected) "monitoring" else "monitors"
    NotificationDestination.ACCOUNT -> if (connected) "notifications" else "account"
    NotificationDestination.INBOX -> if (connected) "notifications" else "inbox"
}

private fun isConnected(view: AppView) = view.connection != null

@Composable
fun InboxTab(view: AppView, intents: NotificationIntents, onTab: (String) -> Unit, showTitle: Boolean = true) {
    val screen = view.notifications
    if (screen.settingsOpen) {
        NotificationSettings(screen, intents)
        return
    }
    if (showTitle) {
        RunovaScreen(
            "Inbox",
            trailing = {
                RunovaChip("Settings", intents.openSettings, Modifier.padding(end = 8.dp), icon = RunovaIcons.Settings)
            },
        ) { InboxBody(view, intents, onTab) }
    } else {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.End) {
                RunovaChip("Settings", intents.openSettings, icon = RunovaIcons.Settings)
            }
            InboxBody(view, intents, onTab)
        }
    }
}

@Composable
private fun InboxBody(view: AppView, intents: NotificationIntents, onTab: (String) -> Unit) {
    val screen = view.notifications
    Column(Modifier.fillMaxSize()) {
        when {
            screen.items.isEmpty() && screen.loading -> LoadingRows()
            screen.items.isEmpty() -> RunovaEmptyState(
                RunovaIcons.Notifications,
                "Nothing new",
                "What needs you shows up here.",
            )
            else -> LazyColumn(contentPadding = PaddingValues(16.dp)) {
                if (screen.unread > 0u) {
                    item(key = "mark") {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            RunovaChip("Mark all read", intents.markAllRead, icon = RunovaIcons.DoneAll)
                        }
                    }
                }
                items(screen.items, key = { it.id }) { item ->
                    RunovaListRow(
                        title = item.title,
                        detail = item.body.ifEmpty { null },
                        icon = RunovaIcons.Notifications,
                        iconTone = if (item.read) BadgeTone.Neutral else BadgeTone.Primary,
                        onClick = {
                            intents.open(item.id)
                            onTab(tabFor(item.destination, isConnected(view)))
                        },
                        trailing = { if (!item.read) RunovaBadge("New", BadgeTone.Primary) },
                    )
                }
            }
        }
    }
}

@Composable
private fun NotificationSettings(screen: NotificationsScreen, intents: NotificationIntents) {
    RunovaScreen("Notifications", onBack = intents.closeSettings) {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(screen.preferences, key = { it.category }) { preference ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RunovaText(preference.label, Modifier.weight(1f))
                    RunovaToggle(
                        preference.enabled,
                        { intents.setEnabled(preference.category, it) },
                        preference.label,
                    )
                }
            }
        }
    }
}

/** One that just arrived, over whatever is on screen. */
@Composable
fun NotificationBanner(item: NotificationItemView, connected: Boolean, intents: NotificationIntents, onTab: (String) -> Unit) {
    val colors = RunovaTheme.colors
    Box(Modifier.fillMaxWidth().padding(12.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(RunovaShape.lg))
                .background(colors.popover)
                .border(1.dp, colors.primary.copy(alpha = 0.35f), RoundedCornerShape(RunovaShape.lg))
                .clickable(role = Role.Button) {
                    intents.open(item.id)
                    onTab(tabFor(item.destination, connected))
                }
                .padding(start = 14.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            RunovaIcon(RunovaIcons.Notifications, color = colors.primary)
            RunovaText(item.title, Modifier.weight(1f), maxLines = 2)
            Box(
                Modifier
                    .size(44.dp)
                    .clickable(role = Role.Button, onClick = intents.dismissBanner)
                    .semantics { contentDescription = "Dismiss" },
                contentAlignment = Alignment.Center,
            ) { RunovaIcon(RunovaIcons.Close, color = colors.mutedForeground) }
        }
    }
}
