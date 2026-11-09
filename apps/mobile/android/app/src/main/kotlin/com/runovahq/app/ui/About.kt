package com.runovahq.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.runovahq.app.R
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import java.util.Calendar

private const val WEBSITE_URL = "https://runovahq.com"
private const val SOURCE_URL = "https://github.com/SmartClouds/Runova"
private const val SMARTCLOUDS_URL = "https://smartclouds.co"

/** About Runova, drawn as the desktop's dialog is: lit from behind, with the maker's credit at the foot. */
@Composable
fun AboutSheet(version: String, onClose: () -> Unit, year: Int = Calendar.getInstance().get(Calendar.YEAR)) {
    val colors = RunovaTheme.colors
    val links = LocalUriHandler.current
    val shape = RoundedCornerShape(20.dp)
    BackHandler(onBack = onClose)
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.62f))
            .clickable(interactionSource = null, indication = null, onClick = onClose),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .padding(16.dp)
                .fillMaxWidth()
                .clip(shape)
                .background(colors.popover)
                .border(1.dp, colors.foreground.copy(alpha = 0.1f), shape)
                .clickable(interactionSource = null, indication = null) {}
                .verticalScroll(rememberScrollState()),
        ) {
            Box {
                Canvas(Modifier.matchParentSize()) {
                    drawRect(
                        Brush.radialGradient(
                            listOf(colors.primary.copy(alpha = 0.24f), Color.Transparent),
                            Offset(size.width / 2, 92.dp.toPx()),
                            size.width * 0.62f,
                        ),
                    )
                }
                Column(
                    Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 32.dp, bottom = 22.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    RunovaLogo(88.dp)
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaText("Runova", style = RunovaType.heading)
                        VersionChip(version)
                    }
                    Spacer(Modifier.height(14.dp))
                    Paragraph(
                        "Runova is an Agentic Development Environment (ADE) for AI coding agents. " +
                            "This app keeps your computers, terminals, git and deployments within reach.",
                    )
                    Spacer(Modifier.height(8.dp))
                    Paragraph(
                        "The name joins two words: a runway, where launches happen, and a nova, a new star. " +
                            "Your ideas take off here.",
                    )
                    Spacer(Modifier.height(8.dp))
                    RunovaText(
                        "It's free and open source under the MIT license.",
                        style = RunovaType.small,
                        color = colors.foreground.copy(alpha = 0.82f),
                        align = TextAlign.Center,
                    )
                    Spacer(Modifier.height(20.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaButton(
                            "Website",
                            onClick = { links.openUri(WEBSITE_URL) },
                            Modifier.weight(1f),
                            kind = ButtonKind.Soft,
                            icon = RunovaIcons.Globe,
                        )
                        RunovaButton(
                            "Source",
                            onClick = { links.openUri(SOURCE_URL) },
                            Modifier.weight(1f),
                            kind = ButtonKind.Soft,
                            icon = RunovaIcons.Code,
                        )
                    }
                    Spacer(Modifier.height(18.dp))
                    RunovaText(
                        "Runova is built and maintained by SmartClouds.",
                        style = RunovaType.small,
                        color = colors.mutedForeground,
                        align = TextAlign.Center,
                    )
                }
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(colors.foreground.copy(alpha = 0.05f))
                        .clickable(role = Role.Button, onClick = onClose)
                        .semantics { contentDescription = "Close" },
                    contentAlignment = Alignment.Center,
                ) {
                    RunovaIcon(RunovaIcons.Close, size = 14.dp, color = colors.mutedForeground)
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(colors.foreground.copy(alpha = 0.08f)))
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) { links.openUri(SMARTCLOUDS_URL) }
                    .padding(horizontal = 18.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Image(painterResource(R.drawable.smartclouds_logo), null, Modifier.size(45.dp, 24.dp))
                Column(Modifier.weight(1f)) {
                    RunovaSectionTitle("A product of")
                    RunovaText("SmartClouds", style = RunovaType.labelStrong)
                }
                RunovaText("© $year", style = RunovaType.small, color = colors.mutedForeground)
            }
        }
    }
}

@Composable
private fun VersionChip(version: String) {
    val colors = RunovaTheme.colors
    RunovaText(
        "v$version",
        Modifier
            .clip(CircleShape)
            .background(colors.primary.copy(alpha = 0.13f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
        RunovaType.caption,
        colors.primary,
    )
}

@Composable
private fun Paragraph(text: String) {
    RunovaText(text, style = RunovaType.small, color = RunovaTheme.colors.mutedForeground, align = TextAlign.Center)
}
