pub use scraper::{ElementRef, Html, Selector};
use serde_json::Value;

pub const DEFAULT_MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RUNTIME_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_RUNTIME_OPERATION_BYTES: usize = 64;
pub const MAX_RUNTIME_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_HOST_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
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

pub fn parse_year(value: &str) -> Option<i64> {
    let year_token = value
        .split(|character: char| !character.is_ascii_digit())
        .find(|token| token.len() == 4)?;
    let year = year_token.parse::<i64>().ok()?;
    (1900..=2100).contains(&year).then_some(year)
}

pub fn normalize_type(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase().replace(['_', '-'], " ");
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
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
    !host.is_empty() && !host.contains(':')
}

/// Convert a JSON scalar into a trimmed, non-empty string for protocol IDs.
pub fn non_empty_scalar(value: &Value) -> Option<String> {
    value.as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|value| value.to_string()))
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
    MissingStatus { source: String },
    Status { source: String, status: u16 },
    MissingBody { source: String },
    BodyTooLarge { source: String, actual: usize, maximum: usize },
}

#[derive(Debug, PartialEq, Eq)]
pub struct HostResponse {
    pub status_code: u16,
    body: String,
}

impl HostResponse {
    pub fn from_value(value: &Value, source: impl Into<String>) -> Result<Self, HttpSdkError> {
        let source = source.into();
        if let Some(message) = value.get("errorMessage").and_then(Value::as_str) {
            return Err(HttpSdkError::Remote { source, message: message.to_owned() });
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
        Ok(Self { status_code, body: body.to_owned() })
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
        self.select(selector)?.into_iter().map(|element| {
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
        self.select_any(selectors)?.into_iter().find_map(|element| first_attribute(element, attributes))
            .ok_or_else(|| HtmlSdkError::MissingAttribute {
                selector: selectors.join(" | "),
                attribute: attributes.join(" | "),
            })
    }

    pub fn links(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        self.attributes(selector, "href")
            .map(|values| values.into_iter().filter_map(|value| self.absolute_http_url(&value)).collect())
    }

    pub fn image_urls(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().filter_map(|element| {
            let value = ["src", "data-src", "data-original"]
                .into_iter().find_map(|attribute| element.value().attr(attribute).map(str::trim).filter(|value| !value.is_empty()))
                .or_else(|| element.value().attr("srcset").and_then(srcset_first));
            value.and_then(|value| self.absolute_http_url(value))
        }).collect())
    }

    pub fn first_image_url(&self, selector: &str) -> Result<Option<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().find_map(|element| {
            let value = first_attribute(element, &["src", "data-src", "data-original"])
                .or_else(|| element.value().attr("srcset").and_then(srcset_first).map(str::to_owned))?;
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
            let url = first_attribute(link, &["href"])
                .and_then(|value| self.absolute_http_url(&value));
            let title = first_attribute(link, &["title", "data-title"])
                .and_then(|value| clean_text(&value))
                .or_else(|| title_selectors.iter().find_map(|selector| {
                    card.select(selector).find_map(clean_element_text)
                }))
                .or_else(|| clean_element_text(link));
            let image_url = card.select(&image_selector).find_map(|image| {
                let value = first_attribute(image, &["src", "data-src", "data-original"])
                    .or_else(|| image.value().attr("srcset").and_then(srcset_first).map(str::to_owned))?;
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
        let label = clean_text(label).unwrap_or_default();
        for row in self.document.select(&row_selector) {
            let cells = row.select(&Selector::parse(":scope > *").expect("valid scope selector"))
                .collect::<Vec<_>>();
            for (index, cell) in cells.iter().enumerate() {
                if clean_element_text(*cell).as_deref() == Some(label.as_str()) {
                    return Ok(cells.get(index + 1).and_then(|value| clean_element_text(*value)));
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
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

fn clean_text(value: &str) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

fn srcset_first(value: &str) -> Option<&str> {
    value.split(',').next()?.split_whitespace().next().filter(|value| !value.is_empty())
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
        for path in paths {
            if let Some(value) = self.value(path) {
                return value.as_str().map(str::to_owned)
                    .ok_or_else(|| JsonSdkError::ExpectedString { path: (*path).to_owned() });
            }
        }
        Err(JsonSdkError::MissingValue { path: paths.join(" | ") })
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
    use super::{attribute, first_attribute, host_get_request, is_http_url, non_empty_scalar, normalize_status, normalize_type, parse_year, safe_path_segment, sanitize_runtime_error, validate_runtime_request, HostResponse, HttpSdkError, HtmlDocument, HtmlSdkError, JsonDocument, JsonSdkError, Selector, DEFAULT_HTTP_TIMEOUT_MILLIS, DEFAULT_MAX_DOCUMENT_BYTES, HOST_PROTOCOL_VERSION, MAX_RUNTIME_REQUEST_BYTES};

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
    fn parses_cards_and_resolves_urls() {
        let document = HtmlDocument::parse(
            r#"<article class="card"><a href="/anime/test"> Test&nbsp; show </a><img data-src="//cdn.example/test.jpg"></article>"#,
            "https://example.org/catalog",
        );
        assert_eq!(document.text(".card a").unwrap(), ["Test show"]);
        assert_eq!(document.select_any(&[".missing", ".card a"]).unwrap().len(), 1);
        assert_eq!(document.links(".card a").unwrap(), ["https://example.org/anime/test"]);
        assert_eq!(document.absolute_url("../poster.webp"), "https://example.org/poster.webp");
        assert_eq!(document.absolute_url("?page=2"), "https://example.org/catalog?page=2");
        assert_eq!(document.absolute_url("#results"), "#results");
        assert_eq!(document.image_urls(".card img").unwrap(), ["https://cdn.example/test.jpg"]);
        assert_eq!(document.attributes_any(".card img", &["data-missing", "data-src"]).unwrap(), ["//cdn.example/test.jpg"]);
        let srcset = HtmlDocument::parse(r#"<img srcset="/small.jpg 480w, /large.jpg 960w">"#, "https://example.org");
        assert_eq!(srcset.image_urls("img").unwrap(), ["https://example.org/small.jpg"]);
        assert_eq!(srcset.absolute_http_url("javascript:alert(1)"), None);
        let image = HtmlDocument::parse(r#"<img data-src="/poster.webp">"#, "https://example.org");
        assert_eq!(image.first_attribute_any("img", &["src", "data-src"]).unwrap(), Some("/poster.webp".to_owned()));
        assert_eq!(image.first_image_url("img").unwrap(), Some("https://example.org/poster.webp".to_owned()));
        let element = image.select_first("img").unwrap().unwrap();
        assert_eq!(first_attribute(element, &["missing", "data-src"]), Some("/poster.webp".to_owned()));
        assert_eq!(attribute(element, "data-src"), Some("/poster.webp".to_owned()));
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
        assert_eq!(document.required_attribute_any(&[".missing", ".card"], &["href", "data-id"]).unwrap_err(), HtmlSdkError::MissingAttribute {
            selector: ".missing | .card".to_owned(),
            attribute: "href | data-id".to_owned(),
        });
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
        assert_eq!(document.html_any(&["/data/missing", "/data/content"], "https://example.org").unwrap().text(".result").unwrap(), ["OK"]);
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
        let response = serde_json::json!({ "payload": { "statusCode": 200, "body": "{}" } });
        let parsed = HostResponse::from_value(&response, "fixture").unwrap();
        assert_eq!(parsed.status_code, 200);
        assert_eq!(parsed.body(), "{}");
        assert_eq!(HostResponse::from_value(&serde_json::json!({ "payload": { "statusCode": 503 } }), "fixture"), Err(HttpSdkError::Status { source: "fixture".to_owned(), status: 503 }));
        assert_eq!(HostResponse::from_value(&serde_json::json!({ "payload": { "body": "{}" } }), "fixture"), Err(HttpSdkError::MissingStatus { source: "fixture".to_owned() }));
        assert_eq!(HostResponse::from_value_limited(&serde_json::json!({ "payload": { "statusCode": 200, "body": "12345" } }), "fixture", 4), Err(HttpSdkError::BodyTooLarge { source: "fixture".to_owned(), actual: 5, maximum: 4 }));
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
        assert_eq!(parse_year("title-23659"), None);
        assert_eq!(parse_year("30 июня 1999"), Some(1999));
        assert_eq!(parse_year("2430"), None);
        assert_eq!(parse_year("unknown"), None);
        assert_eq!(normalize_type("TVSERIES"), Some("tv".to_owned()));
        assert_eq!(normalize_type("TV-Series"), Some("tv".to_owned()));
        assert_eq!(normalize_type("TV   Series"), Some("tv".to_owned()));
        assert_eq!(normalize_status("вышел"), Some("released".to_owned()));
        assert_eq!(normalize_status("finished-airing"), Some("released".to_owned()));
        assert_eq!(normalize_status("currently airing"), Some("ongoing".to_owned()));
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
        assert_eq!(validate_runtime_request(&serde_json::json!({ "requestId": " search-1 ", "operation": "SEARCH", "payload": {} })).unwrap(), "search-1");
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
