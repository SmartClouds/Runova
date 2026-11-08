use runova_term::{Grid, MAX_COLS, MAX_ROWS, Paint, SCROLLBACK_LINES};

fn text(grid: &Grid) -> Vec<String> {
    grid.frame()
        .lines
        .iter()
        .map(|line| {
            line.runs
                .iter()
                .map(|run| run.text.as_str())
                .collect::<String>()
        })
        .map(|line| line.trim_end().to_owned())
        .collect()
}

#[test]
fn plain_text_lands_on_the_screen() {
    let mut grid = Grid::new(20, 3);

    grid.feed(b"hello\r\nworld");

    assert_eq!(text(&grid), ["hello", "world", ""]);
}

#[test]
fn a_frame_says_how_big_it_is_and_where_the_cursor_is() {
    let mut grid = Grid::new(20, 3);

    grid.feed(b"ab");
    let frame = grid.frame();

    assert_eq!((frame.cols, frame.rows), (20, 3));
    assert_eq!(frame.cursor, Some((0, 2)));
}

#[test]
fn a_hidden_cursor_is_not_reported() {
    let mut grid = Grid::new(20, 3);

    grid.feed(b"\x1b[?25l");

    assert_eq!(grid.frame().cursor, None);
}

#[test]
fn a_snapshot_replaces_the_screen_and_takes_its_size() {
    let mut grid = Grid::new(20, 3);
    grid.feed(b"old");

    grid.apply_snapshot("\x1b[2J\x1b[Hnew", 40, 10);
    let frame = grid.frame();

    assert_eq!((frame.cols, frame.rows), (40, 10));
    assert_eq!(text(&grid)[0], "new");
}

#[test]
fn a_snapshot_of_no_size_or_a_silly_size_stays_usable() {
    let mut grid = Grid::new(20, 3);

    grid.apply_snapshot("x", 0, 0);
    assert_eq!((grid.frame().cols, grid.frame().rows), (1, 1));

    grid.apply_snapshot("x", u16::MAX, u16::MAX);
    assert_eq!((grid.frame().cols, grid.frame().rows), (MAX_COLS, MAX_ROWS));
}

#[test]
fn neighbouring_cells_with_one_style_are_one_run() {
    let mut grid = Grid::new(20, 1);

    grid.feed(b"\x1b[32mgreen\x1b[0m plain");
    let runs = &grid.frame().lines[0].runs;

    assert_eq!(runs[0].text, "green");
    assert_eq!(runs[0].fg, Paint::Indexed(2));
    assert_eq!(runs[1].fg, Paint::Default);
    assert!(runs[1].text.starts_with(" plain"));
}

#[test]
fn true_color_bold_underline_and_inverse_are_kept() {
    let mut grid = Grid::new(20, 1);

    grid.feed(b"\x1b[1;4;7;38;2;10;20;30;48;2;40;50;60mx");
    let run = &grid.frame().lines[0].runs[0];

    assert_eq!(run.fg, Paint::Rgb(10, 20, 30));
    assert_eq!(run.bg, Paint::Rgb(40, 50, 60));
    assert!(run.bold && run.underline && run.inverse);
}

#[test]
fn a_character_split_across_two_reads_still_arrives_whole() {
    let mut grid = Grid::new(20, 1);
    let bytes = "é".as_bytes();

    grid.feed(&bytes[..1]);
    grid.feed(&bytes[1..]);

    assert_eq!(text(&grid)[0], "é");
}

#[test]
fn a_wide_character_takes_two_columns_but_is_written_once() {
    let mut grid = Grid::new(20, 1);

    grid.feed("界x".as_bytes());
    let frame = grid.frame();
    let line: String = frame.lines[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect();

    assert!(line.starts_with("界x"));
    assert_eq!(frame.cursor, Some((0, 3)));
}

#[test]
fn the_cell_under_the_cursor_is_its_own_run() {
    let mut grid = Grid::new(20, 1);

    grid.feed(b"abc\x1b[2D");
    let runs = grid.frame().lines.remove(0).runs;

    let marked: Vec<&str> = runs
        .iter()
        .filter(|r| r.cursor)
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(marked, ["b"]);
    assert_eq!(runs[0].text, "a");
}

#[test]
fn a_cursor_past_the_end_of_the_text_is_still_drawn() {
    let mut grid = Grid::new(20, 1);

    grid.feed(b"ab");
    let runs = grid.frame().lines.remove(0).runs;

    assert!(runs.last().unwrap().cursor);
    assert_eq!(runs.last().unwrap().text, " ");
}

#[test]
fn scrolled_back_there_is_no_cursor_to_draw() {
    let mut grid = Grid::new(20, 1);
    grid.feed(b"one\r\ntwo");

    grid.scroll_by(1);

    assert!(grid.frame().lines[0].runs.iter().all(|r| !r.cursor));
}

#[test]
fn scrolling_back_shows_older_lines_and_stops_at_the_top() {
    let mut grid = Grid::new(20, 2);
    grid.feed(b"one\r\ntwo\r\nthree\r\nfour");

    grid.scroll_by(2);
    assert_eq!(text(&grid), ["one", "two"]);

    grid.scroll_by(100);
    assert_eq!(text(&grid), ["one", "two"]);
    assert_eq!(grid.scrollback_offset(), 2);

    grid.scroll_by(-100);
    assert_eq!(text(&grid), ["three", "four"]);
}

#[test]
fn new_output_keeps_a_scrolled_view_where_it_is_reading() {
    let mut grid = Grid::new(20, 2);
    grid.feed(b"one\r\ntwo\r\nthree\r\nfour");
    grid.scroll_by(1);

    grid.feed(b"\r\nfive");

    assert_eq!(text(&grid), ["two", "three"]);
}

#[test]
fn history_is_capped_however_much_is_printed() {
    let mut grid = Grid::new(20, 2);

    for n in 0..(SCROLLBACK_LINES * 3) {
        grid.feed(format!("line {n}\r\n").as_bytes());
    }
    grid.scroll_by(i32::MAX);

    assert_eq!(grid.scrollback_offset() as usize, SCROLLBACK_LINES);
}

#[test]
fn broken_escape_sequences_do_no_harm() {
    let mut grid = Grid::new(20, 1);

    grid.feed(b"\x1b[999;999;999;mok\x1b");
    grid.feed(b"]0;title\x07");

    assert!(text(&grid)[0].contains("ok"));
}
