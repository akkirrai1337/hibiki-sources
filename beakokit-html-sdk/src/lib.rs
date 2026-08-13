pub use scraper::{ElementRef, Html, Selector};
use serde_json::Value;

pub const DEFAULT_MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RUNTIME_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_RUNTIME_OPERATION_BYTES: usize = 64;
pub const MAX_RUNTIME_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_HOST_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PACKED_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PAGINATION_OFFSET: i64 = 1_000_000;
pub const MAX_PATH_SEGMENT_BYTES: usize = 256;
pub const HOST_PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_HTTP_TIMEOUT_MILLIS: u64 = 30_000;

/// Build the common host request envelope used by external sources.
/// Keeping this in the SDK prevents individual packages from drifting in
/// protocol version, timeout, or response-size handling.
pub fn host_get_request(
    request_id: &str,
    url: impl Into<String>,
    headers: Value,
    max_response_bytes: u64,
) -> Value {
    serde_json::json!({
        "requestId": format!("{request_id}-http"),
        "operation": "HTTP_REQUEST",
        "payload": {
            "method": "GET",
            "url": url.into(),
            "headers": headers,
            "body": null,
            "timeoutMillis": DEFAULT_HTTP_TIMEOUT_MILLIS,
            "maxResponseBytes": max_response_bytes.min(MAX_HOST_RESPONSE_BYTES as u64)
        },
        "protocolVersion": HOST_PROTOCOL_VERSION
    })
}

/// Decode the packed pointer/length returned by the host ABI before reading it.
///
/// # Safety
/// The caller must invoke this only while the host-owned WASM memory remains
/// valid. The returned pointer and length are checked for null, overflow, and
/// the shared response limit, but only the host can guarantee that the pointer
/// refers to readable memory.
pub unsafe fn unpack_host_response(packed: i64, source: &str) -> Result<&'static [u8], String> {
    if packed < 0 {
        return Err(format!("{source} host HTTP request failed"));
    }
    let packed = packed as u64;
    let pointer = (packed >> 32) as usize;
    let length = (packed & u32::MAX as u64) as usize;
    if length > MAX_PACKED_RESPONSE_BYTES || (pointer == 0 && length > 0) {
        return Err(format!("{source} host response pointer or size is invalid"));
    }
    let Some(end) = pointer.checked_add(length) else {
        return Err(format!("{source} host response pointer or size is invalid"));
    };
    if end > u32::MAX as usize {
        return Err(format!("{source} host response pointer or size is invalid"));
    }
    Ok(if length == 0 { &[] } else { core::slice::from_raw_parts(pointer as *const u8, length) })
}

/// Validate a runtime request pointer and length before a source reads WASM memory.
pub fn validate_runtime_input(pointer: i32, length: i32) -> Result<(), String> {
    if pointer < 0 {
        return Err("runtime request pointer is invalid".to_owned());
    }
    if length < 0 || length as usize > MAX_RUNTIME_REQUEST_BYTES {
        return Err("runtime request exceeds size limit".to_owned());
    }
    if pointer == 0 && length > 0 {
        return Err("runtime request pointer is null".to_owned());
    }
    let Some(end) = (pointer as usize).checked_add(length as usize) else {
        return Err("runtime request pointer or size is invalid".to_owned());
    };
    if end > i32::MAX as usize {
        return Err("runtime request pointer or size is invalid".to_owned());
    }
    Ok(())
}

pub fn parse_year(value: &str) -> Option<i64> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|token| token.len() == 4)
        .filter_map(|token| token.parse::<i64>().ok())
        .find(|year| (1900..=2100).contains(year))
}

/// Normalize a year that may be encoded as a JSON number or a formatted string.
pub fn normalize_year(value: &Value) -> Option<i64> {
    value.as_i64()
        .filter(|year| (1900..=2100).contains(year))
        .or_else(|| value.as_str().and_then(parse_year))
}

pub fn normalize_type(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase().replace(['_', '-'], " ");
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if matches!(value.as_str(), "\u{0441}\u{0435}\u{0440}\u{0438}\u{0430}\u{043b}") { return Some("tv".to_owned()); }
    if matches!(value.as_str(), "\u{0444}\u{0438}\u{043b}\u{044c}\u{043c}") { return Some("movie".to_owned()); }
    match value.as_str() {
        "tv" | "tvseries" | "tv series" | "serial" | "сериал" => Some("tv".to_owned()),
        "movie" | "film" | "фильм" => Some("movie".to_owned()),
        "ova" => Some("ova".to_owned()),
        "ona" => Some("ona".to_owned()),
        _ => None,
    }
}

pub fn normalize_status(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase().replace(['_', '-'], " ");
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if matches!(value.as_str(), "\u{0432}\u{044b}\u{0448}\u{0435}\u{043b}" | "\u{0437}\u{0430}\u{0432}\u{0435}\u{0440}\u{0448}\u{0435}\u{043d}" | "\u{0437}\u{0430}\u{0432}\u{0435}\u{0440}\u{0448}\u{0451}\u{043d}") { return Some("released".to_owned()); }
    if matches!(value.as_str(), "\u{043e}\u{043d}\u{0433}\u{043e}\u{0438}\u{043d}\u{0433}" | "\u{0432}\u{044b}\u{0445}\u{043e}\u{0434}\u{0438}\u{0442}") { return Some("ongoing".to_owned()); }
    if matches!(value.as_str(), "\u{0430}\u{043d}\u{043e}\u{043d}\u{0441}") { return Some("announcement".to_owned()); }
    match value.as_str() {
        "released" | "completed" | "finished" | "finished airing" | "вышел" => Some("released".to_owned()),
        "ongoing" | "airing" | "currently airing" | "releasing" | "онгоинг" | "выходит" => Some("ongoing".to_owned()),
        "announcement" | "announced" | "анонс" => Some("announcement".to_owned()),
        _ => None,
    }
}

pub fn is_http_url(value: &str) -> bool {
    let value = value.trim();
    let remainder = value.strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"));
    let Some(remainder) = remainder else { return false; };
    if value.chars().any(char::is_whitespace) { return false; }
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') { return false; }
    let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
        if host.is_empty() || port.is_empty() || port.parse::<u16>().ok().filter(|port| *port > 0).is_none() {
            return false;
        }
        (host, Some(port))
    } else {
        (authority, None)
    };
    let _ = port;
    is_valid_http_host(host)
}

/// Validate the metadata fields that the client requires for a usable title.
/// Sources should fail the operation instead of returning a partially empty title.
pub fn validate_title_metadata(value: &Value, source: &str, context: &str) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| format!("{source} {context} is not an object"))?;
    let display_name = ["russianName", "originalName", "englishName"]
        .iter()
        .find_map(|key| object.get(*key).and_then(non_empty_text));
    if display_name.is_none() {
        return Err(format!("{source} {context} has no display title"));
    }
    let poster = object.get("posterUrl").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if !is_http_url(poster) {
        return Err(format!("{source} {context} has no usable poster URL"));
    }
    let episode_count = object.get("episodeCount").and_then(Value::as_i64).filter(|count| *count > 0)
        .ok_or_else(|| format!("{source} {context} has no valid episode count"))?;
    if let Some(available) = object.get("availableEpisodeCount").filter(|value| !value.is_null()) {
        let available = available.as_i64().filter(|count| *count >= 0 && *count <= episode_count)
            .ok_or_else(|| format!("{source} {context} has an inconsistent available episode count"))?;
        let _ = available;
    }
    let genres = object.get("genres").and_then(Value::as_array)
        .filter(|genres| !genres.is_empty())
        .ok_or_else(|| format!("{source} {context} has no genres"))?;
    if genres.iter().any(|genre| genre.as_str().map(str::trim).filter(|value| !value.is_empty()).is_none_or(|value| {
        value == value.to_ascii_lowercase() && value.chars().all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
    })) {
        return Err(format!("{source} {context} has service-formatted genres"));
    }
    Ok(())
}

pub fn validate_playback_payload(value: &Value, source: &str) -> Result<(), String> {
    let groups = value.get("groups").and_then(Value::as_array).filter(|groups| !groups.is_empty())
        .ok_or_else(|| format!("{source} playback returned no groups"))?;
    for (group_index, group) in groups.iter().enumerate() {
        let group = group.as_object().ok_or_else(|| format!("{source} playback group {group_index} is invalid"))?;
        for field in ["id", "title"] {
            if group.get(field).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).is_none() {
                return Err(format!("{source} playback group {group_index} has no {field}"));
            }
        }
        let episodes = group.get("episodes").and_then(Value::as_array).filter(|episodes| !episodes.is_empty())
            .ok_or_else(|| format!("{source} playback group {group_index} has no episodes"))?;
        for (episode_index, episode) in episodes.iter().enumerate() {
            let episode = episode.as_object().ok_or_else(|| format!("{source} playback episode {episode_index} is invalid"))?;
            let episode_id = episode.get("id").and_then(Value::as_str).map(str::trim)
                .filter(|value| !value.is_empty() && value.split('/').all(|segment| safe_path_segment(segment).is_some()))
                .ok_or_else(|| format!("{source} playback episode {episode_index} has an unsafe id"))?;
            if episodes.iter().take(episode_index).any(|previous| previous.get("id").and_then(Value::as_str).map(str::trim) == Some(episode_id)) {
                return Err(format!("{source} playback group {group_index} contains duplicate episode IDs"));
            }
            if episode.get("id").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).is_none() {
                return Err(format!("{source} playback episode {episode_index} has no id"));
            }
            if episode.get("number").and_then(Value::as_f64).filter(|number| number.is_finite() && *number > 0.0).is_none() {
                return Err(format!("{source} playback episode {episode_index} has no valid number"));
            }
        }
    }
    Ok(())
}

pub fn validate_player_links_payload(value: &Value, source: &str) -> Result<(), String> {
    let links = value.get("links").and_then(Value::as_array).filter(|links| !links.is_empty())
        .ok_or_else(|| format!("{source} playback returned no player links"))?;
    let mut urls = Vec::new();
    for (index, link) in links.iter().enumerate() {
        let link = link.as_object().ok_or_else(|| format!("{source} player link {index} is invalid"))?;
        let url = link.get("url").and_then(Value::as_str).map(str::trim).filter(|url| is_http_url(url))
            .ok_or_else(|| format!("{source} player link {index} has no valid URL"))?;
        if urls.iter().any(|known| known == url) { return Err(format!("{source} player links contain duplicate URLs")); }
        urls.push(url.to_owned());
        if link.get("type").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).is_none() {
            return Err(format!("{source} player link {index} has no type"));
        }
    }
    Ok(())
}

fn is_valid_http_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    if host.len() > 253 || host.contains(':') || host.ends_with('.') {
        return false;
    }
    let labels = host.split('.').collect::<Vec<_>>();
    if labels.len() == 4 && labels.iter().all(|label| label.bytes().all(|byte| byte.is_ascii_digit())) {
        return labels.iter().all(|label| label.parse::<u8>().is_ok());
    }
    labels.len() >= 2 && labels.into_iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && label.as_bytes().first().is_some_and(|byte| byte.is_ascii_alphanumeric())
            && label.as_bytes().last().is_some_and(|byte| byte.is_ascii_alphanumeric())
    })
}

/// Convert a JSON scalar into a trimmed, non-empty string for protocol IDs.
pub fn non_empty_scalar(value: &Value) -> Option<String> {
    value.as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|value| value.to_string()))
}

/// Return a trimmed, non-empty JSON string for display metadata.
pub fn non_empty_text(value: &Value) -> Option<String> {
    value.as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Return the first non-empty text value from a scalar or an ordered array.
pub fn first_non_empty_text(value: &Value) -> Option<String> {
    non_empty_text(value).or_else(|| value.as_array()?.iter().find_map(first_non_empty_text))
}

/// Extract the first URL-like text from a scalar, array, or JSON-LD image
/// object. The object keys follow the common Schema.org representations.
pub fn first_non_empty_url(value: &Value) -> Option<String> {
    first_non_empty_text(value).or_else(|| {
        ["url", "contentUrl", "@id"].into_iter()
            .find_map(|key| value.get(key).and_then(first_non_empty_url))
    })
}

/// Normalize API counters that may be encoded as either JSON numbers or strings.
pub fn non_negative_i64(value: &Value) -> Option<i64> {
    value.as_i64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse::<i64>().ok()))
        .filter(|value| *value >= 0)
}

pub fn non_negative_finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value).filter(|value| *value >= 0.0)
}

pub fn positive_finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value).filter(|value| *value > 0.0)
}

pub fn positive_finite_value(value: &Value) -> Option<f64> {
    value.as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().replace(',', ".").parse::<f64>().ok()))
        .and_then(positive_finite)
}

pub fn bounded_pagination(payload: &Value) -> (i64, i64) {
    let offset = payload
        .get("offset")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, MAX_PAGINATION_OFFSET);
    let limit = payload.get("limit").and_then(Value::as_i64).unwrap_or(20).clamp(1, 50);
    (offset, limit)
}

pub fn validate_pagination(payload: &Value, source: &str) -> Result<(), String> {
    if let Some(value) = payload.get("offset") {
        let offset = value.as_i64().ok_or_else(|| format!("{source} pagination offset must be an integer"))?;
        if !(0..=MAX_PAGINATION_OFFSET).contains(&offset) {
            return Err(format!("{source} pagination offset is out of range"));
        }
    }
    if let Some(value) = payload.get("limit") {
        let limit = value.as_i64().ok_or_else(|| format!("{source} pagination limit must be an integer"))?;
        if !(1..=50).contains(&limit) {
            return Err(format!("{source} pagination limit is out of range"));
        }
    }
    Ok(())
}

pub fn validate_search_query(payload: &Value, source: &str) -> Result<(), String> {
    let Some(value) = payload.get("query") else { return Ok(()); };
    let query = value.as_str().ok_or_else(|| format!("{source} search query must be a string"))?;
    if query.chars().count() > 256 {
        return Err(format!("{source} search query is too long"));
    }
    if query.chars().any(|character| character.is_control()) {
        return Err(format!("{source} search query contains control characters"));
    }
    Ok(())
}

pub fn validate_string_filters(payload: &Value, fields: &[&str], source: &str) -> Result<(), String> {
    for field in fields {
        let Some(values) = payload.get(*field) else { continue; };
        let values = values.as_array().ok_or_else(|| format!("{source} filter field {field} must be an array"))?;
        for (index, value) in values.iter().enumerate() {
            let value = value.as_str().map(str::trim).filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{source} filter field {field} item {index} must be a string"))?;
            if value.chars().count() > 64 { return Err(format!("{source} filter field {field} item {index} is too long")); }
            if value.chars().any(|character| character.is_control()) { return Err(format!("{source} filter field {field} item {index} contains control characters")); }
        }
    }
    Ok(())
}

pub fn validate_year_range(payload: &Value, source: &str) -> Result<(), String> {
    let from = payload.get("yearFrom").map(|value| normalize_year(value)
        .ok_or_else(|| format!("{source} yearFrom is invalid"))).transpose()?;
    let to = payload.get("yearTo").map(|value| normalize_year(value)
        .ok_or_else(|| format!("{source} yearTo is invalid"))).transpose()?;
    if let (Some(from), Some(to)) = (from, to) {
        if from > to { return Err(format!("{source} year range is inverted")); }
    }
    Ok(())
}

/// Accept only a single conservative URL path segment from source data.
pub fn safe_path_segment(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= MAX_PATH_SEGMENT_BYTES
        && value != "."
        && value != ".."
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
        }))
    .then_some(value)
}

/// Accept only a bounded decimal path segment for endpoints that use numeric IDs.
pub fn safe_numeric_segment(value: &str) -> Option<&str> {
    let value = safe_path_segment(value)?;
    value.bytes().all(|byte| byte.is_ascii_digit()).then_some(value)
}

/// Validate the common envelope before a source dispatches an operation.
pub fn validate_runtime_request(value: &Value) -> Result<String, String> {
    let object = value.as_object().ok_or("runtime request must be an object")?;
    let request_id = object.get("requestId").and_then(Value::as_str).map(str::trim)
        .filter(|value| !value.is_empty()).ok_or("runtime requestId is missing or blank")?;
    if request_id.len() > 128 { return Err("runtime requestId is too long".to_owned()); }
    if request_id.chars().any(char::is_control) { return Err("runtime requestId contains control characters".to_owned()); }
    let operation = object.get("operation").and_then(Value::as_str).map(str::trim)
        .filter(|value| !value.is_empty()).ok_or("runtime operation is missing or blank")?;
    if operation.len() > MAX_RUNTIME_OPERATION_BYTES { return Err("runtime operation is too long".to_owned()); }
    if operation.chars().any(char::is_control) { return Err("runtime operation contains control characters".to_owned()); }
    if let Some(version) = object.get("protocolVersion") {
        if version.as_u64() != Some(HOST_PROTOCOL_VERSION as u64) {
            return Err("unsupported runtime protocol version".to_owned());
        }
    }
    if !object.get("payload").is_some_and(Value::is_object) {
        return Err("runtime payload must be an object".to_owned());
    }
    Ok(request_id.to_owned())
}

/// Keep runtime errors safe and compact for transport to the client UI/log.
pub fn sanitize_runtime_error(value: &str) -> String {
    value.chars()
        .map(|character| if character.is_control() { ' ' } else { character })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1024)
        .collect()
}

/// Return the first non-empty attribute from a fallback list.
pub fn first_attribute(element: ElementRef<'_>, attributes: &[&str]) -> Option<String> {
    attributes.iter().find_map(|attribute| {
        element.value().attr(attribute)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

pub fn attribute(element: ElementRef<'_>, name: &str) -> Option<String> {
    element.value().attr(name).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

#[derive(Debug)]
pub struct HtmlCard<'document> {
    pub element: ElementRef<'document>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HttpSdkError {
    Remote { source: String, message: String },
    InvalidEnvelope { source: String, message: String },
    MissingStatus { source: String },
    Status { source: String, status: u16 },
    MissingBody { source: String },
    BodyTooLarge { source: String, actual: usize, maximum: usize },
}

#[derive(Debug, PartialEq, Eq)]
pub struct HostResponse {
    pub request_id: String,
    pub status_code: u16,
    body: String,
}

impl HostResponse {
    pub fn from_value(value: &Value, source: impl Into<String>) -> Result<Self, HttpSdkError> {
        let source = source.into();
        let protocol = value.get("protocolVersion").and_then(Value::as_u64)
            .ok_or_else(|| HttpSdkError::InvalidEnvelope { source: source.clone(), message: "missing protocol version".to_owned() })?;
        if protocol != HOST_PROTOCOL_VERSION as u64 {
            return Err(HttpSdkError::InvalidEnvelope { source: source.clone(), message: format!("unsupported protocol version {protocol}") });
        }
        if value.get("requestId").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty()).is_none() {
            return Err(HttpSdkError::InvalidEnvelope { source: source.clone(), message: "missing request ID".to_owned() });
        }
        if let Some(message) = value.get("errorMessage").and_then(Value::as_str) {
            return Err(HttpSdkError::Remote { source, message: message.to_owned() });
        }
        if value.get("errorCode").is_some_and(|code| !code.is_null()) {
            return Err(HttpSdkError::InvalidEnvelope { source, message: "error code has no error message".to_owned() });
        }
        let status_code = value.pointer("/payload/statusCode")
            .and_then(Value::as_u64)
            .ok_or_else(|| HttpSdkError::MissingStatus { source: source.clone() })?
            .min(u16::MAX as u64) as u16;
        if !(200..300).contains(&status_code) {
            return Err(HttpSdkError::Status { source, status: status_code });
        }
        let body = value.pointer("/payload/body")
            .and_then(Value::as_str)
            .ok_or(HttpSdkError::MissingBody { source })?;
        Ok(Self { request_id: value.get("requestId").and_then(Value::as_str).unwrap().to_owned(), status_code, body: body.to_owned() })
    }

    pub fn body(&self) -> &str { &self.body }

    pub fn from_value_limited(
        value: &Value,
        source: impl Into<String> + Clone,
        maximum_bytes: usize,
    ) -> Result<Self, HttpSdkError> {
        let response = Self::from_value(value, source.clone())?;
        if response.body.len() > maximum_bytes {
            return Err(HttpSdkError::BodyTooLarge {
                source: source.into(),
                actual: response.body.len(),
                maximum: maximum_bytes,
            });
        }
        Ok(response)
    }

    pub fn from_value_limited_for_request(
        value: &Value,
        source: impl Into<String> + Clone,
        request_id: &str,
        maximum_bytes: usize,
    ) -> Result<Self, HttpSdkError> {
        let response = Self::from_value_limited(value, source.clone(), maximum_bytes)?;
        let expected = format!("{request_id}-http");
        if response.request_id != expected {
            return Err(HttpSdkError::InvalidEnvelope {
                source: source.into(),
                message: format!("request ID does not match expected {expected}"),
            });
        }
        Ok(response)
    }
}

#[derive(Debug)]
pub struct HtmlDocument {
    document: Html,
    base_url: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HtmlSdkError {
    InvalidSelector(String),
    MissingAttribute { selector: String, attribute: String },
    MissingText { selector: String },
    DocumentTooLarge { actual: usize, maximum: usize },
}

impl HtmlDocument {
    pub fn parse(html: &str, base_url: impl Into<String>) -> Self {
        Self { document: Html::parse_document(html), base_url: base_url.into() }
    }

    pub fn parse_limited(
        html: &str,
        base_url: impl Into<String>,
        maximum_bytes: usize,
    ) -> Result<Self, HtmlSdkError> {
        if html.len() > maximum_bytes {
            return Err(HtmlSdkError::DocumentTooLarge { actual: html.len(), maximum: maximum_bytes });
        }
        Ok(Self::parse(html, base_url))
    }

    pub fn select<'document>(
        &'document self,
        selector: &str,
    ) -> Result<Vec<ElementRef<'document>>, HtmlSdkError> {
        let selector = Selector::parse(selector)
            .map_err(|_| HtmlSdkError::InvalidSelector(selector.to_owned()))?;
        Ok(self.document.select(&selector).collect())
    }

    pub fn select_first<'document>(
        &'document self,
        selector: &str,
    ) -> Result<Option<ElementRef<'document>>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().next())
    }

    pub fn select_any<'document>(
        &'document self,
        selectors: &[&str],
    ) -> Result<Vec<ElementRef<'document>>, HtmlSdkError> {
        for selector in selectors {
            let elements = self.select(selector)?;
            if !elements.is_empty() {
                return Ok(elements);
            }
        }
        Ok(Vec::new())
    }

    pub fn text(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().filter_map(clean_element_text).collect())
    }

    pub fn text_first(&self, selector: &str) -> Result<Option<String>, HtmlSdkError> {
        Ok(self.select_first(selector)?.and_then(clean_element_text))
    }

    pub fn text_any(&self, selectors: &[&str]) -> Result<Option<String>, HtmlSdkError> {
        for selector in selectors {
            if let Some(value) = self.text_first(selector)? {
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    /// Read the first non-empty content from Open Graph, Twitter, or other
    /// named meta tags. Matching is case-insensitive for HTML compatibility.
    pub fn meta_content_any(&self, names: &[&str]) -> Result<Option<String>, HtmlSdkError> {
        Ok(self.select("meta")?.into_iter().find_map(|meta| {
            let name = first_attribute(meta, &["property", "name", "itemprop"])?;
            if !names.iter().any(|candidate| name.eq_ignore_ascii_case(candidate)) {
                return None;
            }
            meta.value().attr("content").and_then(clean_text)
        }))
    }

    /// Read valid JSON-LD objects from the page, including objects nested in
    /// a JSON-LD array or an `@graph` container. Invalid optional scripts are
    /// ignored so one unrelated analytics block cannot hide valid metadata.
    pub fn json_ld_documents(&self) -> Result<Vec<Value>, HtmlSdkError> {
        let mut documents = Vec::new();
        for script in self.select("script[type='application/ld+json']")? {
            let body = script.text().collect::<String>();
            let Ok(value) = serde_json::from_str::<Value>(body.trim()) else { continue; };
            match value {
                Value::Array(values) => documents.extend(values.into_iter().filter_map(json_ld_object)),
                value => {
                    if let Some(graph) = value.get("@graph").and_then(Value::as_array) {
                        documents.extend(graph.iter().filter_map(|value| json_ld_object(value.clone())));
                    } else if let Some(value) = json_ld_object(value) {
                        documents.push(value);
                    }
                }
            }
        }
        Ok(documents)
    }

    pub fn required_text_any(&self, selectors: &[&str]) -> Result<String, HtmlSdkError> {
        self.text_any(selectors)?.ok_or_else(|| HtmlSdkError::MissingText {
            selector: selectors.join(" | "),
        })
    }

    pub fn required_text(&self, selector: &str) -> Result<String, HtmlSdkError> {
        self.text_first(selector)?.ok_or_else(|| HtmlSdkError::MissingText { selector: selector.to_owned() })
    }

    pub fn attributes(&self, selector: &str, attribute: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter()
            .filter_map(|element| element.value().attr(attribute).map(str::to_owned))
            .collect())
    }

    pub fn attributes_any(&self, selector: &str, attributes: &[&str]) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().filter_map(|element| {
            attributes.iter().find_map(|attribute| {
                element.value().attr(attribute).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
            })
        }).collect())
    }

    pub fn first_attribute_any(&self, selector: &str, attributes: &[&str]) -> Result<Option<String>, HtmlSdkError> {
        Ok(self.select_first(selector)?.and_then(|element| first_attribute(element, attributes)))
    }

    pub fn required_attribute(
        &self,
        selector: &str,
        attribute: &str,
    ) -> Result<Vec<String>, HtmlSdkError> {
        let selector_value = selector.to_owned();
        let elements = self.select(selector)?;
        if elements.is_empty() {
            return Err(HtmlSdkError::MissingAttribute {
                selector: selector_value,
                attribute: attribute.to_owned(),
            });
        }
        elements.into_iter().map(|element| {
            element.value().attr(attribute)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                HtmlSdkError::MissingAttribute {
                    selector: selector_value.clone(),
                    attribute: attribute.to_owned(),
                }
            })
        }).collect()
    }

    pub fn required_attribute_any(&self, selectors: &[&str], attributes: &[&str]) -> Result<String, HtmlSdkError> {
        for selector in selectors {
            if let Some(value) = self.select(selector)?.into_iter().find_map(|element| first_attribute(element, attributes)) {
                return Ok(value);
            }
        }
        Err(HtmlSdkError::MissingAttribute {
            selector: selectors.join(" | "),
            attribute: attributes.join(" | "),
        })
    }

    pub fn links(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter()
            .filter_map(|element| link_attribute(element).and_then(|value| self.absolute_http_url(&value)))
            .collect())
    }

    pub fn image_urls(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().filter_map(|element| {
            image_attribute(element).and_then(|value| self.absolute_http_url(&value))
        }).collect())
    }

    pub fn first_image_url(&self, selector: &str) -> Result<Option<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().find_map(|element| {
            let value = image_attribute(element)?;
            self.absolute_http_url(&value)
        }))
    }

    /// Extract cards represented by links, retaining the parent DOM element
    /// so callers can read source-specific metadata from the same card.
    pub fn linked_cards<'document>(
        &'document self,
        link_selector: &str,
        title_selectors: &[&str],
        image_selector: &str,
    ) -> Result<Vec<HtmlCard<'document>>, HtmlSdkError> {
        let link_selector = Selector::parse(link_selector)
            .map_err(|_| HtmlSdkError::InvalidSelector(link_selector.to_owned()))?;
        let image_selector = Selector::parse(image_selector)
            .map_err(|_| HtmlSdkError::InvalidSelector(image_selector.to_owned()))?;
        let title_selectors = title_selectors.iter().map(|selector| {
            Selector::parse(selector)
                .map_err(|_| HtmlSdkError::InvalidSelector((*selector).to_owned()))
        }).collect::<Result<Vec<_>, _>>()?;

        Ok(self.document.select(&link_selector).map(|link| {
            let card = link.parent().and_then(ElementRef::wrap).unwrap_or(link);
            let url = link_attribute(link)
                .and_then(|value| self.absolute_http_url(&value));
            let title = first_attribute(link, &["title", "data-title", "data-name", "data-original-title", "data-label", "aria-label"])
                .and_then(|value| clean_text(&value))
                .or_else(|| title_selectors.iter().find_map(|selector| {
                    card.select(selector).find_map(clean_element_text)
                }))
                .or_else(|| card.select(&image_selector).find_map(|image| {
                    first_attribute(image, &["alt", "aria-label"]).and_then(|value| clean_text(&value))
                }))
                .or_else(|| clean_element_text(link));
            let image_url = card.select(&image_selector).find_map(|image| {
                let value = image_attribute(image)?;
                self.absolute_http_url(&value)
            });
            HtmlCard { element: card, url, title, image_url }
        }).collect())
    }

    pub fn linked_cards_unique<'document>(
        &'document self,
        link_selector: &str,
        title_selectors: &[&str],
        image_selector: &str,
    ) -> Result<Vec<HtmlCard<'document>>, HtmlSdkError> {
        let mut seen_urls = Vec::new();
        Ok(self.linked_cards(link_selector, title_selectors, image_selector)?
            .into_iter()
            .filter(|card| {
                let Some(url) = card.url.as_deref() else { return false; };
                if seen_urls.iter().any(|seen| seen == url) { return false; }
                seen_urls.push(url.to_owned());
                true
            })
            .collect())
    }

    /// Read the value from a two-column row such as `<div><label>Type</label>
    /// <span>TV</span></div>`. Matching is based on normalized label text,
    /// not on the exact HTML formatting.
    pub fn labeled_text(&self, row_selector: &str, label: &str) -> Result<Option<String>, HtmlSdkError> {
        let row_selector = Selector::parse(row_selector)
            .map_err(|_| HtmlSdkError::InvalidSelector(row_selector.to_owned()))?;
        let label = normalized_label(label);
        for row in self.document.select(&row_selector) {
            let cells = row.select(&Selector::parse(":scope > *").expect("valid scope selector"))
                .collect::<Vec<_>>();
            for (index, cell) in cells.iter().enumerate() {
                let Some(cell_text) = clean_element_text(*cell).or_else(|| {
                    first_attribute(*cell, &["data-label", "aria-label"])
                }) else { continue; };
                if normalized_label(&cell_text) == label {
                    if let Some(value) = cells.get(index + 1).and_then(|value| clean_element_text(*value)) {
                        return Ok(Some(value));
                    }
                    return Ok(clean_element_text(row)
                        .and_then(|text| text.split_once(':').and_then(|(_, value)| clean_text(value))));
                }
                if let Some((cell_label, cell_value)) = cell_text.split_once(':') {
                    if normalized_label(cell_label) == label {
                        if let Some(value) = clean_text(cell_value) {
                            return Ok(Some(value));
                        }
                        return Ok(clean_element_text(row)
                            .and_then(|text| text.split_once(':').and_then(|(_, value)| clean_text(value))));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Read a labeled value while accepting selector and label fallbacks.
    ///
    /// HTML sources commonly move metadata between `p`, `li`, and small
    /// key/value containers. Keeping the fallback logic here prevents every
    /// source from reimplementing subtly different label matching.
    pub fn labeled_text_any(
        &self,
        row_selectors: &[&str],
        labels: &[&str],
    ) -> Result<Option<String>, HtmlSdkError> {
        for selector in row_selectors {
            for label in labels {
                if let Some(value) = self.labeled_text(selector, label)? {
                    return Ok(Some(value));
                }
            }
        }
        Ok(None)
    }

    pub fn absolute_url(&self, value: &str) -> String {
        let value = value.trim();
        if value.is_empty() || value.starts_with('#') || value.starts_with("data:") || value.starts_with("javascript:") {
            return value.to_owned();
        }
        if let Some((scheme, _)) = value.split_once(':') {
            if !scheme.is_empty() && scheme.chars().enumerate().all(|(index, character)| {
                if index == 0 { character.is_ascii_alphabetic() }
                else { character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.') }
            }) {
                return value.to_owned();
            }
        }
        if value.starts_with("http://") || value.starts_with("https://") { return value.to_owned(); }
        if value.starts_with("//") { return format!("https:{value}"); }
        let base = self.base_url.trim();
        let Some(scheme_end) = base.find("://") else { return value.to_owned(); };
        let authority_start = scheme_end + 3;
        let path_start = base[authority_start..].find('/').map(|index| authority_start + index).unwrap_or(base.len());
        let origin = &base[..path_start];
        let base_path = &base[path_start..];
        let base_path = base_path.split(['?', '#']).next().unwrap_or(base_path);

        if value.starts_with('?') || value.starts_with('#') {
            return format!("{}{}{}", origin, if base_path.is_empty() { "/" } else { base_path }, value);
        }
        let joined_path = if value.starts_with('/') {
            value.to_owned()
        } else {
            let directory = base_path.rsplit_once('/').map(|(directory, _)| directory).unwrap_or("");
            format!("{directory}/{value}")
        };
        format!("{origin}{}", normalize_path(&joined_path))
    }

    pub fn absolute_http_url(&self, value: &str) -> Option<String> {
        let url = self.absolute_url(value);
        is_http_url(&url).then_some(url)
    }
}

pub fn clean_element_text(element: ElementRef<'_>) -> Option<String> {
    let value = element.text().collect::<String>();
    let value = collapse_whitespace(&value);
    (!value.is_empty()).then_some(value)
}

fn clean_text(value: &str) -> Option<String> {
    let value = collapse_whitespace(value);
    (!value.is_empty()).then_some(value)
}

/// Collapse whitespace without allocating a temporary vector of borrowed
/// slices. This keeps DOM text normalization safe on the Android WASM runtime.
fn collapse_whitespace(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() {
            if !normalized.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.push(character);
    }
    normalized
}

fn normalized_label(value: &str) -> String {
    clean_text(value)
        .unwrap_or_default()
        .trim_end_matches(':')
        .trim()
        .to_lowercase()
}

fn srcset_first(value: &str) -> Option<&str> {
    value.split(',').next()?.split_whitespace().next().filter(|value| !value.is_empty())
}

fn image_attribute(element: ElementRef<'_>) -> Option<String> {
    [
        "src",
        "data-src",
        "data-original",
        "data-lazy-src",
        "data-original-src",
        "data-image",
        "data-poster",
        "data-lazy",
        "poster",
    ].into_iter().find_map(|attribute| {
        element.value().attr(attribute)
            .map(str::trim)
            .filter(|value| is_image_candidate(value))
            .map(str::to_owned)
    }).or_else(|| {
        ["srcset", "data-srcset", "data-lazy-srcset"]
            .into_iter()
            .find_map(|attribute| element.value().attr(attribute).and_then(srcset_first)
                .filter(|value| is_image_candidate(value))
                .map(str::to_owned))
    }).or_else(|| {
        ["data-background-image", "data-background", "data-bg"]
            .into_iter()
            .find_map(|attribute| element.value().attr(attribute).map(str::trim)
                .filter(|value| is_image_candidate(value))
                .map(str::to_owned))
    }).or_else(|| {
        element.value().attr("style").and_then(style_url)
            .filter(|value| is_image_candidate(value))
    })
}

fn link_attribute(element: ElementRef<'_>) -> Option<String> {
    first_attribute(element, &["href", "data-href", "data-url", "data-link"])
}

fn json_ld_object(value: Value) -> Option<Value> {
    value.is_object().then_some(value)
}

fn style_url(value: &str) -> Option<String> {
    let start = value.to_ascii_lowercase().find("url(")? + 4;
    let value = value.get(start..)?.split(')').next()?.trim();
    let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
    let value = value.strip_suffix(['\'', '"']).unwrap_or(value);
    (!value.trim().is_empty()).then_some(value.trim().to_owned())
}

fn is_image_candidate(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.starts_with(['#', '?']) || value.starts_with("//") {
        return !value.is_empty() && value.starts_with("//");
    }
    if is_http_url(value) {
        return true;
    }
    !value.contains(':') && !value.starts_with("data")
}

fn normalize_path(value: &str) -> String {
    let leading_slash = value.starts_with('/');
    let trailing_slash = value.ends_with('/');
    let mut segments = Vec::new();
    for segment in value.split('/') {
        match segment {
            "" | "." => {}
            ".." => { segments.pop(); }
            segment => segments.push(segment),
        }
    }
    let mut normalized = segments.join("/");
    if leading_slash { normalized.insert(0, '/'); }
    if trailing_slash && !normalized.ends_with('/') { normalized.push('/'); }
    if normalized.is_empty() { "/".to_owned() } else { normalized }
}

#[derive(Debug)]
pub struct JsonDocument { value: Value }

#[derive(Debug, PartialEq, Eq)]
pub enum JsonSdkError {
    EmptyDocument,
    InvalidJson(String),
    MissingValue { path: String },
    BlankString { path: String },
    ExpectedString { path: String },
    ExpectedInteger { path: String },
    ExpectedBoolean { path: String },
    ExpectedArray { path: String },
    DocumentTooLarge { actual: usize, maximum: usize },
}

impl JsonDocument {
    pub fn parse(body: &str) -> Result<Self, JsonSdkError> {
        if body.trim().is_empty() {
            return Err(JsonSdkError::EmptyDocument);
        }
        serde_json::from_str(body).map(|value| Self { value })
            .map_err(|error| JsonSdkError::InvalidJson(error.to_string()))
    }

    pub fn parse_limited(body: &str, maximum_bytes: usize) -> Result<Self, JsonSdkError> {
        if body.len() > maximum_bytes {
            return Err(JsonSdkError::DocumentTooLarge { actual: body.len(), maximum: maximum_bytes });
        }
        Self::parse(body)
    }

    pub fn value(&self, path: &str) -> Option<&Value> { self.value.pointer(path) }

    pub fn root(&self) -> &Value { &self.value }

    pub fn string(&self, path: &str) -> Result<String, JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_str().map(str::to_owned)
            .ok_or_else(|| JsonSdkError::ExpectedString { path: path.to_owned() })
    }

    pub fn string_any(&self, paths: &[&str]) -> Result<String, JsonSdkError> {
        let mut first_type_error = None;
        for path in paths {
            if let Some(value) = self.value(path) {
                if let Some(value) = value.as_str() {
                    return Ok(value.to_owned());
                }
                if first_type_error.is_none() {
                    first_type_error = Some(JsonSdkError::ExpectedString { path: (*path).to_owned() });
                }
            }
        }
        Err(first_type_error.unwrap_or_else(|| JsonSdkError::MissingValue { path: paths.join(" | ") }))
    }

    pub fn text(&self, path: &str) -> Result<String, JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        non_empty_text(value).ok_or_else(|| if value.is_string() {
            JsonSdkError::BlankString { path: path.to_owned() }
        } else {
            JsonSdkError::ExpectedString { path: path.to_owned() }
        })
    }

    pub fn text_any(&self, paths: &[&str]) -> Result<String, JsonSdkError> {
        let mut first_blank = None;
        let mut first_type_error = None;
        for path in paths {
            if let Some(value) = self.value(path) {
                if let Some(value) = non_empty_text(value) {
                    return Ok(value);
                }
                if value.is_string() {
                    if first_blank.is_none() {
                        first_blank = Some(JsonSdkError::BlankString { path: (*path).to_owned() });
                    }
                } else if first_type_error.is_none() {
                    first_type_error = Some(JsonSdkError::ExpectedString { path: (*path).to_owned() });
                }
            }
        }
        Err(first_blank.or(first_type_error).unwrap_or_else(|| JsonSdkError::MissingValue { path: paths.join(" | ") }))
    }

    pub fn int(&self, path: &str) -> Result<i64, JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_i64().ok_or_else(|| JsonSdkError::ExpectedInteger { path: path.to_owned() })
    }

    pub fn boolean(&self, path: &str) -> Result<bool, JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_bool().ok_or_else(|| JsonSdkError::ExpectedBoolean { path: path.to_owned() })
    }

    pub fn array(&self, path: &str) -> Result<&[Value], JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_array().map(Vec::as_slice).ok_or_else(|| JsonSdkError::ExpectedArray { path: path.to_owned() })
    }

    pub fn html(&self, path: &str, base_url: impl Into<String>) -> Result<HtmlDocument, JsonSdkError> {
        let html = self.string(path)?;
        HtmlDocument::parse_limited(&html, base_url, DEFAULT_MAX_DOCUMENT_BYTES)
            .map_err(|error| match error {
                HtmlSdkError::DocumentTooLarge { actual, maximum } => JsonSdkError::DocumentTooLarge { actual, maximum },
                other => JsonSdkError::InvalidJson(format!("embedded HTML parse failed: {other:?}")),
            })
    }

    pub fn html_any(&self, paths: &[&str], base_url: impl Into<String>) -> Result<HtmlDocument, JsonSdkError> {
        let html = self.string_any(paths)?;
        HtmlDocument::parse_limited(&html, base_url, DEFAULT_MAX_DOCUMENT_BYTES)
            .map_err(|error| match error {
                HtmlSdkError::DocumentTooLarge { actual, maximum } => JsonSdkError::DocumentTooLarge { actual, maximum },
                other => JsonSdkError::InvalidJson(format!("embedded HTML parse failed: {other:?}")),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::{attribute, bounded_pagination, first_attribute, first_non_empty_text, first_non_empty_url, host_get_request, is_http_url, non_empty_scalar, non_empty_text, non_negative_finite, normalize_status, normalize_type, parse_year, positive_finite, positive_finite_value, safe_path_segment, sanitize_runtime_error, unpack_host_response, validate_runtime_input, validate_runtime_request, HostResponse, HttpSdkError, HtmlDocument, HtmlSdkError, JsonDocument, JsonSdkError, Selector, DEFAULT_HTTP_TIMEOUT_MILLIS, DEFAULT_MAX_DOCUMENT_BYTES, HOST_PROTOCOL_VERSION, MAX_PAGINATION_OFFSET, MAX_RUNTIME_REQUEST_BYTES};

    #[test]
    fn builds_a_bounded_host_get_request() {
        let request = host_get_request("search-1", "https://example.org", serde_json::json!({ "Accept": "application/json" }), 4096);
        assert_eq!(request["requestId"], "search-1-http");
        assert_eq!(request["operation"], "HTTP_REQUEST");
        assert_eq!(request["protocolVersion"], HOST_PROTOCOL_VERSION);
        assert_eq!(request["payload"]["timeoutMillis"], DEFAULT_HTTP_TIMEOUT_MILLIS);
        assert_eq!(request["payload"]["maxResponseBytes"], 4096);
        let bounded = host_get_request("search-2", "https://example.org", serde_json::json!({}), u64::MAX);
        assert_eq!(bounded["payload"]["maxResponseBytes"], super::MAX_HOST_RESPONSE_BYTES);
    }

    #[test]
    fn rejects_invalid_packed_host_responses() {
        assert!(unsafe { unpack_host_response(-1, "fixture") }.is_err());
        assert!(unsafe { unpack_host_response(1, "fixture") }.is_err());
        assert!(unsafe { unpack_host_response((u64::from(u32::MAX) << 32) as i64, "fixture") }.is_err());
        assert!(unsafe { unpack_host_response(0, "fixture") }.unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_runtime_inputs() {
        assert!(validate_runtime_input(-1, 0).is_err());
        assert!(validate_runtime_input(0, 1).is_err());
        assert!(validate_runtime_input(1, -1).is_err());
        assert!(validate_runtime_input(1, (MAX_RUNTIME_REQUEST_BYTES + 1) as i32).is_err());
        assert!(validate_runtime_input(1, 64).is_ok());
    }

    #[test]
    fn rejects_non_finite_episode_numbers() {
        assert_eq!(non_negative_finite(-1.0), None);
        assert_eq!(non_negative_finite(f64::NAN), None);
        assert_eq!(non_negative_finite(f64::INFINITY), None);
        assert_eq!(non_negative_finite(2.5), Some(2.5));
        assert_eq!(positive_finite(0.0), None);
        assert_eq!(positive_finite(2.5), Some(2.5));
        assert_eq!(positive_finite_value(&serde_json::json!(" 2,5 ")), Some(2.5));
        assert_eq!(positive_finite_value(&serde_json::json!(0)), None);
    }

    #[test]
    fn trims_blank_display_text() {
        assert_eq!(non_empty_text(&serde_json::json!("  Title  ")), Some("Title".to_owned()));
        assert_eq!(non_empty_text(&serde_json::json!("   ")), None);
        assert_eq!(non_empty_text(&serde_json::json!(42)), None);
        assert_eq!(first_non_empty_text(&serde_json::json!(["  ", "Title", "Other"])), Some("Title".to_owned()));
        assert_eq!(first_non_empty_text(&serde_json::json!([null, ["Nested"]])), Some("Nested".to_owned()));
        assert_eq!(first_non_empty_url(&serde_json::json!({"@type":"ImageObject","contentUrl":"/poster.jpg"})), Some("/poster.jpg".to_owned()));
    }

    #[test]
    fn bounds_pagination_values() {
        let payload = serde_json::json!({"offset": -4, "limit": 500});
        assert_eq!(bounded_pagination(&payload), (0, 50));
        assert_eq!(bounded_pagination(&serde_json::json!({"offset": i64::MAX})), (MAX_PAGINATION_OFFSET, 20));
        assert_eq!(bounded_pagination(&serde_json::json!({})), (0, 20));
    }

    #[test]
    fn parses_cards_and_resolves_urls() {
        let document = HtmlDocument::parse(
            r#"<article class="card"><a href="/anime/test"> Test&nbsp; show </a><img data-src="//cdn.example/test.jpg"></article>"#,
            "https://example.org/catalog",
        );
        assert_eq!(document.text(".card a").unwrap(), ["Test show"]);
        assert_eq!(document.select_any(&[".missing", ".card a"]).unwrap().len(), 1);
        assert_eq!(document.links(".card a").unwrap(), ["https://example.org/anime/test"]);
        let ajax_link = HtmlDocument::parse(r#"<a data-url="/anime/ajax">AJAX title</a>"#, "https://example.org");
        assert_eq!(ajax_link.links("a").unwrap(), ["https://example.org/anime/ajax"]);
        assert_eq!(document.absolute_url("../poster.webp"), "https://example.org/poster.webp");
        assert_eq!(document.absolute_url("?page=2"), "https://example.org/catalog?page=2");
        assert_eq!(document.absolute_url("#results"), "#results");
        assert_eq!(document.image_urls(".card img").unwrap(), ["https://cdn.example/test.jpg"]);
        assert_eq!(document.attributes_any(".card img", &["data-missing", "data-src"]).unwrap(), ["//cdn.example/test.jpg"]);
        let srcset = HtmlDocument::parse(r#"<img srcset="/small.jpg 480w, /large.jpg 960w">"#, "https://example.org");
        assert_eq!(srcset.image_urls("img").unwrap(), ["https://example.org/small.jpg"]);
        let lazy = HtmlDocument::parse(
            r#"<img data-lazy-src="/lazy.jpg"><img data-srcset="/small.webp 480w, /large.webp 960w"><video poster="/poster.jpg"></video>"#,
            "https://example.org",
        );
        assert_eq!(lazy.image_urls("img").unwrap(), ["https://example.org/lazy.jpg", "https://example.org/small.webp"]);
        assert_eq!(lazy.first_image_url("video").unwrap(), Some("https://example.org/poster.jpg".to_owned()));
        let placeholders = HtmlDocument::parse(
            r#"<img src="data:image/gif;base64,placeholder" data-src="/real.jpg"><img src="javascript:void(0)" data-lazy-src="/lazy.webp">"#,
            "https://example.org",
        );
        assert_eq!(placeholders.image_urls("img").unwrap(), ["https://example.org/real.jpg", "https://example.org/lazy.webp"]);
        let backgrounds = HtmlDocument::parse(
            r#"<div data-background-image="/data.jpg"></div><div style="background-image: url('/style.webp')"></div><div style="background-image: url(javascript:alert(1))"></div>"#,
            "https://example.org",
        );
        assert_eq!(backgrounds.image_urls("div").unwrap(), ["https://example.org/data.jpg", "https://example.org/style.webp"]);
        let metadata = HtmlDocument::parse(
            r#"<meta property="OG:TITLE" content=" Demo title "><meta name="twitter:image" content="/meta.webp"><meta name="description" content="Ignored">"#,
            "https://example.org",
        );
        assert_eq!(metadata.meta_content_any(&["og:title"]).unwrap(), Some("Demo title".to_owned()));
        assert_eq!(metadata.meta_content_any(&["twitter:image"]).unwrap(), Some("/meta.webp".to_owned()));
        let json_ld = HtmlDocument::parse(
            r#"<script type="application/ld+json">not json</script><script type="application/ld+json">[{"@type":"TVSeries","name":"Demo"}]</script><script type="application/ld+json">{"@graph":[{"@type":"Movie","name":"Film"}]}</script>"#,
            "https://example.org",
        );
        let json_ld = json_ld.json_ld_documents().unwrap();
        assert_eq!(json_ld.len(), 2);
        assert_eq!(json_ld[0]["name"], "Demo");
        assert_eq!(json_ld[1]["name"], "Film");
        assert_eq!(srcset.absolute_http_url("javascript:alert(1)"), None);
        let image = HtmlDocument::parse(r#"<img data-src="/poster.webp">"#, "https://example.org");
        assert_eq!(image.first_attribute_any("img", &["src", "data-src"]).unwrap(), Some("/poster.webp".to_owned()));
        assert_eq!(image.first_image_url("img").unwrap(), Some("https://example.org/poster.webp".to_owned()));
        let element = image.select_first("img").unwrap().unwrap();
        assert_eq!(first_attribute(element, &["missing", "data-src"]), Some("/poster.webp".to_owned()));
        assert_eq!(attribute(element, "data-src"), Some("/poster.webp".to_owned()));
    }

    #[test]
    fn collapses_whitespace_without_intermediate_slices() {
        assert_eq!(super::collapse_whitespace("  Anime\n\t title  "), "Anime title");
        assert_eq!(super::collapse_whitespace("\n\t"), "");
    }

    #[test]
    fn ignores_non_http_links() {
        let document = HtmlDocument::parse(
            r#"<a href="javascript:alert(1)">bad</a><a href="file:///tmp/file">bad</a><a href="/safe">safe</a>"#,
            "https://example.org",
        );
        assert_eq!(document.links("a").unwrap(), ["https://example.org/safe"]);
    }

    #[test]
    fn ignores_non_http_image_urls() {
        let document = HtmlDocument::parse(
            r#"<img src="javascript:alert(1)"><img src="file:///tmp/poster.jpg"><img src="/safe.jpg">"#,
            "https://example.org/catalog",
        );
        assert_eq!(document.image_urls("img").unwrap(), ["https://example.org/safe.jpg"]);
    }

    #[test]
    fn accepts_only_well_formed_http_hosts() {
        assert!(is_http_url("https://example.org/path"));
        assert!(is_http_url("https://127.0.0.1:8443/path"));
        assert!(is_http_url("https://localhost/path"));
        assert!(!is_http_url("https://-example.org/path"));
        assert!(!is_http_url("https://example..org/path"));
        assert!(!is_http_url("https://example_.org/path"));
        assert!(!is_http_url("https://example.org./path"));
        assert!(!is_http_url("https://999.1.1.1/path"));
    }

    #[test]
    fn extracts_linked_cards_with_fallbacks() {
        let document = HtmlDocument::parse(
            r#"<article class="card"><a href="/anime/demo"><img data-original="/poster.jpg"><span class="name">Demo title</span></a><span class="genre">Action</span></article>"#,
            "https://example.org",
        );
        let cards = document.linked_cards("a[href*='/anime/']", &[".missing", ".name"], "img").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].url.as_deref(), Some("https://example.org/anime/demo"));
        assert_eq!(cards[0].title.as_deref(), Some("Demo title"));
        assert_eq!(cards[0].image_url.as_deref(), Some("https://example.org/poster.jpg"));
        let genre_selector = Selector::parse(".genre").unwrap();
        assert_eq!(cards[0].element.select(&genre_selector).count(), 1);

        let attribute_title = HtmlDocument::parse(
            r#"<article><a href="/anime/attribute-title" data-name="Attribute title"><img data-src="/poster.jpg"></a></article>"#,
            "https://example.org",
        );
        let attribute_cards = attribute_title.linked_cards("a[href*='/anime/']", &[], "img").unwrap();
        assert_eq!(attribute_cards[0].title.as_deref(), Some("Attribute title"));

        let ajax_card = HtmlDocument::parse(
            r#"<article><a data-href="/anime/ajax-card"><span>AJAX card</span></a></article>"#,
            "https://example.org",
        );
        let ajax_cards = ajax_card.linked_cards("a", &[], "img").unwrap();
        assert_eq!(ajax_cards[0].url.as_deref(), Some("https://example.org/anime/ajax-card"));

        let unsafe_document = HtmlDocument::parse(
            r#"<article><a href="/anime/unsafe"><img src="javascript:alert(1)"></a></article>"#,
            "https://example.org",
        );
        let unsafe_cards = unsafe_document.linked_cards("a[href*='/anime/']", &[], "img").unwrap();
        assert_eq!(unsafe_cards[0].image_url, None);

        let unsafe_link_document = HtmlDocument::parse(
            r#"<article><a href="javascript:alert(1)">Unsafe</a></article>"#,
            "https://example.org",
        );
        let unsafe_link_cards = unsafe_link_document.linked_cards("a", &[], "img").unwrap();
        assert_eq!(unsafe_link_cards[0].url, None);

        let duplicate_document = HtmlDocument::parse(
            r#"<a href="/anime/one">One</a><a href="/anime/one">One again</a><a href="/anime/two">Two</a>"#,
            "https://example.org",
        );
        let unique = duplicate_document.linked_cards_unique("a[href*='/anime/']", &[], "img").unwrap();
        assert_eq!(unique.len(), 2);
    }

    #[test]
    fn reports_selector_and_required_field_errors() {
        let document = HtmlDocument::parse(r#"<article class="card"></article>"#, "https://example.org");
        assert_eq!(document.text(".card[").unwrap_err(), HtmlSdkError::InvalidSelector(".card[".to_owned()));
        assert_eq!(document.required_attribute(".card", "data-id").unwrap_err(), HtmlSdkError::MissingAttribute {
            selector: ".card".to_owned(), attribute: "data-id".to_owned()
        });
        let blank_attribute = HtmlDocument::parse(r#"<article class="card" data-id="  "></article>"#, "https://example.org");
        assert_eq!(blank_attribute.required_attribute(".card", "data-id").unwrap_err(), HtmlSdkError::MissingAttribute {
            selector: ".card".to_owned(), attribute: "data-id".to_owned()
        });
        assert_eq!(document.required_text(".card .title").unwrap_err(), HtmlSdkError::MissingText {
            selector: ".card .title".to_owned()
        });
        assert_eq!(document.required_text_any(&[".missing", ".title"]).unwrap_err(), HtmlSdkError::MissingText {
            selector: ".missing | .title".to_owned()
        });
        assert_eq!(document.required_attribute(".missing", "href").unwrap_err(), HtmlSdkError::MissingAttribute {
            selector: ".missing".to_owned(), attribute: "href".to_owned()
        });
        assert_eq!(document.required_attribute_any(&[".missing", ".card"], &["href", "data-id"]).unwrap_err(), HtmlSdkError::MissingAttribute {
            selector: ".missing | .card".to_owned(),
            attribute: "href | data-id".to_owned(),
        });
        let fallback = HtmlDocument::parse(r#"<div class="primary"></div><a class="fallback" href="/fallback"></a>"#, "https://example.org");
        assert_eq!(fallback.required_attribute_any(&[".primary", ".fallback"], &["href"]).unwrap(), "/fallback");
    }

    #[test]
    fn matches_labeled_fields_with_trailing_colons() {
        let document = HtmlDocument::parse(
            r#"<div class="row"><span>Type:</span><span>TV</span></div>"#,
            "https://example.org",
        );
        assert_eq!(document.labeled_text(".row", "type").unwrap(), Some("TV".to_owned()));
    }

    #[test]
    fn matches_inline_labeled_fields() {
        let document = HtmlDocument::parse(
            r#"<div class="row"><span>Type: <strong>TV</strong></span></div>"#,
            "https://example.org",
        );
        assert_eq!(document.labeled_text(".row", "type").unwrap(), Some("TV".to_owned()));
    }

    #[test]
    fn matches_attribute_labeled_fields() {
        let document = HtmlDocument::parse(
            r#"<div class="row"><span data-label="Status"></span><span>Ongoing</span></div>"#,
            "https://example.org",
        );
        assert_eq!(document.labeled_text(".row", "status").unwrap(), Some("Ongoing".to_owned()));
    }

    #[test]
    fn matches_nested_value_after_inline_label() {
        let document = HtmlDocument::parse(
            r#"<div class="anime-info"><p><strong>Studio:</strong><a href="/studio/demo"><span itemprop="name">Diomedea</span></a></p></div>"#,
            "https://example.org",
        );
        assert_eq!(document.labeled_text(".anime-info p", "studio").unwrap(), Some("Diomedea".to_owned()));
    }

    #[test]
    fn parses_html_from_json_envelope() {
        let document = JsonDocument::parse(r#"{"data":{"content":"<div class=\"result\">OK</div>","count":2,"enabled":true,"items":[1]}}"#).unwrap();
        assert_eq!(document.html("/data/content", "https://example.org").unwrap().text(".result").unwrap(), ["OK"]);
        assert_eq!(document.int("/data/count").unwrap(), 2);
        assert!(document.boolean("/data/enabled").unwrap());
        assert_eq!(document.array("/data/items").unwrap().len(), 1);
        assert_eq!(document.string("/data/missing"), Err(JsonSdkError::MissingValue { path: "/data/missing".to_owned() }));
        assert_eq!(document.string_any(&["/data/missing", "/data/content"]).unwrap(), "<div class=\"result\">OK</div>");
        let blank = JsonDocument::parse(r#"{"data":{"content":"  ","html":"<div>Fallback</div>"}}"#).unwrap();
        assert_eq!(blank.text_any(&["/data/content", "/data/html"]).unwrap(), "<div>Fallback</div>");
        assert_eq!(blank.text("/data/content"), Err(JsonSdkError::BlankString { path: "/data/content".to_owned() }));
        assert_eq!(document.html_any(&["/data/missing", "/data/content"], "https://example.org").unwrap().text(".result").unwrap(), ["OK"]);
        let fallback = JsonDocument::parse(r#"{"data":{"content":42,"html":"<div class=\"result\">Fallback</div>"}}"#).unwrap();
        assert_eq!(fallback.html_any(&["/data/content", "/data/html"], "https://example.org").unwrap().text(".result").unwrap(), ["Fallback"]);
        assert_eq!(document.int("/data/missing"), Err(JsonSdkError::MissingValue { path: "/data/missing".to_owned() }));
        assert!(matches!(JsonDocument::parse("  \n"), Err(JsonSdkError::EmptyDocument)));
    }

    #[test]
    fn limits_html_extracted_from_json_envelope() {
        let content = "x".repeat(DEFAULT_MAX_DOCUMENT_BYTES + 1);
        let body = serde_json::json!({ "data": { "content": content } }).to_string();
        let document = JsonDocument::parse(&body).unwrap();
        assert!(matches!(
            document.html("/data/content", "https://example.org"),
            Err(JsonSdkError::DocumentTooLarge { .. })
        ));
    }

    #[test]
    fn rejects_documents_above_limits_before_parsing() {
        assert_eq!(
            HtmlDocument::parse_limited("12345", "https://example.org", 4).unwrap_err(),
            HtmlSdkError::DocumentTooLarge { actual: 5, maximum: 4 }
        );
        assert_eq!(
            JsonDocument::parse_limited("12345", 4).unwrap_err(),
            JsonSdkError::DocumentTooLarge { actual: 5, maximum: 4 }
        );
    }

    #[test]
    fn validates_host_http_response_once() {
        let response = serde_json::json!({ "requestId": "fixture-http", "protocolVersion": 1, "errorCode": null, "errorMessage": null, "payload": { "statusCode": 200, "body": "{}" } });
        let parsed = HostResponse::from_value(&response, "fixture").unwrap();
        assert_eq!(parsed.status_code, 200);
        assert_eq!(parsed.request_id, "fixture-http");
        assert_eq!(parsed.body(), "{}");
        assert_eq!(HostResponse::from_value(&serde_json::json!({ "requestId": "fixture-http", "protocolVersion": 1, "payload": { "statusCode": 503 } }), "fixture"), Err(HttpSdkError::Status { source: "fixture".to_owned(), status: 503 }));
        assert_eq!(HostResponse::from_value(&serde_json::json!({ "requestId": "fixture-http", "protocolVersion": 1, "payload": { "body": "{}" } }), "fixture"), Err(HttpSdkError::MissingStatus { source: "fixture".to_owned() }));
        assert_eq!(HostResponse::from_value_limited(&serde_json::json!({ "requestId": "fixture-http", "protocolVersion": 1, "payload": { "statusCode": 200, "body": "12345" } }), "fixture", 4), Err(HttpSdkError::BodyTooLarge { source: "fixture".to_owned(), actual: 5, maximum: 4 }));
    }

    #[test]
    fn accepts_only_safe_path_segments() {
        assert_eq!(safe_path_segment(" anime-123 "), Some("anime-123"));
        assert!(safe_path_segment("../admin").is_none());
        assert!(safe_path_segment(".").is_none());
        assert!(safe_path_segment("..").is_none());
        assert!(safe_path_segment(&"a".repeat(super::MAX_PATH_SEGMENT_BYTES + 1)).is_none());
        assert_eq!(super::safe_numeric_segment(" 123 "), Some("123"));
        assert!(super::safe_numeric_segment("12a").is_none());
        assert!(safe_path_segment("episode?id=1").is_none());
        assert!(safe_path_segment(" ").is_none());
    }

    #[test]
    fn normalizes_metadata_without_accepting_corrupt_years() {
        assert_eq!(parse_year("1999"), Some(1999));
        assert_eq!(parse_year("1999-06-30"), Some(1999));
        assert_eq!(parse_year("release-20245"), None);
        assert_eq!(parse_year("catalog-1234-release-2024"), Some(2024));
        assert_eq!(super::normalize_year(&serde_json::json!(2024)), Some(2024));
        assert_eq!(super::normalize_year(&serde_json::json!(2430)), None);
        assert_eq!(super::normalize_year(&serde_json::json!("release-2024")), Some(2024));
        assert_eq!(parse_year("title-23659"), None);
        assert_eq!(parse_year("30 июня 1999"), Some(1999));
        assert_eq!(parse_year("2430"), None);
        assert_eq!(parse_year("unknown"), None);
        assert_eq!(normalize_type("TVSERIES"), Some("tv".to_owned()));
        assert_eq!(normalize_type("TV-Series"), Some("tv".to_owned()));
        assert_eq!(normalize_type("TV   Series"), Some("tv".to_owned()));
        assert_eq!(normalize_type("\u{0441}\u{0435}\u{0440}\u{0438}\u{0430}\u{043b}"), Some("tv".to_owned()));
        assert_eq!(normalize_type("\u{0444}\u{0438}\u{043b}\u{044c}\u{043c}"), Some("movie".to_owned()));
        assert_eq!(normalize_status("вышел"), Some("released".to_owned()));
        assert_eq!(normalize_status("finished-airing"), Some("released".to_owned()));
        assert_eq!(normalize_status("currently airing"), Some("ongoing".to_owned()));
        assert_eq!(normalize_status("\u{0432}\u{044b}\u{0448}\u{0435}\u{043b}"), Some("released".to_owned()));
        assert_eq!(normalize_status("\u{043e}\u{043d}\u{0433}\u{043e}\u{0438}\u{043d}\u{0433}"), Some("ongoing".to_owned()));
        assert_eq!(normalize_status("\u{0430}\u{043d}\u{043e}\u{043d}\u{0441}"), Some("announcement".to_owned()));
        assert!(is_http_url("https://example.org/video"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("https://"));
        assert!(!is_http_url("https://example.org/video path"));
        assert!(is_http_url("https://example.org:443/video"));
        assert!(!is_http_url("https://example.org:not-a-port/video"));
        assert!(!is_http_url("https://example.org:0/video"));
        assert!(!is_http_url("https://example.org:65536/video"));
        assert!(!is_http_url("https://user@example.org/video"));
        assert_eq!(non_empty_scalar(&serde_json::json!("  episode-1  ")), Some("episode-1".to_owned()));
        assert_eq!(non_empty_scalar(&serde_json::json!("  ")), None);
        assert_eq!(non_empty_scalar(&serde_json::json!(42)), Some("42".to_owned()));
        assert_eq!(super::non_negative_i64(&serde_json::json!(12)), Some(12));
        assert_eq!(super::non_negative_i64(&serde_json::json!(" 12 ")), Some(12));
        assert!(super::non_negative_i64(&serde_json::json!("-1")).is_none());
        assert_eq!(validate_runtime_request(&serde_json::json!({ "requestId": " search-1 ", "operation": "SEARCH", "payload": {} })).unwrap(), "search-1");
        assert_eq!(validate_runtime_request(&serde_json::json!({ "requestId": "search-1", "operation": "SEARCH", "payload": {}, "protocolVersion": 1 })).unwrap(), "search-1");
        assert!(validate_runtime_request(&serde_json::json!({ "requestId": "search-1", "operation": "SEARCH", "payload": {}, "protocolVersion": 2 })).is_err());
        assert!(validate_runtime_request(&serde_json::json!({ "requestId": "search-1", "operation": "SEARCH", "payload": {}, "protocolVersion": "1" })).is_err());
        assert!(validate_runtime_request(&serde_json::json!({ "requestId": "  ", "operation": "SEARCH", "payload": {} })).is_err());
        assert!(validate_runtime_request(&serde_json::json!({ "requestId": "search\n1", "operation": "SEARCH", "payload": {} })).is_err());
        assert!(validate_runtime_request(&serde_json::json!({ "requestId": "search-1", "operation": "SEA\nRCH", "payload": {} })).is_err());
        assert!(validate_runtime_request(&serde_json::json!({ "requestId": "search-1", "operation": "x".repeat(super::MAX_RUNTIME_OPERATION_BYTES + 1), "payload": {} })).is_err());
        assert!(validate_runtime_request(&serde_json::json!({ "requestId": "search-1", "operation": "SEARCH", "payload": null })).is_err());
        assert_eq!(MAX_RUNTIME_REQUEST_BYTES, 256 * 1024);
        assert_eq!(sanitize_runtime_error("bad\n  response\tvalue"), "bad response value");
        assert_eq!(sanitize_runtime_error(&"x".repeat(2_000)).len(), 1_024);
    }
}
