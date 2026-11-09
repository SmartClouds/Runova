//! Numbers as people read them, written here so both apps say exactly the same thing.

const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

pub(crate) fn bytes_label(bytes: u64) -> String {
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 10.0 || value.fract() == 0.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub(crate) fn percent_label(percent: f64) -> String {
    format!("{percent:.1}%")
}

pub(crate) fn usd_label(amount: f64) -> String {
    format!("${amount:.2}")
}

/// How long until a limit resets, from the milliseconds the computer measured.
pub(crate) fn reset_label(in_ms: i64) -> String {
    let minutes = in_ms / 60_000;
    if minutes <= 0 {
        return "Resets soon".to_owned();
    }
    let (days, hours, minutes) = (minutes / 1440, (minutes % 1440) / 60, minutes % 60);
    match (days, hours) {
        (0, 0) => format!("Resets in {minutes}m"),
        (0, _) => format!("Resets in {hours}h {minutes}m"),
        _ => format!("Resets in {days}d {hours}h"),
    }
}

/// How long ago something was, from the milliseconds the computer measured.
pub(crate) fn ago_label(ago_ms: i64) -> String {
    let minutes = ago_ms / 60_000;
    if minutes <= 0 {
        return "just now".to_owned();
    }
    let (days, hours) = (minutes / 1440, minutes / 60);
    if days > 0 {
        format!("{days}d ago")
    } else if hours > 0 {
        format!("{hours}h ago")
    } else {
        format!("{minutes}m ago")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ago_uses_the_biggest_unit_and_never_says_a_negative() {
        assert_eq!(ago_label(30_000), "just now");
        assert_eq!(ago_label(-5_000), "just now");
        assert_eq!(ago_label(5 * 60_000), "5m ago");
        assert_eq!(ago_label(2 * 3_600_000), "2h ago");
        assert_eq!(ago_label(3 * 86_400_000), "3d ago");
    }

    #[test]
    fn a_reset_uses_the_two_biggest_units() {
        assert_eq!(reset_label(5 * 60_000), "Resets in 5m");
        assert_eq!(reset_label(192 * 60_000), "Resets in 3h 12m");
        assert_eq!(
            reset_label(2 * 86_400_000 + 4 * 3_600_000),
            "Resets in 2d 4h"
        );
    }

    #[test]
    fn a_reset_already_due_says_soon() {
        assert_eq!(reset_label(0), "Resets soon");
        assert_eq!(reset_label(-5000), "Resets soon");
    }

    #[test]
    fn money_has_two_decimals() {
        assert_eq!(usd_label(1.5), "$1.50");
    }

    #[test]
    fn bytes_use_the_biggest_unit_that_fits() {
        assert_eq!(bytes_label(0), "0 B");
        assert_eq!(bytes_label(512), "512 B");
        assert_eq!(bytes_label(2048), "2 KB");
        assert_eq!(bytes_label(1536 * 1024), "1.5 MB");
        assert_eq!(bytes_label(12 * 1024 * 1024 * 1024), "12 GB");
    }

    #[test]
    fn past_the_last_unit_the_number_just_grows() {
        assert_eq!(bytes_label(2048 * 1024 * 1024 * 1024 * 1024), "2048 TB");
    }

    #[test]
    fn percents_keep_one_decimal() {
        assert_eq!(percent_label(12.5), "12.5%");
        assert_eq!(percent_label(0.0), "0.0%");
    }
}
