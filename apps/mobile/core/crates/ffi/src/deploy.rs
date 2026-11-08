//! Servers, through the computer's own connections to them.

use crate::engine::{Engine, Runner};
use crate::view::{
    AppView, BackupView, ConfirmView, ContainerLogsView, ContainerView, DeployServerView,
    LogLineView, ProblemSeverity, ProblemView, ServerDetailView, StackView,
};
use serde::Deserialize;
use serde_json::{Value, json};

/// An overview is several calls to a server, so it refreshes less often than logs do.
const OVERVIEW_EVERY_TICKS: u32 = 4;

#[derive(Deserialize)]
struct ServerDto {
    id: String,
    name: String,
    host: String,
    state: String,
    problem: Option<String>,
}

#[derive(Deserialize)]
struct ContainerDto {
    id: String,
    name: String,
    image: String,
    state: String,
    status: String,
    health: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackDto {
    id: String,
    name: String,
    status: String,
    running: u32,
    total: u32,
    can_redeploy: bool,
}

#[derive(Deserialize)]
struct ProblemDto {
    id: String,
    severity: String,
    title: String,
    detail: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupDto {
    state: String,
    plan_name: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewDto {
    #[serde(default)]
    reachable: bool,
    #[serde(default)]
    containers: Vec<ContainerDto>,
    #[serde(default)]
    stacks: Vec<StackDto>,
    #[serde(default)]
    problems: Vec<ProblemDto>,
    last_backup: Option<BackupDto>,
}

#[derive(Deserialize)]
struct LogLineDto {
    text: String,
    #[serde(default)]
    error: bool,
}

fn state_label(state: &str) -> String {
    match state {
        "online" => "Online",
        "connecting" => "Connecting",
        "reconnecting" => "Reconnecting",
        "offline" => "Offline",
        "needs-sign-in" => "Needs sign-in",
        "needs-re-enroll" => "Needs re-enrolling",
        "locked" => "Servers vault locked",
        other => other,
    }
    .to_owned()
}

fn apply_overview(server: &mut ServerDetailView, dto: OverviewDto) {
    server.loading = false;
    if !dto.reachable {
        server.unreachable = Some("This computer can't reach that server right now.".to_owned());
        return;
    }
    server.unreachable = None;
    server.containers = dto
        .containers
        .into_iter()
        .map(|c| ContainerView {
            running: c.state == "running",
            healthy: match c.health.as_deref() {
                Some("healthy") => Some(true),
                Some("unhealthy") => Some(false),
                _ => None,
            },
            id: c.id,
            name: c.name,
            image: c.image,
            status: c.status,
        })
        .collect();
    server.stacks = dto
        .stacks
        .into_iter()
        .map(|s| StackView {
            detail: format!("{} of {} running", s.running, s.total),
            id: s.id,
            name: s.name,
            status: s.status,
            can_redeploy: s.can_redeploy,
        })
        .collect();
    server.problems = dto
        .problems
        .into_iter()
        .map(|p| ProblemView {
            severity: if p.severity == "critical" {
                ProblemSeverity::Critical
            } else {
                ProblemSeverity::Warning
            },
            id: p.id,
            title: p.title,
            detail: p.detail,
        })
        .collect();
    server.backup = dto.last_backup.map(|b| {
        let failed = b.state == "failed";
        let plan = b.plan_name.unwrap_or_else(|| "Last backup".to_owned());
        BackupView {
            label: format!("{plan}: {}", b.state),
            detail: b.error.unwrap_or_default(),
            failed,
        }
    });
}

fn asking(title: &str, detail: String, action: &str) -> ConfirmView {
    ConfirmView {
        title: title.to_owned(),
        detail,
        action: action.to_owned(),
        danger: true,
    }
}

impl Runner {
    pub(crate) fn refresh_deploy(&mut self) {
        let overview_due = self.ticks.is_multiple_of(OVERVIEW_EVERY_TICKS);
        self.ticks = self.ticks.wrapping_add(1);
        if overview_due {
            self.load_servers();
            self.load_overview();
        }
        self.load_logs();
    }

    fn load_servers(&mut self) {
        self.view.deploy.loading = self.view.deploy.servers.is_empty();
        self.call(
            "deploy.servers",
            None,
            |view: &mut AppView, items: Vec<ServerDto>| {
                view.deploy.loading = false;
                view.deploy.servers = items
                    .into_iter()
                    .map(|s| DeployServerView {
                        online: s.state == "online",
                        state_label: state_label(&s.state),
                        id: s.id,
                        name: s.name,
                        host: s.host,
                        problem: s.problem,
                    })
                    .collect();
            },
            |view| view.deploy.loading = false,
        );
    }

    fn server_id(&self) -> Option<String> {
        self.view.deploy.server.as_ref().map(|s| s.id.clone())
    }

    fn load_overview(&mut self) {
        let Some(id) = self.server_id() else {
            return;
        };
        let asked_for = id.clone();
        self.call(
            "deploy.overview",
            Some(json!({ "serverId": id })),
            move |view: &mut AppView, dto: OverviewDto| {
                if let Some(server) = view.deploy.server.as_mut()
                    && server.id == asked_for
                {
                    apply_overview(server, dto);
                }
            },
            |view| {
                if let Some(server) = view.deploy.server.as_mut() {
                    server.loading = false;
                }
            },
        );
    }

    fn load_logs(&mut self) {
        let (Some(id), Some(container)) = (
            self.server_id(),
            self.view
                .deploy
                .logs
                .as_ref()
                .map(|l| l.container_id.clone()),
        ) else {
            return;
        };
        let asked_for = container.clone();
        self.call(
            "deploy.containerLogs",
            Some(json!({ "serverId": id, "containerId": container })),
            move |view: &mut AppView, items: Vec<LogLineDto>| {
                if let Some(logs) = view.deploy.logs.as_mut()
                    && logs.container_id == asked_for
                {
                    logs.loading = false;
                    logs.lines = items
                        .into_iter()
                        .map(|l| LogLineView {
                            text: l.text,
                            error: l.error,
                        })
                        .collect();
                }
            },
            |view| {
                if let Some(logs) = view.deploy.logs.as_mut() {
                    logs.loading = false;
                }
            },
        );
    }

    fn deploy_op(&mut self, method: &'static str, mut params: Value) {
        let Some(id) = self.server_id() else {
            return;
        };
        params["serverId"] = Value::String(id);
        self.op(method, Some(params), Self::load_overview);
    }

    fn container_name(&self, id: &str) -> String {
        self.view
            .deploy
            .server
            .as_ref()
            .and_then(|s| s.containers.iter().find(|c| c.id == id))
            .map_or_else(|| id.to_owned(), |c| c.name.clone())
    }

    fn stack_name(&self, id: &str) -> String {
        self.view
            .deploy
            .server
            .as_ref()
            .and_then(|s| s.stacks.iter().find(|c| c.id == id))
            .map_or_else(|| id.to_owned(), |c| c.name.clone())
    }
}

#[uniffi::export]
impl Engine {
    pub fn deploy_open_server(&self, id: String) {
        self.run(move |r| {
            let name = r
                .view
                .deploy
                .servers
                .iter()
                .find(|s| s.id == id)
                .map_or_else(String::new, |s| s.name.clone());
            r.view.deploy.server = Some(ServerDetailView {
                id,
                name,
                loading: true,
                unreachable: None,
                containers: Vec::new(),
                stacks: Vec::new(),
                problems: Vec::new(),
                backup: None,
            });
            r.load_overview();
        });
    }

    pub fn deploy_close_server(&self) {
        self.run(|r| {
            r.view.deploy.logs = None;
            r.view.deploy.server = None;
        });
    }

    pub fn deploy_open_logs(&self, container_id: String) {
        self.run(move |r| {
            r.view.deploy.logs = Some(ContainerLogsView {
                name: r.container_name(&container_id),
                container_id,
                loading: true,
                lines: Vec::new(),
            });
            r.load_logs();
        });
    }

    pub fn deploy_close_logs(&self) {
        self.run(|r| r.view.deploy.logs = None);
    }

    pub fn deploy_container_action(&self, container_id: String, action: String) {
        self.run(move |r| {
            let name = r.container_name(&container_id);
            let params = json!({ "containerId": container_id, "action": action });
            let question = match action.as_str() {
                "restart" => Some(("Restart this container?", "Restart")),
                "stop" => Some(("Stop this container?", "Stop")),
                _ => None,
            };
            match question {
                Some((title, verb)) => {
                    let detail = format!("{name} on this server.");
                    r.ask(asking(title, detail, verb), move |runner| {
                        runner.deploy_op("deploy.containerAction", params);
                    });
                }
                None => r.deploy_op("deploy.containerAction", params),
            }
        });
    }

    pub fn deploy_stack_action(&self, stack: String, action: String) {
        self.run(move |r| {
            let detail = format!("{} on this server.", r.stack_name(&stack));
            let title = format!("{action} this app?");
            let params = json!({ "stack": stack, "action": action });
            r.ask(asking(&title, detail, "Go ahead"), move |runner| {
                runner.deploy_op("deploy.stackAction", params);
            });
        });
    }

    pub fn deploy_stack_redeploy(&self, stack: String) {
        self.run(move |r| {
            let detail = format!("{} deploys its live version again.", r.stack_name(&stack));
            let params = json!({ "stack": stack });
            r.ask(
                asking("Redeploy this app?", detail, "Redeploy"),
                move |runner| {
                    runner.deploy_op("deploy.stackRedeploy", params);
                },
            );
        });
    }
}
