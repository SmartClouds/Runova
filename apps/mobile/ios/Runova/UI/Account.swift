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
    var setMemberRole: (Int64, String) -> Void = { _, _ in }
    var acceptInvitation: (Int64) -> Void = { _ in }
    var declineInvitation: (Int64) -> Void = { _ in }
}

private struct Heading: View {
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaSectionTitle(text: text)
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
                    RunovaTextField(value: $password, placeholder: "Password", secure: true, icon: RunovaIcons.key)
                    RunovaTextField(value: $code, placeholder: "Two-factor code", icon: RunovaIcons.shield)
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
            RunovaScreen(title: "Account") {
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
                            RunovaBadge(text: "Two-factor on", tone: .success, dot: true).padding(.top, 6)
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
                                icon: RunovaIcons.envelope, flat: true)
                            RunovaChip(text: "Accept", icon: RunovaIcons.check, tone: .primary) {
                                intents.account.acceptInvitation(invitation.id)
                            }
                            RunovaChip(text: "Decline", icon: RunovaIcons.close) {
                                intents.account.declineInvitation(invitation.id)
                            }
                        }
                        .padding(.trailing, 12)
                        .rowCard()
                    }
                }
                Heading(text: "Sessions")
                ForEach(account.sessions, id: \.id) { session in
                    HStack(spacing: 6) {
                        RunovaListRow(
                            title: session.title, detail: session.detail,
                            icon: session.current ? RunovaIcons.mobile : RunovaIcons.systems, flat: true)
                        if session.current {
                            RunovaBadge(text: "This phone", tone: .primary, dot: true)
                        } else {
                            RunovaChip(text: "End", icon: RunovaIcons.signOut, tone: .danger) {
                                intents.account.endSession(session.id)
                            }
                                .accessibilityLabel("End \(session.title)")
                        }
                    }
                    .padding(.trailing, 12)
                    .rowCard()
                }
                RunovaButton(
                    text: "End all other sessions", kind: .danger, icon: RunovaIcons.signOut,
                    action: intents.account.endOtherSessions)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
                Heading(text: "Teams")
                ForEach(account.teams, id: \.id) { team in
                    Button {
                        intents.account.openTeam(team.id)
                    } label: {
                        HStack(spacing: 8) {
                            RunovaListRow(
                                title: team.name, detail: "\(team.memberCount) members", icon: RunovaIcons.team, flat: true)
                            RunovaBadge(text: team.role)
                        }
                        .padding(.trailing, 12)
                        .rowCard()
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Heading(text: "Recent activity")
                ForEach(account.activity, id: \.id) { activity in
                    RunovaListRow(title: activity.action, detail: activity.detail, icon: RunovaIcons.history, iconTone: .neutral)
                }
                RunovaListRow(title: "About Runova", icon: RunovaIcons.info, onTap: intents.openAbout)
                RunovaButton(text: "Sign out", kind: .soft, icon: RunovaIcons.signOut, action: intents.signOut)
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
    @State private var expanded: Int64?

    var body: some View {
        RunovaScreen(title: team.name, onBack: intents.closeTeam) {
            if team.canManage {
                HStack(spacing: 8) {
                    RunovaTextField(value: $email, placeholder: "Email address", icon: RunovaIcons.envelope)
                    RunovaButton(text: "Invite", enabled: !email.isEmpty, icon: RunovaIcons.invite) {
                        intents.invite(email, "member")
                        email = ""
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Heading(text: "Members")
                    ForEach(team.members, id: \.userId) { member in
                        Button {
                            guard member.canChange else { return }
                            expanded = expanded == member.userId ? nil : member.userId
                        } label: {
                            RunovaListRow(title: member.name, detail: member.role, icon: RunovaIcons.account)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if expanded == member.userId {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(member.roleOptions, id: \.key) { option in
                                        RunovaChip(text: "Make \(option.label)", icon: RunovaIcons.sliders) {
                                            intents.setMemberRole(member.userId, option.key)
                                        }
                                    }
                                    RunovaChip(text: "Remove", icon: RunovaIcons.trash, tone: .danger) {
                                        intents.removeMember(member.userId)
                                    }
                                        .accessibilityLabel("Remove \(member.name)")
                                }
                            }
                            .padding(.bottom, 8)
                        }
                    }
                    if !team.invitations.isEmpty {
                        Heading(text: "Invitations")
                        ForEach(team.invitations, id: \.id) { invitation in
                            HStack(spacing: 6) {
                                RunovaListRow(title: invitation.email, detail: invitation.role, icon: RunovaIcons.envelope, flat: true)
                                RunovaChip(text: "Take back", icon: RunovaIcons.close) { intents.cancelInvitation(invitation.id) }
                            }
                            .padding(.trailing, 12)
                            .rowCard()
                        }
                    }
                }
                .padding(16)
            }
        }
    }
}
