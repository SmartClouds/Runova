//! The CLIs on a computer. One task owns the open terminal's grid, so nothing else holds its
//! history, and the grid goes away with the task when the terminal is closed.

use crate::engine::{Apply, Done, Runner};
use crate::labels::{bytes_label, percent_label};
use crate::palette;
use crate::view::{
    AgentState, CursorView, FrameView, LineView, RunView, TerminalItem, TerminalProcessView,
    TerminalView,
};
use runova_rpc::{ManageClient, RpcError, StreamEvent};
use runova_term::{Frame, Grid, Paint};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

/// About twenty screens a second, however fast a CLI prints.
const FRAME_INTERVAL: Duration = Duration::from_millis(50);
const INPUT_QUEUE: usize = 64;
const SCROLL_QUEUE: usize = 32;
const FOLLOW: &str = "terminals.follow";
/// Only until the computer's snapshot says the real size.
const STARTING_COLS: u16 = 80;
const STARTING_ROWS: u16 = 24;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDto {
    session_id: String,
    title: String,
    project_id: Option<String>,
    cli_id: Option<String>,
    status: Option<String>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessDto {
    name: String,
    cpu_percent: f64,
    mem_bytes: u64,
}

#[derive(Deserialize)]
struct FollowEvent {
    snapshot: Snapshot,
}

#[derive(Deserialize)]
struct Snapshot {
    data: String,
    cols: u16,
    rows: u16,
}

fn agent_state(status: Option<&str>) -> Option<AgentState> {
    match status? {
        "idle" => Some(AgentState::Idle),
        "working" => Some(AgentState::Working),
        "needs-input" => Some(AgentState::NeedsInput),
        "done" => Some(AgentState::Done),
        "exited" => Some(AgentState::Exited),
        _ => None,
    }
}

fn item_of(dto: TerminalDto) -> TerminalItem {
    TerminalItem {
        status: agent_state(dto.status.as_deref()),
        session_id: dto.session_id,
        title: dto.title,
        project_id: dto.project_id,
        cli_id: dto.cli_id,
        created_at: dto.created_at,
    }
}

fn cube_level(value: u8) -> u32 {
    if value == 0 {
        0
    } else {
        55 + 40 * u32::from(value)
    }
}

/// The color to paint, or `None` for the theme's own foreground or background.
fn resolve(paint: Paint) -> Option<u32> {
    match paint {
        Paint::Default => None,
        Paint::Rgb(r, g, b) => Some(u32::from(r) << 16 | u32::from(g) << 8 | u32::from(b)),
        Paint::Indexed(index) if index < 16 => Some(palette::ANSI[usize::from(index)]),
        Paint::Indexed(index) if index < 232 => {
            let cube = index - 16;
            let (r, g, b) = (cube / 36, (cube % 36) / 6, cube % 6);
            Some(cube_level(r) << 16 | cube_level(g) << 8 | cube_level(b))
        }
        Paint::Indexed(index) => {
            let level = 8 + 10 * u32::from(index - 232);
            Some(level << 16 | level << 8 | level)
        }
    }
}

fn frame_view(frame: Frame) -> FrameView {
    FrameView {
        cols: frame.cols,
        rows: frame.rows,
        cursor: frame.cursor.map(|(row, col)| CursorView { row, col }),
        lines: frame
            .lines
            .into_iter()
            .map(|line| LineView {
                runs: line
                    .runs
                    .into_iter()
                    .map(|run| RunView {
                        text: run.text,
                        fg: resolve(run.fg),
                        bg: resolve(run.bg),
                        bold: run.bold,
                        italic: run.italic,
                        underline: run.underline,
                        inverse: run.inverse,
                        cursor: run.cursor,
                    })
                    .collect(),
            })
            .collect(),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AfterEnd {
    /// The phone fell behind, which says nothing about the terminal. A new snapshot catches up.
    FollowAgain,
    Over(Option<String>),
}

fn after_end(error: Option<RpcError>) -> AfterEnd {
    match error {
        Some(RpcError::FellBehind) => AfterEnd::FollowAgain,
        // The computer cut the stream because the link backed up, not because the terminal ended.
        Some(RpcError::Refused { ref code, .. }) if code == "busy" => AfterEnd::FollowAgain,
        Some(error) => AfterEnd::Over(Some(error.to_string())),
        None => AfterEnd::Over(None),
    }
}

struct Follower {
    client: ManageClient,
    session_id: String,
    attempt: u64,
    done: mpsc::UnboundedSender<Done>,
    grid: Grid,
}

impl Follower {
    fn show(&self, ended: Option<Option<String>>) {
        let session_id = self.session_id.clone();
        let frame = frame_view(self.grid.frame());
        let scrolled = self.grid.scrollback_offset() > 0;
        let apply: Apply = Box::new(move |view| {
            let Some(terminal) = view.terminal.as_mut() else {
                return;
            };
            if terminal.session_id != session_id {
                return;
            }
            terminal.frame = frame;
            terminal.scrolled = scrolled;
            if let Some(reason) = ended {
                terminal.ended = true;
                terminal.end_reason = reason;
            }
        });
        let _ = self.done.send(Done::Apply {
            attempt: self.attempt,
            apply,
        });
    }

    async fn run(mut self, mut scrolls: mpsc::Receiver<i32>) {
        let reason = loop {
            match self.follow_once(&mut scrolls).await {
                AfterEnd::FollowAgain => {}
                AfterEnd::Over(reason) => break reason,
            }
        };
        self.show(Some(reason));
    }

    /// Pushes a frame at most every interval, and always the last one once output stops.
    async fn follow_once(&mut self, scrolls: &mut mpsc::Receiver<i32>) -> AfterEnd {
        let params = json!({ "sessionId": self.session_id });
        let mut stream = match self.client.subscribe(FOLLOW, Some(params)).await {
            Ok(stream) => stream,
            Err(error) => return after_end(Some(error)),
        };
        let mut changed = false;
        let mut next_frame = Instant::now();
        loop {
            tokio::select! {
                event = stream.next() => match event {
                    Some(StreamEvent::Value(value)) => {
                        if let Ok(event) = serde_json::from_value::<FollowEvent>(value) {
                            let Snapshot { data, cols, rows } = event.snapshot;
                            self.grid.apply_snapshot(&data, cols, rows);
                            changed = true;
                        }
                    }
                    Some(StreamEvent::Bytes(bytes)) => {
                        self.grid.feed(&bytes);
                        changed = true;
                    }
                    Some(StreamEvent::Ended(error)) => return after_end(error),
                    None => return AfterEnd::Over(None),
                },
                Some(lines) = scrolls.recv() => {
                    self.grid.scroll_by(lines);
                    changed = true;
                    next_frame = Instant::now();
                }
                () = sleep_until(next_frame), if changed => {
                    self.show(None);
                    changed = false;
                    next_frame = Instant::now() + FRAME_INTERVAL;
                }
            }
        }
    }
}

/// One at a time and in order, so what was typed arrives as it was typed.
async fn write_in_order(
    client: ManageClient,
    session_id: String,
    attempt: u64,
    done: mpsc::UnboundedSender<Done>,
    mut input: mpsc::Receiver<String>,
) {
    while let Some(data) = input.recv().await {
        let params = json!({ "sessionId": session_id, "data": data });
        if let Err(RpcError::Refused { message, .. }) =
            client.call("terminals.write", Some(params)).await
        {
            let apply: Apply = Box::new(move |view| view.error = Some(message));
            let _ = done.send(Done::Apply { attempt, apply });
        }
    }
}

pub(crate) struct OpenTerminal {
    scrolls: mpsc::Sender<i32>,
    input: mpsc::Sender<String>,
    follow: JoinHandle<()>,
}

impl Drop for OpenTerminal {
    fn drop(&mut self) {
        // Ending the task drops the subscription, which tells the computer to stop sending.
        self.follow.abort();
    }
}

impl Runner {
    pub(crate) fn load_terminals(&mut self) {
        // Only a first load shows as loading, so the list does not flicker when it refreshes.
        self.view.terminals_loading = self.view.terminals.is_empty();
        self.call(
            "terminals.list",
            None,
            |view, items: Vec<TerminalDto>| {
                view.terminals = items.into_iter().map(item_of).collect();
                view.terminals_loading = false;
            },
            |view| view.terminals_loading = false,
        );
    }

    pub(crate) fn open_terminal(&mut self, session_id: String) {
        let Some(client) = self.client() else {
            return;
        };
        let title = self
            .view
            .terminals
            .iter()
            .find(|t| t.session_id == session_id)
            .map_or_else(String::new, |t| t.title.clone());
        self.view.error = None;
        self.view.terminal_processes.clear();
        self.view.terminal = Some(TerminalView {
            session_id: session_id.clone(),
            title,
            frame: FrameView {
                cols: 0,
                rows: 0,
                cursor: None,
                lines: Vec::new(),
            },
            scrolled: false,
            ended: false,
            end_reason: None,
        });
        let (input, typed) = mpsc::channel(INPUT_QUEUE);
        let (scrolls, scrolled) = mpsc::channel(SCROLL_QUEUE);
        let attempt = self.attempt;
        tokio::spawn(write_in_order(
            client.clone(),
            session_id.clone(),
            attempt,
            self.done_tx.clone(),
            typed,
        ));
        let follower = Follower {
            client,
            session_id,
            attempt,
            done: self.done_tx.clone(),
            grid: Grid::new(STARTING_COLS, STARTING_ROWS),
        };
        self.open_terminal = Some(OpenTerminal {
            scrolls,
            input,
            follow: tokio::spawn(follower.run(scrolled)),
        });
    }

    pub(crate) fn close_terminal(&mut self) {
        self.open_terminal = None;
        self.view.terminal = None;
        self.view.terminal_processes.clear();
    }

    pub(crate) fn terminal_input(&mut self, data: String) {
        let Some(open) = &self.open_terminal else {
            return;
        };
        if open.input.try_send(data).is_err() {
            self.view.error = Some("This computer isn't keeping up. Try again.".to_owned());
        }
    }

    pub(crate) fn terminal_scroll(&mut self, lines: i32) {
        if let Some(open) = &self.open_terminal {
            // A full queue means a flick is already being applied.
            let _ = open.scrolls.try_send(lines);
        }
    }

    pub(crate) fn load_terminal_processes(&mut self, session_id: String) {
        self.call(
            "terminals.processes",
            Some(json!({ "sessionId": session_id })),
            |view, items: Vec<ProcessDto>| {
                view.terminal_processes = items
                    .into_iter()
                    .map(|p| TerminalProcessView {
                        cpu_label: percent_label(p.cpu_percent),
                        memory_label: bytes_label(p.mem_bytes),
                        name: p.name,
                        cpu_percent: p.cpu_percent,
                        mem_bytes: p.mem_bytes,
                    })
                    .collect();
            },
            |_| {},
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falling_behind_starts_over_instead_of_ending_the_terminal() {
        assert_eq!(after_end(Some(RpcError::FellBehind)), AfterEnd::FollowAgain);
    }

    #[test]
    fn a_link_that_backed_up_follows_again_too() {
        let busy = RpcError::Refused {
            code: "busy".into(),
            message: "x".into(),
        };

        assert_eq!(after_end(Some(busy)), AfterEnd::FollowAgain);
    }

    #[test]
    fn an_end_from_the_computer_keeps_its_reason() {
        let refused = RpcError::Refused {
            code: "failed".into(),
            message: "That terminal is gone.".into(),
        };

        assert_eq!(
            after_end(Some(refused)),
            AfterEnd::Over(Some("That terminal is gone.".into()))
        );
        assert_eq!(after_end(None), AfterEnd::Over(None));
    }

    #[test]
    fn the_256_color_cube_and_grey_ramp_match_xterm() {
        assert_eq!(resolve(Paint::Indexed(16)), Some(0x000000));
        assert_eq!(resolve(Paint::Indexed(196)), Some(0xFF0000));
        assert_eq!(resolve(Paint::Indexed(67)), Some(0x5F87AF));
        assert_eq!(resolve(Paint::Indexed(232)), Some(0x080808));
        assert_eq!(resolve(Paint::Indexed(255)), Some(0xEEEEEE));
    }

    #[test]
    fn the_first_sixteen_are_the_desktops_own_colors() {
        assert_eq!(resolve(Paint::Indexed(1)), Some(palette::ANSI[1]));
        assert_eq!(resolve(Paint::Rgb(1, 2, 3)), Some(0x010203));
        assert_eq!(resolve(Paint::Default), None);
    }
}
