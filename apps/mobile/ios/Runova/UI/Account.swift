import SwiftUI

struct AccountIntents {
    var setName: (String) -> Void = { _ in }
    var endSession: (Int64) -> Void = { _ in }
    var endOtherSessions: () -> Void = {}
    var submitStepUp: (String?, String?) -> Void = { _, _ in }
    var cancelStepUp: () -> Void = {}
    var openTeam: (Int64) -> Void = { _ in }
    var closeTeam: () -> Void = {}
    var invite: (String, String) -> Void = { _, _ in }
    var cancelInvitation: (Int64) -> Void = { _ in }
    var removeMember: (Int64) -> Void = { _ in }
    var acceptInvitation: (Int64) -> Void = { _ in }
    var declineInvitation: (Int64) -> Void = { _ in }
}

private struct Heading: View {
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaText(text, style: RunovaType.caption, color: palette.mutedForeground)
            .padding(.top, 16)
            .padding(.bottom, 4)
    }
}

/// The step-up sits over everything, like the question before a risky change.
struct StepUpOverlay: View {
    let stepUp: StepUpView
    let intents: AccountIntents

    @State private var password = ""
    @State private var code = ""
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea().onTapGesture(perform: intents.cancelStepUp)
            RunovaCard {
                VStack(alignment: .leading, spacing: 8) {
                    RunovaText(stepUp.title, style: RunovaType.title)
                    RunovaText(stepUp.detail, color: palette.mutedForeground)
                    RunovaTextField(value: $password, placeholder: "Password", secure: true)
                    RunovaTextField(value: $code, placeholder: "Two-factor code")
                    if let error = stepUp.error {
                        RunovaText(error, style: RunovaType.small, color: palette.destructive)
                    }
                    HStack(spacing: 8) {
                        RunovaButton(text: "Cancel", kind: .soft, action: intents.cancelStepUp)
                            .frame(maxWidth: .infinity)
                        RunovaButton(text: "Confirm", kind: .danger, enabled: !password.isEmpty || !code.isEmpty) {
                            intents.submitStepUp(password.isEmpty ? nil : password, code.isEmpty ? nil : code)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .padding(.top, 8)
                }
            }
            .padding(24)
        }
    }
}

struct AccountTab: View {
    let view: AppView
    let intents: AppIntents

    var body: some View {
        if let team = view.account.team {
            TeamScreen(team: team, intents: intents.account)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                RunovaTopBar(title: "Account")
                if let profile = view.account.profile {
                    AccountList(profile: profile, account: view.account, intents: intents)
                } else {
                    LoadingRows()
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct AccountList: View {
    let profile: ProfileView
    let account: AccountScreen
    let intents: AppIntents

    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                RunovaCard {
                    VStack(alignment: .leading, spacing: 2) {
                        RunovaText(profile.name.isEmpty ? profile.email : profile.name, style: RunovaType.title)
                        RunovaText(profile.email, style: RunovaType.small, color: palette.mutedForeground)
                        if profile.twoFactor {
                            RunovaBadge(text: "Two-factor on", tone: .success).padding(.top, 6)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !account.invitations.isEmpty {
                    Heading(text: "Invitations")
                    ForEach(account.invitations, id: \.id) { invitation in
                        HStack(spacing: 6) {
                            RunovaListRow(
                                title: invitation.team,
                                detail: invitation.invitedBy.map { "From \($0), as \(invitation.role)" }
                                    ?? invitation.role,
                                icon: RunovaIcons.team)
                            RunovaChip(text: "Accept") { intents.account.acceptInvitation(invitation.id) }
                            RunovaChip(text: "Decline") { intents.account.declineInvitation(invitation.id) }
                        }
                    }
                }
                Heading(text: "Sessions")
                ForEach(account.sessions, id: \.id) { session in
                    HStack(spacing: 6) {
                        RunovaListRow(title: session.title, detail: session.detail, icon: RunovaIcons.shield)
                        if session.current {
                            RunovaBadge(text: "This phone", tone: .primary)
                        } else {
                            RunovaChip(text: "End") { intents.account.endSession(session.id) }
                                .accessibilityLabel("End \(session.title)")
                        }
                    }
                }
                RunovaButton(text: "End all other sessions", kind: .soft, action: intents.account.endOtherSessions)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
                Heading(text: "Teams")
                ForEach(account.teams, id: \.id) { team in
                    Button {
                        intents.account.openTeam(team.id)
                    } label: {
                        HStack(spacing: 8) {
                            RunovaListRow(
                                title: team.name, detail: "\(team.memberCount) members", icon: RunovaIcons.team)
                            RunovaBadge(text: team.role).padding(.trailing, 16)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Heading(text: "Recent activity")
                ForEach(account.activity, id: \.id) { activity in
                    RunovaListRow(title: activity.action, detail: activity.detail, icon: RunovaIcons.shield)
                }
                RunovaButton(text: "Sign out", kind: .soft, action: intents.signOut)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 16)
            }
            .padding(16)
        }
    }
}

private struct TeamScreen: View {
    let team: TeamDetailView
    let intents: AccountIntents

    @State private var email = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: team.name, onBack: intents.closeTeam)
            if team.canManage {
                HStack(spacing: 8) {
                    RunovaTextField(value: $email, placeholder: "Email address")
                    RunovaButton(text: "Invite", enabled: !email.isEmpty) {
                        intents.invite(email, "Member")
                        email = ""
                    }
                }
                .padding(.horizontal, 16)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Heading(text: "Members")
                    ForEach(team.members, id: \.userId) { member in
                        HStack(spacing: 6) {
                            RunovaListRow(title: member.name, detail: member.role, icon: RunovaIcons.account)
                            if team.canManage && member.role != "Owner" {
                                RunovaChip(text: "Remove") { intents.removeMember(member.userId) }
                                    .accessibilityLabel("Remove \(member.name)")
                            }
                        }
                    }
                    if !team.invitations.isEmpty {
                        Heading(text: "Invitations")
                        ForEach(team.invitations, id: \.id) { invitation in
                            HStack(spacing: 6) {
                                RunovaListRow(title: invitation.email, detail: invitation.role, icon: RunovaIcons.send)
                                RunovaChip(text: "Take back") { intents.cancelInvitation(invitation.id) }
                            }
                        }
                    }
                }
                .padding(16)
            }
        }
    }
}
