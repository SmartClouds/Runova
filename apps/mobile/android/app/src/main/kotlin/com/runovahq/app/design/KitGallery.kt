package com.runovahq.app.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

val GalleryTabs = listOf(
    TabItem("systems", "Systems", RunovaIcons.Systems),
    TabItem("activity", "Activity", RunovaIcons.Monitoring),
    TabItem("alerts", "Alerts", RunovaIcons.Notifications),
    TabItem("account", "Account", RunovaIcons.Account),
)

/** Every kit component in fixed states. `KitGallery.swift` lays out the same thing. */
@Composable
fun KitGallery() {
    val colors = RunovaTheme.colors
    Column(Modifier.fillMaxSize().background(colors.background)) {
        RunovaTopBar(title = "Kit", onBack = {})
        Column(
            Modifier.weight(1f).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaButton("Connect", onClick = {}, icon = RunovaIcons.Check)
                RunovaButton("Later", onClick = {}, kind = ButtonKind.Soft)
                RunovaButton("Remove", onClick = {}, kind = ButtonKind.Danger)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaBadge("Online", BadgeTone.Success)
                RunovaBadge("Direct", BadgeTone.Primary)
                RunovaBadge("Relay", BadgeTone.Warning)
                RunovaBadge("Failed", BadgeTone.Danger)
                RunovaBadge("Idle")
            }
            RunovaCard(Modifier.fillMaxWidth(), padding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                Column {
                    RunovaListRow("Sam's desk", detail = "Windows, online", icon = RunovaIcons.Systems, onClick = {})
                    RunovaListRow("Build server", detail = "Linux, offline", icon = RunovaIcons.Server, onClick = {})
                }
            }
            RunovaTextField(value = "", onValueChange = {}, placeholder = "Search projects")
            RunovaTextField(value = "runova-link", onValueChange = {}, placeholder = "")
            RunovaSkeleton(Modifier.width(180.dp))
            RunovaEmptyState(RunovaIcons.Folder, "No projects yet", "Add one on your computer.")
        }
        RunovaBottomBar(GalleryTabs, selected = "systems", onSelect = {})
    }
}
