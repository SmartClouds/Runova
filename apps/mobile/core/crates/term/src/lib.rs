//! A terminal emulator with a capped history. Native code only draws the frames.

/// Lines kept above the screen for the terminal being looked at. Others are not kept at all.
pub const SCROLLBACK_LINES: usize = 2000;
/// A screen bigger than any real terminal would only cost memory.
pub const MAX_COLS: u16 = 500;
pub const MAX_ROWS: u16 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paint {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

impl From<vt100::Color> for Paint {
    fn from(color: vt100::Color) -> Self {
        match color {
            vt100::Color::Default => Paint::Default,
            vt100::Color::Idx(index) => Paint::Indexed(index),
            vt100::Color::Rgb(r, g, b) => Paint::Rgb(r, g, b),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub text: String,
    pub fg: Paint,
    pub bg: Paint,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    /// The one cell the cursor is on, so native code only has to paint it.
    pub cursor: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Line {
    pub runs: Vec<Run>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub cols: u16,
    pub rows: u16,
    /// Row then column, when the cursor is on show.
    pub cursor: Option<(u16, u16)>,
    pub lines: Vec<Line>,
}

pub struct Grid {
    parser: vt100::Parser,
}

fn style(cell: &vt100::Cell) -> (Paint, Paint, bool, bool, bool, bool) {
    (
        cell.fgcolor().into(),
        cell.bgcolor().into(),
        cell.bold(),
        cell.italic(),
        cell.underline(),
        cell.inverse(),
    )
}

impl Grid {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, SCROLLBACK_LINES),
        }
    }

    /// Starts over from a serialized screen, at that screen's size.
    pub fn apply_snapshot(&mut self, data: &str, cols: u16, rows: u16) {
        let (cols, rows) = (cols.clamp(1, MAX_COLS), rows.clamp(1, MAX_ROWS));
        self.parser = vt100::Parser::new(rows, cols, SCROLLBACK_LINES);
        self.parser.process(data.as_bytes());
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    /// Positive goes back in time. Stops at both ends.
    pub fn scroll_by(&mut self, lines: i32) {
        let screen = self.parser.screen_mut();
        let target = (screen.scrollback() as i64)
            .saturating_add(i64::from(lines))
            .max(0);
        screen.set_scrollback(usize::try_from(target).unwrap_or(usize::MAX));
    }

    pub fn scrollback_offset(&self) -> u32 {
        self.parser.screen().scrollback() as u32
    }

    pub fn frame(&self) -> Frame {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let cursor =
            (!screen.hide_cursor() && screen.scrollback() == 0).then(|| screen.cursor_position());
        let lines = (0..rows)
            .map(|row| {
                let cursor_col = cursor.filter(|(at, _)| *at == row).map(|(_, col)| col);
                Self::line(screen, row, cols, cursor_col)
            })
            .collect();
        Frame {
            cols,
            rows,
            cursor,
            lines,
        }
    }

    fn line(screen: &vt100::Screen, row: u16, cols: u16, cursor: Option<u16>) -> Line {
        let mut runs: Vec<Run> = Vec::new();
        for col in 0..cols {
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };
            if cell.is_wide_continuation() {
                continue;
            }
            let (fg, bg, bold, italic, underline, inverse) = style(cell);
            let on_cursor = cursor == Some(col);
            let contents = if cell.has_contents() {
                cell.contents()
            } else {
                " "
            };
            match runs.last_mut() {
                Some(run)
                    if !on_cursor
                        && !run.cursor
                        && (
                            run.fg,
                            run.bg,
                            run.bold,
                            run.italic,
                            run.underline,
                            run.inverse,
                        ) == (fg, bg, bold, italic, underline, inverse) =>
                {
                    run.text.push_str(contents);
                }
                _ => runs.push(Run {
                    text: contents.to_owned(),
                    fg,
                    bg,
                    bold,
                    italic,
                    underline,
                    inverse,
                    cursor: on_cursor,
                }),
            }
        }
        // A blank tail costs memory and draws nothing.
        if let Some(last) = runs.last_mut()
            && last.bg == Paint::Default
            && !last.inverse
            && !last.cursor
        {
            let kept = last.text.trim_end().len();
            last.text.truncate(kept);
            if last.text.is_empty() {
                runs.pop();
            }
        }
        Line { runs }
    }
}
