package com.runovahq.app.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * Drawn from the desktop's own rules in index.css and the page kit: content on a rounded island
 * inside darker chrome, glass cards with a bright top edge, pill fields and buttons with a hairline
 * washed from the foreground, tinted icon tiles, and a soft glow on what matters most.
 */

private val CardShape = RoundedCornerShape(RunovaShape.lg + 2.dp)
private val TileShape = RoundedCornerShape(12.dp)

@Composable
private fun isDark() = RunovaTheme.colors.background.luminance() < 0.5f

/** The desktop's `.glass`: a see-through card whose top edge catches the light. */
@Composable
fun Modifier.runovaGlass(shape: Shape = CardShape): Modifier {
    val colors = RunovaTheme.colors
    val edge = Brush.verticalGradient(
        listOf(
            if (isDark()) colors.foreground.copy(alpha = 0.17f) else Color.White.copy(alpha = 0.9f),
            colors.foreground.copy(alpha = if (isDark()) 0.09f else 0.08f),
        ),
    )
    return this.clip(shape).background(colors.card.copy(alpha = if (isDark()) 0.55f else 0.6f)).border(1.dp, edge, shape)
}

/** The desktop's `.search-pill` and `.field-surface` wash and hairline. */
@Composable
private fun Modifier.softSurface(shape: Shape): Modifier {
    val colors = RunovaTheme.colors
    return this.clip(shape)
        .background(colors.foreground.copy(alpha = 0.05f))
        .border(1.dp, colors.foreground.copy(alpha = 0.08f), shape)
}

/** A soft light around something, drawn in layers so both apps paint exactly the same. */
private fun Modifier.glow(color: Color, corner: Dp? = null): Modifier = drawBehind {
    val layers = listOf(8.dp.toPx() to 0.06f, 5.dp.toPx() to 0.09f, 2.5.dp.toPx() to 0.14f)
    for ((grow, alpha) in layers) {
        val radius = (corner?.toPx() ?: (size.height / 2)) + grow
        drawRoundRect(
            color = color.copy(alpha = alpha),
            topLeft = Offset(-grow, -grow),
            size = Size(size.width + grow * 2, size.height + grow * 2),
            cornerRadius = CornerRadius(radius),
        )
    }
}

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

enum class ButtonKind { Primary, Soft, Ghost, Danger, Tint }

/** A pill, as the desktop's buttons are. Only the main action has weight and a glow. */
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
    val ink = when (kind) {
        ButtonKind.Primary -> colors.primaryForeground
        ButtonKind.Soft, ButtonKind.Ghost -> colors.foreground.copy(alpha = 0.88f)
        ButtonKind.Danger -> colors.destructive
        ButtonKind.Tint -> colors.primary
    }
    val base = if (kind == ButtonKind.Primary && enabled) modifier.glow(colors.primary) else modifier
    val surface = when (kind) {
        ButtonKind.Primary -> base.clip(CircleShape).background(if (enabled) colors.primary else colors.primary.copy(alpha = 0.5f))
        ButtonKind.Soft -> base.softSurface(CircleShape)
        ButtonKind.Ghost -> base.clip(CircleShape)
        ButtonKind.Danger -> base.clip(CircleShape).background(colors.destructive.copy(alpha = 0.12f))
        ButtonKind.Tint -> base.clip(CircleShape).background(colors.primary.copy(alpha = 0.13f))
    }
    Row(
        modifier = surface
            .heightIn(min = 44.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        if (icon != null) RunovaIcon(icon, size = 14.dp, color = ink)
        RunovaText(text, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), color = ink, maxLines = 1)
    }
}

@Composable
fun RunovaCard(
    modifier: Modifier = Modifier,
    padding: PaddingValues = PaddingValues(16.dp),
    content: @Composable () -> Unit,
) {
    Box(modifier.runovaGlass().padding(padding)) { content() }
}

/** Where a page's content sits, rounded inside the darker chrome as on the desktop. */
@Composable
fun RunovaIsland(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(RunovaShape.island)
    Column(
        modifier
            .padding(horizontal = 6.dp)
            .fillMaxSize()
            .clip(shape)
            .background(colors.background)
            .border(1.dp, colors.border.copy(alpha = 0.7f), shape),
        content = content,
    )
}

/** A whole page: its title on the chrome, and its content on the island. */
@Composable
fun RunovaScreen(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(title, subtitle, onBack, trailing)
        RunovaIsland(Modifier.weight(1f).padding(bottom = 6.dp), content)
    }
}

enum class BadgeTone { Neutral, Primary, Success, Warning, Danger }

@Composable
private fun inkOf(tone: BadgeTone): Color {
    val colors = RunovaTheme.colors
    return when (tone) {
        BadgeTone.Neutral -> colors.mutedForeground
        BadgeTone.Primary -> colors.primary
        BadgeTone.Success -> colors.success
        BadgeTone.Warning -> colors.warning
        BadgeTone.Danger -> colors.destructive
    }
}

/** A status as a small tinted pill, with a dot when it is a live state. */
@Composable
fun RunovaBadge(
    text: String,
    tone: BadgeTone = BadgeTone.Neutral,
    modifier: Modifier = Modifier,
    dot: Boolean = false,
) {
    val colors = RunovaTheme.colors
    val ink = inkOf(tone)
    val fill = if (tone == BadgeTone.Neutral) colors.foreground.copy(alpha = 0.07f) else ink.copy(alpha = 0.13f)
    Row(
        modifier.height(22.dp).clip(CircleShape).background(fill).padding(horizontal = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (dot) Box(Modifier.size(6.dp).clip(CircleShape).background(ink))
        RunovaText(text, style = RunovaType.caption, color = ink, maxLines = 1)
    }
}

/** An icon on its tinted tile, which the desktop's cards and rows lead with. */
@Composable
fun RunovaIconTile(icon: String, tone: BadgeTone = BadgeTone.Primary, modifier: Modifier = Modifier, size: Dp = 36.dp) {
    val colors = RunovaTheme.colors
    val ink = if (tone == BadgeTone.Neutral) colors.foreground.copy(alpha = 0.8f) else inkOf(tone)
    val fill = if (tone == BadgeTone.Neutral) colors.foreground.copy(alpha = 0.06f) else ink.copy(alpha = 0.13f)
    Box(modifier.size(size).clip(TileShape).background(fill), contentAlignment = Alignment.Center) {
        RunovaIcon(icon, size = size * 0.44f, color = ink)
    }
}

/** The big glowing tile at the head of an empty state or a form. */
@Composable
fun RunovaHeroIcon(icon: String, tone: BadgeTone = BadgeTone.Primary, modifier: Modifier = Modifier) {
    val ink = inkOf(tone)
    val shape = RoundedCornerShape(18.dp)
    Box(
        modifier
            .glow(ink, 18.dp)
            .size(60.dp)
            .clip(shape)
            // Keeps the glow outside the tile, which is see-through.
            .background(RunovaTheme.colors.background)
            .background(ink.copy(alpha = 0.13f))
            .border(1.dp, ink.copy(alpha = 0.28f), shape),
        contentAlignment = Alignment.Center,
    ) { RunovaIcon(icon, size = 24.dp, color = ink) }
}

/** The small uppercase heading the desktop's menu puts over its groups. */
@Composable
fun RunovaSectionTitle(text: String, modifier: Modifier = Modifier) {
    RunovaText(
        text.uppercase(),
        modifier,
        RunovaType.caption.copy(fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp),
        RunovaTheme.colors.mutedForeground.copy(alpha = 0.75f),
        maxLines = 1,
    )
}

/** A row that opens something, as its own glass card unless it already sits inside one. */
@Composable
fun RunovaListRow(
    title: String,
    modifier: Modifier = Modifier,
    detail: String? = null,
    icon: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    iconTone: BadgeTone = BadgeTone.Primary,
    flat: Boolean = false,
) {
    val colors = RunovaTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val frame = if (flat) modifier.fillMaxWidth() else modifier.fillMaxWidth().padding(vertical = 4.dp).runovaGlass()
    val base = frame.heightIn(min = 60.dp)
    val tappable = if (onClick != null) base.clickable(interaction, null, role = Role.Button, onClick = onClick) else base
    Row(
        tappable.padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) RunovaIconTile(icon, iconTone)
        Column(Modifier.weight(1f)) {
            RunovaText(title, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
            if (detail != null) {
                RunovaText(detail, style = RunovaType.small, color = colors.mutedForeground, maxLines = 1)
            }
        }
        trailing?.invoke()
        if (onClick != null && trailing == null) {
            RunovaIcon(RunovaIcons.Forward, size = 11.dp, color = colors.mutedForeground.copy(alpha = 0.7f))
        }
    }
}

/** A pill field, as the desktop's are, that lights up while it has focus. */
@Composable
fun RunovaTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    secure: Boolean = false,
    icon: String? = null,
) {
    val colors = RunovaTheme.colors
    var focused by remember { mutableStateOf(false) }
    var revealed by remember { mutableStateOf(false) }
    val hidden = secure && !revealed
    val shape = CircleShape
    val ring = if (focused) modifier.fillMaxWidth().glow(colors.primary) else modifier.fillMaxWidth()
    val edge = if (focused) colors.primary.copy(alpha = 0.5f) else colors.foreground.copy(alpha = 0.08f)
    Row(
        ring
            .height(44.dp)
            .clip(shape)
            // Keeps the glow outside the field, which is see-through.
            .background(colors.background)
            .background(colors.foreground.copy(alpha = 0.05f))
            .border(1.dp, edge, shape)
            .padding(start = 16.dp, end = if (secure) 6.dp else 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (icon != null) RunovaIcon(icon, size = 14.dp, color = colors.mutedForeground)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            visualTransformation = if (hidden) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = if (secure) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
            textStyle = RunovaType.body.copy(color = colors.foreground),
            cursorBrush = SolidColor(colors.primary),
            modifier = Modifier.weight(1f).onFocusChanged { focused = it.isFocused },
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        RunovaText(placeholder, color = colors.mutedForeground.copy(alpha = 0.75f), maxLines = 1)
                    }
                    inner()
                }
            },
        )
        if (secure) {
            Box(
                Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button) { revealed = !revealed }
                    .semantics { contentDescription = if (revealed) "Hide password" else "Show password" },
                contentAlignment = Alignment.Center,
            ) {
                RunovaIcon(if (revealed) RunovaIcons.Hide else RunovaIcons.Show, size = 14.dp, color = colors.mutedForeground)
            }
        }
    }
}

/** A page's title on the chrome, with a line about it when there is one. */
@Composable
fun RunovaTopBar(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            Box(
                Modifier.size(40.dp)
                    .clip(CircleShape)
                    .background(colors.foreground.copy(alpha = 0.05f))
                    .clickable(role = Role.Button, onClick = onBack)
                    .semantics { contentDescription = "Back" },
                contentAlignment = Alignment.Center,
            ) { RunovaIcon(RunovaIcons.Back, size = 14.dp, color = colors.foreground) }
            Box(Modifier.size(10.dp))
        } else {
            Box(Modifier.size(8.dp))
        }
        Column(Modifier.weight(1f)) {
            RunovaText(title, style = RunovaType.title, maxLines = 1)
            if (subtitle != null) {
                RunovaText(subtitle, style = RunovaType.small, color = colors.mutedForeground, maxLines = 1)
            }
        }
        trailing?.invoke()
    }
}

data class TabItem(val id: String, val title: String, val icon: String)

/** How full something is. It warns near the limit, as the desktop's status bar does. */
@Composable
fun RunovaProgress(percent: Double, modifier: Modifier = Modifier) {
    val colors = RunovaTheme.colors
    val fill = when {
        percent >= 90 -> colors.destructive
        percent >= 75 -> colors.warning
        else -> colors.primary
    }
    Box(modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(colors.foreground.copy(alpha = 0.08f))) {
        Box(
            Modifier
                .fillMaxWidth((percent / 100).toFloat().coerceIn(0f, 1f))
                .height(6.dp)
                .clip(CircleShape)
                .background(fill),
        )
    }
}

/** On or off. Drawn here so it is the same switch on both apps. */
@Composable
fun RunovaToggle(on: Boolean, onChange: (Boolean) -> Unit, label: String, modifier: Modifier = Modifier) {
    val colors = RunovaTheme.colors
    Box(
        modifier
            .size(width = 46.dp, height = 28.dp)
            .clip(CircleShape)
            .background(if (on) colors.primary else colors.foreground.copy(alpha = 0.1f))
            .clickable(role = Role.Switch) { onChange(!on) }
            .semantics { contentDescription = label }
            .padding(3.dp),
        contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(if (on) colors.primaryForeground else colors.mutedForeground))
    }
}

enum class ChipTone { Soft, Primary, Danger }

/** A small pill control: a terminal key, a filter, a shortcut. */
@Composable
fun RunovaChip(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: String? = null,
    tone: ChipTone = ChipTone.Soft,
) {
    val colors = RunovaTheme.colors
    val ink = when (tone) {
        ChipTone.Soft -> colors.foreground.copy(alpha = 0.88f)
        ChipTone.Primary -> colors.primary
        ChipTone.Danger -> colors.destructive
    }
    val surface = when (tone) {
        ChipTone.Soft -> modifier.softSurface(CircleShape)
        ChipTone.Primary -> modifier.clip(CircleShape).background(colors.primary.copy(alpha = 0.13f))
        ChipTone.Danger -> modifier.clip(CircleShape).background(colors.destructive.copy(alpha = 0.12f))
    }
    Row(
        surface
            .heightIn(min = 36.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) RunovaIcon(icon, size = 12.dp, color = ink)
        RunovaText(text, style = RunovaType.small.copy(fontWeight = FontWeight.Medium), color = ink, maxLines = 1)
    }
}

/** The tab bar, on the chrome, with the desktop menu's tinted pill and accent mark. */
@Composable
fun RunovaBottomBar(tabs: List<TabItem>, selected: String, onSelect: (String) -> Unit) {
    val colors = RunovaTheme.colors
    Row(Modifier.fillMaxWidth().height(62.dp).padding(horizontal = 6.dp, vertical = 5.dp)) {
        for (tab in tabs) {
            val on = tab.id == selected
            val ink = if (on) colors.primary else colors.mutedForeground
            val shape = RoundedCornerShape(12.dp)
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .clip(shape)
                    .background(if (on) colors.primary.copy(alpha = 0.13f) else Color.Transparent)
                    .clickable(role = Role.Tab) { onSelect(tab.id) },
            ) {
                if (on) {
                    Box(
                        Modifier
                            .align(Alignment.TopCenter)
                            .size(width = 22.dp, height = 3.dp)
                            .clip(CircleShape)
                            .background(colors.primary),
                    )
                }
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
                ) {
                    RunovaIcon(tab.icon, size = 17.dp, color = ink)
                    RunovaText(tab.title, style = RunovaType.caption, color = ink, maxLines = 1)
                }
            }
        }
    }
}

@Composable
fun RunovaEmptyState(
    icon: String,
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    tone: BadgeTone = BadgeTone.Primary,
) {
    val colors = RunovaTheme.colors
    Column(
        modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaHeroIcon(icon, tone, Modifier.padding(bottom = 8.dp))
        RunovaText(title, style = RunovaType.title, align = TextAlign.Center)
        if (detail.isNotEmpty()) RunovaText(detail, color = colors.mutedForeground, align = TextAlign.Center)
    }
}

/** Where content will be while it loads. */
@Composable
fun RunovaSkeleton(modifier: Modifier = Modifier) {
    Box(
        modifier
            .height(14.dp)
            .clip(CircleShape)
            .background(RunovaTheme.colors.foreground.copy(alpha = 0.07f)),
    )
}
