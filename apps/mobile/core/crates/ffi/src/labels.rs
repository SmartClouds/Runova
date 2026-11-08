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

#[cfg(test)]
mod tests {
    use super::*;

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
