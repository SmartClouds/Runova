package com.runovahq.app.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun RunovaText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = RunovaType.body,
    color: Color = RunovaTheme.colors.foreground,
    maxLines: Int = Int.MAX_VALUE,
    align: TextAlign = TextAlign.Start,
) {
    BasicText(
        text = text,
        modifier = modifier,
        style = style.copy(color = color, textAlign = align),
        maxLines = maxLines,
        overflow = if (maxLines == Int.MAX_VALUE) TextOverflow.Clip else TextOverflow.Ellipsis,
    )
}

/** One glyph from the bundled icon font. Without a label it is decoration. */
@Composable
fun RunovaIcon(
    glyph: String,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    color: Color = RunovaTheme.colors.foreground,
    label: String? = null,
) {
    val described = if (label != null) modifier.semantics { contentDescription = label } else modifier
    Box(described.size(size), contentAlignment = Alignment.Center) {
        BasicText(
            text = glyph,
            style = TextStyle(
                fontFamily = IconFamily,
                fontSize = (size.value * 0.875f).sp,
                lineHeight = size.value.sp,
                color = color,
                textAlign = TextAlign.Center,
            ),
        )
    }
}

enum class ButtonKind { Primary, Soft, Ghost, Danger }

/** A pill, as the desktop's default buttons are. */
@Composable
fun RunovaButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.Primary,
    enabled: Boolean = true,
    icon: String? = null,
) {
    val colors = RunovaTheme.colors
    val (fill, ink) = when (kind) {
        ButtonKind.Primary -> colors.primary to colors.primaryForeground
        ButtonKind.Soft -> colors.secondary to colors.secondaryForeground
        ButtonKind.Ghost -> Color.Transparent to colors.foreground
        ButtonKind.Danger -> colors.destructive to colors.destructiveForeground
    }
    Row(
        modifier = modifier
            .heightIn(min = 44.dp)
            .clip(CircleShape)
            .background(if (enabled) fill else fill.copy(alpha = 0.5f))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        if (icon != null) RunovaIcon(icon, size = 14.dp, color = ink)
        RunovaText(text, style = RunovaType.label, color = ink, maxLines = 1)
    }
}

@Composable
fun RunovaCard(
    modifier: Modifier = Modifier,
    padding: PaddingValues = PaddingValues(16.dp),
    content: @Composable () -> Unit,
) {
    Box(
        modifier
            .clip(RoundedCornerShape(RunovaShape.lg))
            .background(RunovaTheme.colors.card)
            .padding(padding),
    ) { content() }
}

enum class BadgeTone { Neutral, Primary, Success, Warning, Danger }

@Composable
fun RunovaBadge(text: String, tone: BadgeTone = BadgeTone.Neutral, modifier: Modifier = Modifier) {
    val colors = RunovaTheme.colors
    val ink = when (tone) {
        BadgeTone.Neutral -> colors.mutedForeground
        BadgeTone.Primary -> colors.primary
        BadgeTone.Success -> colors.success
        BadgeTone.Warning -> colors.warning
        BadgeTone.Danger -> colors.destructive
    }
    val fill = if (tone == BadgeTone.Neutral) colors.secondary else ink.copy(alpha = 0.15f)
    Box(
        modifier.clip(CircleShape).background(fill).padding(horizontal = 8.dp, vertical = 3.dp),
    ) { RunovaText(text, style = RunovaType.caption, color = ink, maxLines = 1) }
}

/** A row that opens something: icon, title, optional detail, and what is at the end. */
@Composable
fun RunovaListRow(
    title: String,
    modifier: Modifier = Modifier,
    detail: String? = null,
    icon: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = RunovaTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val base = modifier.fillMaxWidth().heightIn(min = 56.dp)
    val tappable = if (onClick != null) {
        base.clickable(interaction, null, role = Role.Button, onClick = onClick)
    } else {
        base
    }
    Row(
        tappable.padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) {
            Box(
                Modifier.size(36.dp)
                    .clip(RoundedCornerShape(RunovaShape.md))
                    .background(colors.secondary),
                contentAlignment = Alignment.Center,
            ) { RunovaIcon(icon, color = colors.secondaryForeground) }
        }
        Column(Modifier.weight(1f)) {
            RunovaText(title, style = RunovaType.label, maxLines = 1)
            if (detail != null) {
                RunovaText(
                    detail,
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                    maxLines = 1,
                )
            }
        }
        trailing?.invoke()
        if (onClick != null && trailing == null) {
            RunovaIcon(RunovaIcons.Forward, size = 12.dp, color = colors.mutedForeground)
        }
    }
}

@Composable
fun RunovaTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
) {
    val colors = RunovaTheme.colors
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = RunovaType.body.copy(color = colors.foreground),
        cursorBrush = SolidColor(colors.primary),
        modifier = modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(RunovaShape.md))
            .background(colors.secondary)
            .border(1.dp, colors.input, RoundedCornerShape(RunovaShape.md)),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) {
                    RunovaText(placeholder, color = colors.mutedForeground, maxLines = 1)
                }
                inner()
            }
        },
    )
}

@Composable
fun RunovaTopBar(title: String, onBack: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            Box(
                Modifier.size(44.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onBack)
                    .semantics { contentDescription = "Back" },
                contentAlignment = Alignment.Center,
            ) { RunovaIcon(RunovaIcons.Back, color = colors.foreground) }
        } else {
            Box(Modifier.size(8.dp))
        }
        RunovaText(title, Modifier.weight(1f), RunovaType.heading, maxLines = 1)
        trailing?.invoke()
    }
}

data class TabItem(val id: String, val title: String, val icon: String)

@Composable
fun RunovaBottomBar(tabs: List<TabItem>, selected: String, onSelect: (String) -> Unit) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().height(60.dp).background(colors.card),
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        for (tab in tabs) {
            val on = tab.id == selected
            val ink = if (on) colors.primary else colors.mutedForeground
            Column(
                Modifier.weight(1f)
                    .height(60.dp)
                    .clickable(role = Role.Tab) { onSelect(tab.id) },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                RunovaIcon(tab.icon, size = 18.dp, color = ink)
                RunovaText(tab.title, style = RunovaType.caption, color = ink, maxLines = 1)
            }
        }
    }
}

@Composable
fun RunovaEmptyState(icon: String, title: String, detail: String, modifier: Modifier = Modifier) {
    val colors = RunovaTheme.colors
    Column(
        modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RunovaIcon(icon, size = 28.dp, color = colors.mutedForeground)
        RunovaText(title, style = RunovaType.title, align = TextAlign.Center)
        RunovaText(detail, color = colors.mutedForeground, align = TextAlign.Center)
    }
}

/** Where content will be while it loads. */
@Composable
fun RunovaSkeleton(modifier: Modifier = Modifier) {
    Box(
        modifier
            .height(14.dp)
            .clip(RoundedCornerShape(RunovaShape.sm))
            .background(RunovaTheme.colors.muted),
    )
}
