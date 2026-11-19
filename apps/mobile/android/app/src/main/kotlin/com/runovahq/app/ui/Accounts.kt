package com.runovahq.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaAvatar
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaShape
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.avatarInk
import kotlinx.coroutines.delay
import uniffi.runova_ffi.AccountItem
import uniffi.runova_ffi.AccountsView
import uniffi.runova_ffi.ProfileView

/** What the account screens can ask the core for (E118). */
data class AccountsIntents(
    val add: () -> Unit = {},
    val cancelAdd: () -> Unit = {},
    val switchTo: (Long) -> Unit = {},
    val signOutOf: (Long) -> Unit = {},
    val signOutAll: () -> Unit = {},
)

private val AccountItem.tint: Int get() = tone.toInt()

/** The account in use, or the first one when the core has not said yet. */
internal fun AccountsView.current(): AccountItem? = items.firstOrNull { it.active }

/**
 * The top of the Account tab: who this is, and the way to the other accounts on the phone. The
 * whole card opens the switcher, which is where adding and managing accounts live too.
 */
@Composable
fun AccountHeader(profile: ProfileView, accounts: AccountsView, onOpen: () -> Unit) {
    val colors = RunovaTheme.colors
    val current = accounts.current()
    val others = accounts.items.filter { !it.active }
    val count = accounts.items.size.coerceAtLeast(1)
    RunovaCard(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(RunovaShape.lg))
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics(mergeDescendants = true) {
                contentDescription = "Accounts, $count on this phone"
            },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            RunovaAvatar(
                current?.initials ?: initialsOf(profile),
                current?.tint ?: 0,
                size = 52.dp,
                ring = true,
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                RunovaText(profile.name.ifEmpty { profile.email }, style = RunovaType.title, maxLines = 1)
                RunovaText(profile.email, style = RunovaType.small, color = colors.mutedForeground, maxLines = 1)
                if (profile.twoFactor) {
                    RunovaBadge("Two-factor on", BadgeTone.Success, Modifier.padding(top = 6.dp), dot = true)
                }
            }
            if (others.isEmpty()) {
                SwitchHint(text = "Add", icon = RunovaIcons.Add)
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StackedAvatars(others)
                    Spacer(Modifier.width(8.dp))
                    SwitchHint(text = "Switch", icon = RunovaIcons.Forward)
                }
            }
        }
    }
}

@Composable
private fun SwitchHint(text: String, icon: String) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.clip(CircleShape).background(colors.primary.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        RunovaText(text, style = RunovaType.caption.copy(fontWeight = FontWeight.SemiBold), color = colors.primary)
        RunovaIcon(icon, size = 10.dp, color = colors.primary)
    }
}

/** Up to three of the other accounts, overlapping, so the header hints at who else is here. */
@Composable
private fun StackedAvatars(others: List<AccountItem>) {
    val colors = RunovaTheme.colors
    val shown = others.take(3)
    Box(Modifier.width((22 + (shown.size - 1) * 14).dp).height(26.dp)) {
        shown.forEachIndexed { index, item ->
            RunovaAvatar(
                item.initials,
                item.tint,
                Modifier
                    .offset(x = (index * 14).dp)
                    .border(2.dp, colors.card, CircleShape),
                size = 26.dp,
            )
        }
    }
}

private fun initialsOf(profile: ProfileView): String =
    profile.name.trim().split(" ").filter { it.isNotEmpty() }.let { words ->
        when {
            words.size > 1 -> "${words.first().first()}${words.last().first()}"
            words.size == 1 -> words.first().take(1)
            else -> profile.email.take(1)
        }
    }.uppercase()

/** A small avatar of the account in use for a top bar, opening the switcher. */
@Composable
fun AccountAvatarButton(accounts: AccountsView, onOpen: () -> Unit) {
    val current = accounts.current() ?: return
    Box(
        Modifier
            .padding(end = 6.dp)
            .size(44.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics { contentDescription = "Switch account" },
        contentAlignment = Alignment.Center,
    ) {
        RunovaAvatar(current.initials, current.tint, size = 40.dp, ring = true)
    }
}

/**
 * The account switcher, as a sheet from the bottom over whatever is on show. Tapping outside it
 * closes it. Accounts keep the order they were added in, so they stay where the thumb expects.
 */
@Composable
fun AccountSwitcherSheet(
    accounts: AccountsView,
    intents: AccountsIntents,
    onManage: () -> Unit,
    onClose: () -> Unit,
) {
    val colors = RunovaTheme.colors
    val shown = remember { MutableTransitionState(false).apply { targetState = true } }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.55f))
            .clickable(interactionSource = null, indication = null, onClick = onClose)
            .semantics { contentDescription = "Close accounts" },
        contentAlignment = Alignment.BottomCenter,
    ) {
        AnimatedVisibility(shown, enter = slideInVertically { it / 3 } + fadeIn()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                    .background(colors.card)
                    .border(1.dp, colors.border.copy(alpha = 0.7f), RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                    .clickable(interactionSource = null, indication = null) {}
                    .navigationBarsPadding()
                    .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 16.dp),
            ) {
                Box(
                    Modifier
                        .align(Alignment.CenterHorizontally)
                        .size(width = 36.dp, height = 4.dp)
                        .clip(CircleShape)
                        .background(colors.mutedForeground.copy(alpha = 0.35f)),
                )
                Spacer(Modifier.height(14.dp))
                RunovaText("Accounts", style = RunovaType.heading)
                RunovaText(
                    "Switch any time. Every account keeps its notifications.",
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                )
                Spacer(Modifier.height(12.dp))
                accounts.items.forEach { item ->
                    AccountRow(item) {
                        onClose()
                        intents.switchTo(item.id)
                    }
                }
                Spacer(Modifier.height(6.dp))
                SheetAction("Add another account", RunovaIcons.Add, BadgeTone.Primary) {
                    onClose()
                    intents.add()
                }
                SheetAction("Manage accounts", RunovaIcons.Settings, BadgeTone.Neutral) {
                    onClose()
                    onManage()
                }
            }
        }
    }
}

/** One account in a list: its avatar, who it is, and whether it is the one in use. */
@Composable
private fun AccountRow(item: AccountItem, onClick: () -> Unit) {
    val colors = RunovaTheme.colors
    val label = if (item.active) "${item.name}, ${item.email}, current account" else "Switch to ${item.name}, ${item.email}"
    val shape = RoundedCornerShape(RunovaShape.md)
    val fill = if (item.active) avatarInk(item.tint).copy(alpha = 0.08f) else Color.Transparent
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clip(shape)
            .background(fill)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            }
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RunovaAvatar(item.initials, item.tint, size = 42.dp, ring = item.active)
        Column(Modifier.weight(1f)) {
            RunovaText(item.name, style = RunovaType.labelStrong, maxLines = 1)
            RunovaText(item.email, style = RunovaType.small, color = colors.mutedForeground, maxLines = 1)
        }
        when {
            item.needsSignIn -> RunovaBadge("Sign in again", BadgeTone.Warning)
            item.active -> Box(
                Modifier.size(24.dp).clip(CircleShape).background(colors.primary),
                contentAlignment = Alignment.Center,
            ) { RunovaIcon(RunovaIcons.Check, size = 11.dp, color = colors.primaryForeground) }
            else -> RunovaIcon(RunovaIcons.Forward, size = 11.dp, color = colors.mutedForeground.copy(alpha = 0.7f))
        }
    }
}

@Composable
private fun SheetAction(text: String, icon: String, tone: BadgeTone, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(RunovaShape.md))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(42.dp), contentAlignment = Alignment.Center) { RunovaIconTile(icon, tone, size = 36.dp) }
        RunovaText(text, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold))
    }
}

/** Every account on the phone, each with its own way out, and one way out of them all. */
@Composable
fun ManageAccountsScreen(accounts: AccountsView, intents: AccountsIntents, onBack: () -> Unit) {
    val colors = RunovaTheme.colors
    RunovaScreen("Accounts", subtitle = "${accounts.items.size} on this phone", onBack = onBack) {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(accounts.items, key = { "a/${it.id}" }) { item -> ManagedAccount(item, intents) }
            item(key = "add") {
                RunovaButton(
                    "Add another account",
                    onClick = {
                        onBack()
                        intents.add()
                    },
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    kind = ButtonKind.Tint,
                    icon = RunovaIcons.Add,
                )
            }
            item(key = "all") {
                Column(Modifier.padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaSectionTitle("This phone")
                    RunovaButton(
                        "Sign out of all accounts",
                        onClick = intents.signOutAll,
                        Modifier.fillMaxWidth(),
                        kind = ButtonKind.Danger,
                        icon = RunovaIcons.SignOut,
                    )
                    RunovaText(
                        "This also removes the passcode and recovery phrases on this phone.",
                        style = RunovaType.small,
                        color = colors.mutedForeground,
                    )
                }
            }
        }
    }
}

@Composable
private fun ManagedAccount(item: AccountItem, intents: AccountsIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                RunovaAvatar(item.initials, item.tint, size = 44.dp, ring = item.active)
                Column(Modifier.weight(1f)) {
                    RunovaText(item.name, style = RunovaType.labelStrong, maxLines = 1)
                    RunovaText(item.email, style = RunovaType.small, color = colors.mutedForeground, maxLines = 1)
                    RunovaText(item.lastUsed, style = RunovaType.caption, color = colors.mutedForeground.copy(alpha = 0.8f))
                }
                when {
                    item.needsSignIn -> RunovaBadge("Sign in again", BadgeTone.Warning)
                    item.active -> RunovaBadge("Current", BadgeTone.Primary, dot = true)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!item.active) {
                    RunovaButton(
                        if (item.needsSignIn) "Sign in" else "Switch",
                        onClick = { intents.switchTo(item.id) },
                        Modifier.weight(1f).semantics { contentDescription = "Switch to ${item.name}" },
                        kind = ButtonKind.Soft,
                    )
                }
                RunovaButton(
                    "Sign out",
                    onClick = { intents.signOutOf(item.id) },
                    Modifier.weight(1f).semantics { contentDescription = "Sign out of ${item.email}" },
                    kind = ButtonKind.Soft,
                    icon = RunovaIcons.SignOut,
                )
            }
        }
    }
}

/** The moment between accounts: who the phone is switching to, while it starts. */
@Composable
fun SwitchingScreen(item: AccountItem) {
    val colors = RunovaTheme.colors
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        RunovaAvatar(item.initials, item.tint, size = 88.dp, ring = true)
        Spacer(Modifier.height(20.dp))
        RunovaText("Switching to ${item.name}", style = RunovaType.heading, align = TextAlign.Center)
        Spacer(Modifier.height(4.dp))
        RunovaText(item.email, color = colors.mutedForeground, align = TextAlign.Center)
    }
}

/** A short line from the core over the tabs, such as which account is now in use. */
@Composable
fun AccountToast(message: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val colors = RunovaTheme.colors
    LaunchedEffect(message) {
        delay(3_500)
        onDismiss()
    }
    Row(
        modifier
            .padding(horizontal = 24.dp)
            .clip(CircleShape)
            .background(colors.popover)
            .border(1.dp, colors.border, CircleShape)
            .clickable(role = Role.Button, onClick = onDismiss)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RunovaIcon(RunovaIcons.Success, size = 13.dp, color = colors.success)
        RunovaText(message, style = RunovaType.small, color = colors.popoverForeground, maxLines = 2)
    }
}

/**
 * On the sign-in screen after a session ended: whose it was, and the other accounts on the phone
 * to carry on with instead.
 */
@Composable
fun SignedOutAccounts(accounts: AccountsView, onSwitch: (Long) -> Unit) {
    val colors = RunovaTheme.colors
    val reauth = accounts.reauth
    val others = accounts.items.filter { it.id != reauth?.id && !it.needsSignIn }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (reauth != null) {
            RunovaCard(Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    RunovaAvatar(reauth.initials, reauth.tint, size = 40.dp)
                    RunovaText(
                        "Your session for ${reauth.email} ended. Sign in again to keep using it.",
                        Modifier.weight(1f),
                        style = RunovaType.small,
                        color = colors.foreground,
                    )
                }
            }
        }
        if (others.isNotEmpty()) {
            RunovaSectionTitle("Or switch to", Modifier.padding(top = 8.dp))
            others.forEach { item -> AccountRow(item.copy(active = false)) { onSwitch(item.id) } }
        }
    }
}
