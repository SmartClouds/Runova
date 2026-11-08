mod common;

use common::connected;
use runova_ffi::view::Section;
use serde_json::json;
use std::time::Duration;

fn line_text(view: &runova_ffi::view::TerminalView, row: usize) -> String {
    view.frame.lines[row]
        .runs
        .iter()
        .map(|run| run.text.as_str())
        .collect::<String>()
        .trim_end()
        .to_owned()
}

fn terminals() -> serde_json::Value {
    json!([
        {"sessionId": "t1", "title": "Claude", "projectId": "p1", "cliId": "claude", "status": "needs-input", "createdAt": 5},
        {"sessionId": "t2", "title": "Terminal", "projectId": null, "cliId": null, "status": null, "createdAt": 6},
    ])
}

const FOLLOW: &str = "terminals.follow";

async fn open(world: &common::World) {
    world.computer.answer("terminals.list", terminals());
    world.engine.load_terminals();
    world.until(|v| v.terminals.len() == 2, "the list").await;
    world.engine.open_terminal("t1".into());
    world
        .until(
            |_| world.computer.subscription(FOLLOW).is_some(),
            "following",
        )
        .await;
    world.computer.event(
        FOLLOW,
        json!({"snapshot": {"data": "\u{1b}[2J\u{1b}[Hready", "cols": 40, "rows": 5}}),
    );
    world
        .until(
            |v| v.terminal.as_ref().is_some_and(|t| t.frame.cols == 40),
            "the screen",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_list_shows_what_each_cli_is_doing() {
    let world = connected().await;
    world.computer.answer("terminals.list", terminals());

    world.engine.load_terminals();
    let view = world.until(|v| !v.terminals.is_empty(), "the list").await;

    assert_eq!(view.terminals[0].title, "Claude");
    assert_eq!(
        view.terminals[0].status,
        Some(runova_ffi::view::AgentState::NeedsInput)
    );
    assert_eq!(view.terminals[1].status, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_list_keeps_itself_current_only_while_it_is_on_show() {
    let world = connected().await;
    world.computer.answer("terminals.list", terminals());
    let asked = || world.computer.params_of("terminals.list").len();

    world.engine.open_section(Some(Section::Clis));
    world.until(|_| asked() >= 3, "refreshes").await;

    world.engine.open_section(None);
    tokio::time::sleep(Duration::from_millis(60)).await;
    let after_closing = asked();
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(asked(), after_closing);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_without_the_scope_is_told_so() {
    let world = connected().await;
    world.computer.refuse(
        "terminals.list",
        "forbidden",
        "Not allowed on this computer.",
    );

    world.engine.load_terminals();
    let view = world.until(|v| v.error.is_some(), "the message").await;

    assert_eq!(view.error.as_deref(), Some("Not allowed on this computer."));
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_shows_the_screen_and_then_what_comes_next() {
    let world = connected().await;
    open(&world).await;

    world.computer.bytes(FOLLOW, b"\r\nnext line");
    let view = world
        .until(
            |v| {
                v.terminal
                    .as_ref()
                    .is_some_and(|t| line_text(t, 1) == "next line")
            },
            "the output",
        )
        .await;

    assert_eq!(line_text(view.terminal.as_ref().unwrap(), 0), "ready");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_asks_to_follow_the_terminal_without_giving_a_size() {
    let world = connected().await;
    open(&world).await;

    assert_eq!(
        world.computer.params_of(FOLLOW),
        vec![Some(json!({"sessionId": "t1"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn typing_is_sent_to_the_terminal() {
    let world = connected().await;
    open(&world).await;

    world.engine.terminal_input("ls\r".into());
    world
        .until(
            |_| !world.computer.params_of("terminals.write").is_empty(),
            "the write",
        )
        .await;

    assert_eq!(
        world.computer.params_of("terminals.write"),
        vec![Some(json!({"sessionId": "t1", "data": "ls\r"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn scrolling_shows_earlier_output() {
    let world = connected().await;
    open(&world).await;
    let mut output = String::new();
    for n in 0..20 {
        output.push_str(&format!("line {n}\r\n"));
    }
    world.computer.bytes(FOLLOW, output.as_bytes());
    world
        .until(
            |v| {
                v.terminal.as_ref().is_some_and(|t| {
                    t.frame
                        .lines
                        .iter()
                        .any(|l| l.runs.iter().any(|r| r.text.contains("line 19")))
                })
            },
            "the output",
        )
        .await;

    world.engine.terminal_scroll(5);

    world
        .until(
            |v| {
                v.terminal.as_ref().is_some_and(|t| {
                    t.scrolled
                        && t.frame
                            .lines
                            .iter()
                            .any(|l| l.runs.iter().any(|r| r.text.contains("line 14")))
                })
            },
            "the earlier lines",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn colors_arrive_resolved_so_native_code_only_paints() {
    let world = connected().await;
    open(&world).await;

    world.computer.bytes(FOLLOW, b"\r\n\x1b[31mred\x1b[0m");
    let view = world
        .until(
            |v| {
                v.terminal
                    .as_ref()
                    .is_some_and(|t| line_text(t, 1) == "red")
            },
            "the color",
        )
        .await;

    let run = &view.terminal.unwrap().frame.lines[1].runs[0];
    assert_eq!(run.fg, Some(0xF07178));
}

#[tokio::test(flavor = "multi_thread")]
async fn when_the_shell_exits_the_screen_says_so_and_stays_readable() {
    let world = connected().await;
    open(&world).await;

    world.computer.end(FOLLOW);
    let view = world
        .until(|v| v.terminal.as_ref().is_some_and(|t| t.ended), "the end")
        .await;

    assert_eq!(line_text(view.terminal.as_ref().unwrap(), 0), "ready");
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_a_terminal_stops_following_it_and_frees_it() {
    let world = connected().await;
    open(&world).await;
    let id = world.computer.subscription(FOLLOW).unwrap();

    world.engine.close_terminal();
    world.until(|v| v.terminal.is_none(), "closed").await;
    world
        .until(
            |_| world.computer.unsubscribed.lock().unwrap().contains(&id),
            "the unsubscribe",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_that_is_gone_says_why() {
    let world = connected().await;
    world.computer.answer("terminals.list", terminals());
    world.engine.load_terminals();
    world.until(|v| v.terminals.len() == 2, "the list").await;

    world.engine.open_terminal("t1".into());
    world
        .until(
            |_| world.computer.subscription(FOLLOW).is_some(),
            "following",
        )
        .await;
    world
        .computer
        .end_with(FOLLOW, "failed", "That terminal has closed.");

    let view = world
        .until(|v| v.terminal.as_ref().is_some_and(|t| t.ended), "ended")
        .await;
    assert_eq!(
        view.terminal.unwrap().end_reason.as_deref(),
        Some("That terminal has closed.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_burst_of_output_settles_on_the_last_screen() {
    let world = connected().await;
    open(&world).await;

    for n in 0..500 {
        world
            .computer
            .bytes(FOLLOW, format!("\r\nburst {n}").as_bytes());
    }

    world
        .until(
            |v| {
                v.terminal.as_ref().is_some_and(|t| {
                    t.frame
                        .lines
                        .iter()
                        .any(|l| l.runs.iter().any(|r| r.text.contains("burst 499")))
                })
            },
            "the end of the burst",
        )
        .await;
    assert!(
        world.views.0.lock().unwrap().len() < 400,
        "frames are coalesced, not sent one for every read"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn processes_are_listed_for_the_terminal() {
    let world = connected().await;
    world.computer.answer(
        "terminals.processes",
        json!([{"name": "node", "cpuPercent": 12.5, "memBytes": 2048}]),
    );

    world.engine.load_terminal_processes("t1".into());
    let view = world
        .until(|v| !v.terminal_processes.is_empty(), "the processes")
        .await;

    assert_eq!(
        world.computer.params_of("terminals.processes"),
        vec![Some(json!({"sessionId": "t1"}))]
    );
    assert_eq!(view.terminal_processes[0].name, "node");
    assert_eq!(view.terminal_processes[0].mem_bytes, 2048);
    assert_eq!(view.terminal_processes[0].cpu_label, "12.5%");
    assert_eq!(view.terminal_processes[0].memory_label, "2 KB");
}

#[tokio::test(flavor = "multi_thread")]
async fn choosing_a_project_is_remembered_until_the_computer_is_left() {
    let world = connected().await;

    world.engine.select_project(Some("p1".into()));
    world
        .until(|v| v.selected_project.as_deref() == Some("p1"), "selected")
        .await;

    world.engine.select_project(None);
    world
        .until(|v| v.selected_project.is_none(), "cleared")
        .await;

    world.engine.select_project(Some("p1".into()));
    world
        .until(|v| v.selected_project.is_some(), "selected again")
        .await;
    world.engine.disconnect();
    world
        .until(
            |v| v.connection.is_none() && v.selected_project.is_none(),
            "forgotten",
        )
        .await;
}
