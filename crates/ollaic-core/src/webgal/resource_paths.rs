use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

const PATH_CHARACTERS: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn external(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

pub fn encode(value: &str) -> String {
    if external(value) {
        return value.to_owned();
    }
    utf8_percent_encode(value, PATH_CHARACTERS).to_string()
}

pub fn decode(value: &str) -> String {
    let value = crate::document::unescape_literal(value);
    if external(&value) {
        return value;
    }
    percent_decode_str(&value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .unwrap_or(value)
}

pub fn encode_voice(value: &str) -> String {
    if external(value) {
        value.to_owned()
    } else {
        format!("./game/vocal/{}", encode(value))
    }
}

pub fn decode_voice(value: &str) -> String {
    decode(
        value
            .strip_prefix("./game/vocal/")
            .or_else(|| value.strip_prefix("/game/vocal/"))
            .unwrap_or(value),
    )
}
