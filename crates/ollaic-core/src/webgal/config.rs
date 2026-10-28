use std::ops::Range;

pub struct ConfigEntry<'a> {
    pub key: &'a str,
    pub value: &'a str,
    pub value_range: Range<usize>,
}

pub fn parse_line(line: &str) -> Option<ConfigEntry<'_>> {
    let statement = &line[..line.find(';').unwrap_or(line.len())];
    let colon = statement.find(':')?;
    let key = statement[..colon].trim();
    if key.is_empty() {
        return None;
    }
    let raw = &statement[colon + 1..];
    let raw = &raw[..raw.find(" -").unwrap_or(raw.len())];
    let value = raw.trim();
    let start = colon + 1 + raw.len() - raw.trim_start().len();
    Some(ConfigEntry {
        key,
        value,
        value_range: start..start + value.len(),
    })
}
