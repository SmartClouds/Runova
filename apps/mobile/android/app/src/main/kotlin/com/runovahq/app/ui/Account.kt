package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AccountScreen
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.MyInvitationView
import uniffi.runova_ffi.ProfileView
import uniffi.runova_ffi.SessionView
import uniffi.runova_ffi.StepUpView
import uniffi.runova_ffi.TeamDetailView

data class AccountIntents(
    val setName: (String) -> Unit = {},
    val endSession: (Long) -> Unit = {},
    val endOtherSessions: () -> Unit = {},
    val submitStepUp: (String?, String?) -> Unit = { _, _ -> },
    val cancelStepUp: () -> Unit = {},
    val openTeam: (Long) -> Unit = {},
    val closeTeam: () -> Unit = {},
    val invite: (String, String) -> Unit = { _, _ -> },
    val cancelInvitation: (Long) -> Unit = {},
    val removeMember: (Long) -> Unit = {},
    val setMemberRole: (Long, String) -> Unit = { _, _ -> },
    val acceptInvitation: (Long) -> Unit = {},
    val declineInvitation: (Long) -> Unit = {},
)

private fun LazyListScope.heading(text: String) {
    item(key = "h/$text") {
        RunovaText(
            text,
            Modifier.padding(top = 16.dp, bottom = 4.dp),
            RunovaType.caption,
            RunovaTheme.colors.mutedForeground,
        )
    }
}

/** The step-up sits over everything, like the question before a risky change. */
@Composable
fun StepUpOverlay(stepUp: StepUpView, intents: AccountIntents) {
    val colors = RunovaTheme.colors
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable(interactionSource = null, indication = null, onClick = intents.cancelStepUp),
        contentAlignment = Alignment.Center,
    ) {
        RunovaCard(Modifier.padding(24.dp).fillMaxWidth().clickable(interactionSource = null, indication = null) {}) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaText(stepUp.title, style = RunovaType.title)
                RunovaText(stepUp.detail, color = colors.mutedForeground)
                RunovaTextField(password, { password = it }, "Password", secure = true)
                RunovaTextField(code, { code = it }, "Two-factor code")
                stepUp.error?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaButton("Cancel", onClick = intents.cancelStepUp, Modifier.weight(1f), kind = ButtonKind.Soft)
                    RunovaButton(
                        "Confirm",
                        onClick = { intents.submitStepUp(password.ifEmpty { null }, code.ifEmpty { null }) },
                        Modifier.weight(1f),
                        kind = ButtonKind.Danger,
                        enabled = password.isNotEmpty() || code.isNotEmpty(),
                    )
                }
            }
        }
    }
}

@Composable
fun AccountTab(view: AppView, intents: AppIntents) {
    val account = view.account
    val team = account.team
    if (team != null) {
        TeamScreen(team, intents.account)
        return
    }
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar("Account")
        val profile = account.profile
        if (profile == null) {
            LoadingRows()
        } else {
            AccountList(profile, account, intents)
        }
    }
}

@Composable
private fun AccountList(profile: ProfileView, account: AccountScreen, intents: AppIntents) {
    LazyColumn(contentPadding = PaddingValues(16.dp)) {
        item(key = "profile") { ProfileCard(profile) }
        if (account.invitations.isNotEmpty()) {
            heading("Invitations")
            items(account.invitations, key = { "i/${it.id}" }) { InvitationRow(it, intents.account) }
        }
        heading("Sessions")
        items(account.sessions, key = { "s/${it.id}" }) { SessionRow(it, intents.account) }
        item(key = "others") {
            RunovaButton(
                "End all other sessions",
                onClick = intents.account.endOtherSessions,
                Modifier.fillMaxWidth().padding(top = 8.dp),
                kind = ButtonKind.Soft,
            )
        }
        heading("Teams")
        items(account.teams, key = { "t/${it.id}" }) { team ->
            RunovaListRow(
                title = team.name,
                detail = "${team.memberCount} members",
                icon = RunovaIcons.Team,
                onClick = { intents.account.openTeam(team.id) },
                trailing = { RunovaBadge(team.role) },
            )
        }
        heading("Recent activity")
        items(account.activity, key = { "a/${it.id}" }) { activity ->
            RunovaListRow(title = activity.action, detail = activity.detail, icon = RunovaIcons.Shield)
        }
        item(key = "sign-out") {
            RunovaButton(
                "Sign out",
                onClick = intents.signOut,
                Modifier.fillMaxWidth().padding(top = 16.dp),
                kind = ButtonKind.Soft,
            )
        }
    }
}

@Composable
private fun ProfileCard(profile: ProfileView) {
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            RunovaText(profile.name.ifEmpty { profile.email }, style = RunovaType.title)
            RunovaText(profile.email, style = RunovaType.small, color = RunovaTheme.colors.mutedForeground)
            if (profile.twoFactor) {
                RunovaBadge("Two-factor on", BadgeTone.Success, Modifier.padding(top = 6.dp))
            }
        }
    }
}

@Composable
private fun SessionRow(session: SessionView, intents: AccountIntents) {
    RunovaListRow(
        title = session.title,
        detail = session.detail,
        icon = RunovaIcons.Shield,
        trailing = {
            if (session.current) {
                RunovaBadge("This phone", BadgeTone.Primary)
            } else {
                RunovaChip(
                    "End",
                    { intents.endSession(session.id) },
                    Modifier.semantics { contentDescription = "End ${session.title}" },
                )
            }
        },
    )
}

@Composable
private fun InvitationRow(invitation: MyInvitationView, intents: AccountIntents) {
    RunovaListRow(
        title = invitation.team,
        detail = invitation.invitedBy?.let { "From $it, as ${invitation.role}" } ?: invitation.role,
        icon = RunovaIcons.Team,
        trailing = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                RunovaChip("Accept", { intents.acceptInvitation(invitation.id) })
                RunovaChip("Decline", { intents.declineInvitation(invitation.id) })
            }
        },
    )
}

@Composable
private fun TeamScreen(team: TeamDetailView, intents: AccountIntents) {
    var expanded by remember(team.id) { mutableStateOf<Long?>(null) }
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(team.name, onBack = intents.closeTeam)
        if (team.canManage) InviteForm(intents)
        LazyColumn(contentPadding = PaddingValues(16.dp)) {
            heading("Members")
            items(team.members, key = { "m/${it.userId}" }) { member ->
                Column {
                    RunovaListRow(
                        title = member.name,
                        detail = member.role,
                        icon = RunovaIcons.Account,
                        onClick = if (member.canChange) ({
                            expanded = if (expanded == member.userId) null else member.userId
                        }) else null,
                    )
                    if (expanded == member.userId) {
                        Row(
                            Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            member.roleOptions.forEach { option ->
                                RunovaChip("Make ${option.label}", { intents.setMemberRole(member.userId, option.key) })
                            }
                            RunovaChip(
                                "Remove",
                                { intents.removeMember(member.userId) },
                                Modifier.semantics { contentDescription = "Remove ${member.name}" },
                            )
                        }
                    }
                }
            }
            if (team.invitations.isNotEmpty()) {
                heading("Invitations")
                items(team.invitations, key = { "i/${it.id}" }) { invitation ->
                    RunovaListRow(
                        title = invitation.email,
                        detail = invitation.role,
                        icon = RunovaIcons.Send,
                        trailing = { RunovaChip("Take back", { intents.cancelInvitation(invitation.id) }) },
                    )
                }
            }
        }
    }
}

@Composable
private fun InviteForm(intents: AccountIntents) {
    var email by remember { mutableStateOf("") }
    Row(
        Modifier.padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RunovaTextField(email, { email = it }, "Email address", Modifier.weight(1f))
        RunovaButton(
            "Invite",
            onClick = {
                intents.invite(email, "member")
                email = ""
            },
            enabled = email.isNotBlank(),
        )
    }
}
