//! The account, straight from Runova's servers, so it needs no computer.

use crate::backend::BackendError;
use crate::engine::{Done, Engine, Runner};
use crate::view::{
    AccountScreen, ActivityView, AppView, ConfirmView, MyInvitationView, ProfileView,
    RoleOptionView, SessionView, StepUpView, TeamDetailView, TeamInvitationView, TeamMemberView,
    TeamView,
};
use serde::Deserialize;
use serde_json::{Value, json};

const ME: &str = "/api/v1/accounts/me";
const SESSIONS: &str = "/api/v1/sessions";
const CURRENT_SESSION: &str = "/api/v1/sessions/current";
const TEAMS: &str = "/api/v1/teams";
const INVITATIONS: &str = "/api/v1/invitations";
const ACTIVITIES: &str = "/api/v1/activities?page=1&pageSize=20";
/// Names change rarely, so this is every 15th tick, about once a minute.
const ACCOUNT_EVERY_TICKS: u32 = 15;
const WRONG_STEP_UP: &str = "That password or code isn't right.";

/// What is about to happen once the step-up is given.
pub(crate) struct PendingStepUp {
    method: &'static str,
    path: String,
    body: Value,
    after: fn(&mut Runner),
}

#[derive(Deserialize)]
struct Items<T> {
    items: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileDto {
    email: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    two_factor_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDto {
    id: i64,
    kind: String,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    platform: String,
    ip: Option<String>,
    #[serde(default)]
    current: bool,
}

#[derive(Deserialize)]
struct ActivityDto {
    id: i64,
    action: String,
    device: Option<String>,
    ip: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamDto {
    id: i64,
    name: String,
    role: String,
    #[serde(default)]
    member_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberDto {
    user_id: i64,
    #[serde(default)]
    email: String,
    display_name: Option<String>,
    role: String,
}

#[derive(Deserialize)]
struct TeamInvitationDto {
    id: i64,
    email: String,
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MyInvitationDto {
    id: i64,
    team_name: String,
    role: String,
    invited_by: Option<String>,
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "web" => "Browser",
        "desktop" => "Runova desktop app",
        "mobile" => "Runova app",
        _ => "Session",
    }
}

fn session_of(dto: SessionDto) -> SessionView {
    let kind = kind_label(&dto.kind);
    let mut detail = if dto.platform.is_empty() {
        kind.to_owned()
    } else {
        format!("{kind}, {}", dto.platform)
    };
    if let Some(ip) = dto.ip.filter(|_| !dto.current && dto.kind == "web") {
        detail.push_str(&format!(", {ip}"));
    }
    SessionView {
        id: dto.id,
        title: if dto.device_name.is_empty() {
            kind.to_owned()
        } else {
            dto.device_name
        },
        detail,
        current: dto.current,
    }
}

fn can_manage(role: &str) -> bool {
    matches!(role, "owner" | "admin")
}

fn role_label(role: &str) -> String {
    match role {
        "owner" => "Owner".to_owned(),
        "admin" => "Admin".to_owned(),
        "member" => "Member".to_owned(),
        "viewer" => "Viewer".to_owned(),
        other => other.to_owned(),
    }
}

/// What the person using the app may turn this member into, by the server's own rules: an Owner
/// manages anyone but other Owners here, and an Admin only Members and Viewers.
fn role_options(mine: &str, theirs: &str) -> Vec<RoleOptionView> {
    let allowed: &[&str] = match (mine, theirs) {
        ("owner", "owner") => &[],
        ("owner", _) => &["admin", "member", "viewer"],
        ("admin", "member" | "viewer") => &["member", "viewer"],
        _ => &[],
    };
    allowed
        .iter()
        .filter(|role| **role != theirs)
        .map(|role| RoleOptionView {
            key: (*role).to_owned(),
            label: role_label(role),
        })
        .collect()
}

fn asking(title: &str, detail: &str, action: &str) -> ConfirmView {
    ConfirmView {
        title: title.to_owned(),
        detail: detail.to_owned(),
        action: action.to_owned(),
        danger: true,
    }
}

impl Runner {
    pub(crate) fn refresh_account(&mut self) {
        let everything_due = self.ticks.is_multiple_of(ACCOUNT_EVERY_TICKS);
        self.ticks = self.ticks.wrapping_add(1);
        if everything_due {
            self.load_account();
        }
    }

    fn load_account(&mut self) {
        self.view.account.loading = self.view.account.profile.is_none();
        self.rest(
            ME,
            |view: &mut AppView, dto: ProfileDto| {
                view.account.loading = false;
                view.account.profile = Some(ProfileView {
                    name: dto.display_name.unwrap_or_default(),
                    email: dto.email,
                    two_factor: dto.two_factor_enabled,
                });
            },
            |view| view.account.loading = false,
        );
        self.rest(
            SESSIONS,
            |view: &mut AppView, dto: Items<SessionDto>| {
                view.account.sessions = dto.items.into_iter().map(session_of).collect();
            },
            |_| {},
        );
        self.rest(
            TEAMS,
            |view: &mut AppView, dto: Items<TeamDto>| {
                view.account.teams = dto
                    .items
                    .into_iter()
                    .map(|t| TeamView {
                        id: t.id,
                        name: t.name,
                        role: role_label(&t.role),
                        role_key: t.role,
                        member_count: t.member_count,
                    })
                    .collect();
            },
            |_| {},
        );
        self.rest(
            INVITATIONS,
            |view: &mut AppView, dto: Items<MyInvitationDto>| {
                view.account.invitations = dto
                    .items
                    .into_iter()
                    .map(|i| MyInvitationView {
                        id: i.id,
                        team: i.team_name,
                        role: role_label(&i.role),
                        invited_by: i.invited_by,
                    })
                    .collect();
            },
            |_| {},
        );
        self.rest(
            ACTIVITIES,
            |view: &mut AppView, dto: Items<ActivityDto>| {
                view.account.activity = dto
                    .items
                    .into_iter()
                    .map(|a| ActivityView {
                        id: a.id,
                        action: a.action.replace('-', " "),
                        detail: a.device.or(a.ip),
                    })
                    .collect();
            },
            |_| {},
        );
    }

    fn open_team(&mut self, id: i64) {
        let Some(team) = self.view.account.teams.iter().find(|t| t.id == id).cloned() else {
            return;
        };
        let manage = can_manage(&team.role_key);
        self.view.account.team = Some(TeamDetailView {
            id,
            name: team.name,
            my_role: team.role_key,
            can_manage: manage,
            members: Vec::new(),
            invitations: Vec::new(),
        });
        self.load_team();
    }

    fn load_team(&mut self) {
        let Some((id, manage)) = self
            .view
            .account
            .team
            .as_ref()
            .map(|t| (t.id, t.can_manage))
        else {
            return;
        };
        self.rest(
            format!("{TEAMS}/{id}/members"),
            move |view: &mut AppView, dto: Items<MemberDto>| {
                if let Some(team) = view.account.team.as_mut().filter(|t| t.id == id) {
                    let mine = team.my_role.clone();
                    team.members = dto
                        .items
                        .into_iter()
                        .map(|m| {
                            let role_options = role_options(&mine, &m.role);
                            TeamMemberView {
                                user_id: m.user_id,
                                name: m.display_name.filter(|n| !n.is_empty()).unwrap_or(m.email),
                                role: role_label(&m.role),
                                can_change: !role_options.is_empty(),
                                role_options,
                            }
                        })
                        .collect();
                }
            },
            |_| {},
        );
        if manage {
            self.rest(
                format!("{TEAMS}/{id}/invitations"),
                move |view: &mut AppView, dto: Items<TeamInvitationDto>| {
                    if let Some(team) = view.account.team.as_mut().filter(|t| t.id == id) {
                        team.invitations = dto
                            .items
                            .into_iter()
                            .map(|i| TeamInvitationView {
                                id: i.id,
                                email: i.email,
                                role: role_label(&i.role),
                            })
                            .collect();
                    }
                },
                |_| {},
            );
        }
    }

    /// A change on the website, then whatever needs re-reading because of it.
    fn change(
        &mut self,
        method: &'static str,
        path: String,
        body: Value,
        notice: &'static str,
        after: fn(&mut Runner),
    ) {
        let backend = self.deps_backend();
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        self.view.busy = true;
        self.view.error = None;
        tokio::spawn(async move {
            let outcome = backend.send_json(method, &path, body).await;
            let task = move |runner: &mut Runner| {
                runner.view.busy = false;
                match outcome {
                    Ok(_) => {
                        runner.view.notice = Some(notice.to_owned());
                        after(runner);
                    }
                    Err(BackendError::SignedOut) => runner.on_signed_out(),
                    Err(BackendError::Failed(message)) => runner.view.error = Some(message),
                }
            };
            let _ = done.send(Done::Run {
                attempt,
                task: Box::new(task),
            });
        });
    }

    fn ask_step_up(
        &mut self,
        title: &str,
        detail: &str,
        (method, path, body): (&'static str, String, Value),
        after: fn(&mut Runner),
    ) {
        self.view.account.step_up = Some(StepUpView {
            title: title.to_owned(),
            detail: detail.to_owned(),
            error: None,
        });
        self.pending_step_up = Some(PendingStepUp {
            method,
            path,
            body,
            after,
        });
    }

    fn submit_step_up(&mut self, password: Option<String>, code: Option<String>) {
        let Some(pending) = self.pending_step_up.take() else {
            return;
        };
        let mut body = pending.body.clone();
        if let Some(password) = password.filter(|p| !p.is_empty()) {
            body["password"] = Value::String(password);
        }
        if let Some(code) = code.filter(|c| !c.is_empty()) {
            body["code"] = Value::String(code);
        }
        let backend = self.deps_backend();
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        self.view.busy = true;
        tokio::spawn(async move {
            let outcome = backend.send_json(pending.method, &pending.path, body).await;
            let task = move |runner: &mut Runner| {
                runner.view.busy = false;
                match outcome {
                    Ok(_) => {
                        runner.view.account.step_up = None;
                        runner.view.notice = Some("Done.".to_owned());
                        (pending.after)(runner);
                    }
                    Err(BackendError::SignedOut) => runner.on_signed_out(),
                    Err(BackendError::Failed(_)) => {
                        if let Some(step_up) = runner.view.account.step_up.as_mut() {
                            step_up.error = Some(WRONG_STEP_UP.to_owned());
                        }
                        runner.pending_step_up = Some(pending);
                    }
                }
            };
            let _ = done.send(Done::Run {
                attempt,
                task: Box::new(task),
            });
        });
    }

    /// Ends the server's session, then removes everything that identifies this phone.
    pub(crate) async fn sign_out_fully(&mut self) {
        let backend = self.deps_backend();
        // A sign-out must not hang on a bad network: the phone is cleared either way.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            backend.send_json("DELETE", CURRENT_SESSION, json!({})),
        )
        .await;
        self.clear_identity().await;
        self.view.account = AccountScreen::default();
    }

    fn team_id(&self) -> Option<i64> {
        self.view.account.team.as_ref().map(|t| t.id)
    }

    fn reload_team_and_account(&mut self) {
        self.load_team();
        self.load_account();
    }
}

#[uniffi::export]
impl Engine {
    pub fn account_set_name(&self, name: String) {
        self.run(move |r| {
            r.change(
                "PATCH",
                ME.to_owned(),
                json!({ "displayName": name }),
                "Saved.",
                Runner::load_account,
            );
        });
    }

    pub fn account_end_session(&self, id: i64) {
        self.run(move |r| {
            r.ask(
                asking(
                    "End this session?",
                    "That device is signed out of Runova.",
                    "End session",
                ),
                move |runner| {
                    runner.change(
                        "DELETE",
                        format!("{SESSIONS}/{id}"),
                        json!({}),
                        "Session ended.",
                        Runner::load_account,
                    );
                },
            );
        });
    }

    pub fn account_end_other_sessions(&self) {
        self.run(|r| {
            r.ask_step_up(
                "End all other sessions?",
                "Enter your password or a two-factor code to confirm.",
                ("DELETE", SESSIONS.to_owned(), json!({})),
                Runner::load_account,
            );
        });
    }

    pub fn account_submit_step_up(&self, password: Option<String>, code: Option<String>) {
        self.run(move |r| r.submit_step_up(password, code));
    }

    pub fn account_cancel_step_up(&self) {
        self.run(|r| {
            r.view.account.step_up = None;
            r.pending_step_up = None;
        });
    }

    pub fn account_open_team(&self, id: i64) {
        self.run(move |r| r.open_team(id));
    }

    pub fn account_close_team(&self) {
        self.run(|r| r.view.account.team = None);
    }

    pub fn account_invite(&self, email: String, role: String) {
        self.run(move |r| {
            let Some(team) = r.team_id() else {
                return;
            };
            r.change(
                "POST",
                format!("{TEAMS}/{team}/invitations"),
                json!({ "email": email, "role": role }),
                "Invitation sent.",
                Runner::load_team,
            );
        });
    }

    pub fn account_cancel_invitation(&self, id: i64) {
        self.run(move |r| {
            let Some(team) = r.team_id() else {
                return;
            };
            r.change(
                "DELETE",
                format!("{TEAMS}/{team}/invitations/{id}"),
                json!({}),
                "Invitation taken back.",
                Runner::load_team,
            );
        });
    }

    pub fn account_remove_member(&self, user_id: i64) {
        self.run(move |r| {
            let Some(team) = r.team_id() else {
                return;
            };
            r.ask_step_up(
                "Remove this member?",
                "Enter your password or a two-factor code to confirm.",
                (
                    "DELETE",
                    format!("{TEAMS}/{team}/members/{user_id}"),
                    json!({}),
                ),
                Runner::reload_team_and_account,
            );
        });
    }

    pub fn account_set_member_role(&self, user_id: i64, role: String) {
        self.run(move |r| {
            let Some(team) = r.team_id() else {
                return;
            };
            r.ask_step_up(
                &format!("Make this member {}?", role_label(&role)),
                "Enter your password or a two-factor code to confirm.",
                (
                    "PATCH",
                    format!("{TEAMS}/{team}/members/{user_id}"),
                    json!({ "role": role }),
                ),
                Runner::reload_team_and_account,
            );
        });
    }

    pub fn account_accept_invitation(&self, id: i64) {
        self.run(move |r| {
            r.change(
                "POST",
                format!("{INVITATIONS}/{id}/acceptances"),
                json!({}),
                "You've joined the team.",
                Runner::load_account,
            );
        });
    }

    pub fn account_decline_invitation(&self, id: i64) {
        self.run(move |r| {
            r.change(
                "DELETE",
                format!("{INVITATIONS}/{id}"),
                json!({}),
                "Invitation declined.",
                Runner::load_account,
            );
        });
    }

    /// Takes this phone off the computer it is connected to, and leaves it.
    pub fn forget_this_phone(&self) {
        self.run(|r| {
            r.ask(
                asking(
                    "Forget this phone?",
                    "This computer will have to approve it again next time.",
                    "Forget",
                ),
                |runner| runner.op("phone.forget", None, Runner::leave_computer),
            );
        });
    }
}
