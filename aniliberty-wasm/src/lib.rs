use serde::{Deserialize, Serialize};
use beakokit_html_sdk::{host_get_request, is_http_url, non_empty_scalar, non_negative_i64, normalize_type, normalize_year, safe_path_segment, sanitize_runtime_error, validate_runtime_request, HostResponse, JsonDocument, DEFAULT_MAX_DOCUMENT_BYTES, MAX_HOST_RESPONSE_BYTES, MAX_RUNTIME_REQUEST_BYTES, MAX_RUNTIME_RESPONSE_BYTES};
use serde_json::{json, Value};

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
const DEFAULT_BASE_URL: &str = "https://anilibria.top/api/v1";
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)]
enum RuntimeOperation {
    #[serde(rename = "SEARCH")]
    Search,
    #[serde(rename = "FILTER_CATALOG")]
    FilterCatalog,
    #[serde(rename = "DETAILS")]
    Details,
    #[serde(rename = "PLAYBACK_GROUPS")]
    PlaybackGroups,
    #[serde(rename = "PLAYER_LINKS")]
    PlayerLinks,
}

#[derive(Deserialize)]
struct RuntimeRequest {
    #[serde(rename = "requestId")]
    request_id: String,
    operation: RuntimeOperation,
    payload: Value,
}

#[derive(Serialize)]
struct RuntimeResponse {
    #[serde(rename = "requestId")]
    request_id: String,
    payload: Option<Value>,
    #[serde(rename = "errorCode")]
    error_code: Option<&'static str>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
}

fn runtime_error(request_id: String, message: impl Into<String>) -> Vec<u8> {
    let message = sanitize_runtime_error(&message.into());
    serde_json::to_vec(&RuntimeResponse {
        request_id,
        payload: None,
        error_code: Some("SOURCE_FAILURE"),
        error_message: Some(message),
        protocol_version: RUNTIME_PROTOCOL_VERSION,
    })
    .unwrap_or_else(|_| b"{\"requestId\":\"guest-error\",\"payload\":null,\"errorCode\":\"RUNTIME_FAILURE\",\"errorMessage\":\"serialization failed\",\"protocolVersion\":1}".to_vec())
}

fn host_http(request_id: &str, url: String) -> Result<String, String> {
    let request = host_get_request(request_id, url, json!({ "Accept": "application/json" }), MAX_RESPONSE_BYTES);
    let request_bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let packed = unsafe { host_call(request_bytes.as_ptr(), request_bytes.len() as i32) };
    if packed < 0 {
        return Err("host HTTP request failed".to_owned());
    }
    let response_ptr = (packed as u64 >> 32) as usize;
    let response_len = (packed as u64 & u32::MAX as u64) as usize;
    let response = unsafe { core::slice::from_raw_parts(response_ptr as *const u8, response_len) };
    if response.len() > MAX_HOST_RESPONSE_BYTES {
        return Err("AniLiberty host response exceeds size limit".to_owned());
    }
    let response: Value = serde_json::from_slice(response).map_err(|error| error.to_string())?;
    HostResponse::from_value_limited(&response, "AniLiberty", MAX_RESPONSE_BYTES as usize)
        .map(|response| response.body().to_owned())
        .map_err(|error| format!("AniLiberty HTTP response invalid: {error:?}"))
}

fn api_url(path: &str) -> String {
    format!("{DEFAULT_BASE_URL}/{path}")
}

fn encode_query(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            byte => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn title(value: &Value) -> Option<Value> {
    let id = value.get("id")?.to_string_value()?;
    let names = value.get("name").and_then(Value::as_object)?;
    let main_name = names
        .get("main")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let english_name = names
        .get("english")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let original_name = english_name.unwrap_or(main_name);
    let poster = value.get("poster").and_then(Value::as_object);
    let poster_path = poster
        .and_then(|poster| poster.get("optimized"))
        .and_then(Value::as_object)
        .and_then(|optimized| optimized.get("src"))
        .and_then(Value::as_str)
        .or_else(|| {
            poster
                .and_then(|poster| poster.get("src"))
                .and_then(Value::as_str)
        });
    let raw_type = value.get("type").and_then(|value| value.get("value")).and_then(Value::as_str);
    let type_alias = raw_type.and_then(normalize_type).or_else(|| raw_type.map(str::to_owned));
    let year = value.get("year").and_then(normalize_year);
    let description = value.get("description").and_then(Value::as_str)
        .map(str::trim)
        .filter(|description| !description.is_empty())
        .unwrap_or(main_name);
    Some(json!({
        "id": id,
        "russianName": main_name,
        "englishName": english_name,
        "originalName": original_name,
        "japaneseName": null,
        "synonyms": names.get("alternative").and_then(Value::as_str).unwrap_or("").split(',').map(str::trim).filter(|value| !value.is_empty()).collect::<Vec<_>>(),
        "year": year,
        "type": type_alias,
        "episodeCount": value.get("episodes_total").and_then(non_negative_i64),
        "posterUrl": poster_path.map(|path| if path.starts_with("http") { path.to_owned() } else { format!("https://anilibria.top{path}") }),
        "status": value.get("is_ongoing").and_then(Value::as_bool).map(|ongoing| if ongoing { "ongoing" } else { "released" }),
        "description": description,
        "nextEpisodeAt": null,
        "genres": value.get("genres").and_then(Value::as_array).map(|genres| genres.iter().filter_map(|genre| genre.get("name").or_else(|| genre.get("description"))).filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default(),
        "ratings": [], "ageRating": null, "viewCount": null, "screenshots": [], "trailer": null,
        "sourceMaterial": null, "studios": [], "mainCharacters": [], "similarAnime": [],
        "franchiseAnime": [], "relatedAnime": [], "season": null, "availableEpisodeCount": null,
        "posterFallbackUrl": null
    }))
}

fn release_value(body: &str) -> Result<Value, String> {
    let value = json_body(body, "release")?;
    Ok(value.get("data").cloned().unwrap_or(value))
}

fn json_body(body: &str, operation: &str) -> Result<Value, String> {
    JsonDocument::parse_limited(body, DEFAULT_MAX_DOCUMENT_BYTES)
        .map(|document| document.root().clone())
        .map_err(|error| format!("AniLiberty {operation} JSON parse failed: {error:?}"))
}

fn release(request_id: &str, id: &str) -> Result<Value, String> {
    let id = safe_path_segment(id).ok_or("AniLiberty release id is invalid")?;
    host_http(request_id, api_url(&format!("anime/releases/{id}")))
        .and_then(|body| release_value(&body))
}

fn episode_value<'a>(release: &'a Value, episode_id: &str) -> Result<&'a Value, String> {
    release
        .get("episodes")
        .and_then(Value::as_array)
        .and_then(|episodes| {
            episodes
                .iter()
                .find(|episode| episode.get("id").and_then(Value::as_str) == Some(episode_id))
        })
        .ok_or_else(|| format!("AniLiberty episode was not found: {episode_id}"))
}

fn episode_number(value: &Value) -> Option<f64> {
    value.get("ordinal").and_then(Value::as_f64)
}

fn reference_options(request_id: &str, reference: &str) -> Result<Value, String> {
    let reference = safe_path_segment(reference).ok_or("AniLiberty reference id is invalid")?;
    let body = host_http(request_id, api_url(&format!("anime/catalog/references/{reference}")))?;
    let value = json_body(&body, "reference options")?;
    let items = value
        .get("data")
        .or_else(|| value.get("items"))
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(Value::Array(
        items
            .iter()
            .filter_map(|item| {
                let object = item.as_object()?;
                let id = object
                    .get("id")
                    .or_else(|| object.get("value"))
                    .and_then(ValueString::to_string_value)?;
                let title = object
                    .get("name")
                    .or_else(|| object.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or(&id);
                Some(json!({ "id": id, "title": title }))
            })
            .collect(),
    ))
}

fn filter_catalog(request_id: &str) -> Result<Value, String> {
    Ok(json!({
        "sortOptions": [
            { "id": "relevance", "title": "Relevance" },
            { "id": "rating", "title": "Rating" },
            { "id": "year", "title": "Year" }
        ],
        "typeOptions": reference_options(request_id, "types")?,
        "statusOptions": reference_options(request_id, "publish-statuses")?,
        "genreOptions": reference_options(request_id, "genres")?
    }))
}

fn playback_groups(request_id: &str, title_id: &str) -> Result<Value, String> {
    let release = release(request_id, title_id)?;
    let mut seen_ids = Vec::new();
    let episodes = release
        .get("episodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|episode| {
            let id = episode.get("id")?.to_string_value()?;
            if seen_ids.iter().any(|seen| seen == &id) { return None; }
            seen_ids.push(id.clone());
            let number = episode_number(&episode)?;
            (number > 0.0).then(|| {
                json!({
                    "id": id,
                    "number": number,
                    "title": episode.get("name").and_then(Value::as_str)
                })
            })
        })
        .collect::<Vec<_>>();
    if episodes.is_empty() {
        Ok(json!({ "groups": [] }))
    } else {
        Ok(json!({
            "groups": [{
                "id": title_id,
                "title": "AniLiberty",
                "qualityLabel": "HLS",
                "episodes": episodes
            }]
        }))
    }
}

fn player_links(request_id: &str, title_id: &str, episode_id: &str) -> Result<Value, String> {
    let release = release(request_id, title_id)?;
    let episode = episode_value(&release, episode_id)?;
    let mut links = Vec::new();
    for (field, quality) in [
        ("hls_1080", "1080p"),
        ("hls_720", "720p"),
        ("hls_480", "480p"),
        ("hls_360", "360p"),
        ("hls_240", "240p"),
    ] {
        if let Some(url) = episode
            .get(field)
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
        {
            if !is_http_url(url) { continue; }
            links.push(json!({
                "url": url,
                "type": "DIRECT_HLS",
                "quality": quality,
                "headers": { "Referer": "https://anilibria.top/" },
                "playerName": "AniLiberty",
                "translation": "AniLiberty",
                "segments": episode_segments(episode)
            }));
        }
    }
    Ok(json!({ "links": links }))
}

fn episode_segments(episode: &Value) -> Vec<Value> {
    let duration = episode.get("duration").and_then(Value::as_i64);
    [("opening", "OPENING"), ("ending", "ENDING")]
        .into_iter()
        .filter_map(|(field, segment_type)| {
            let segment = episode.get(field)?.as_object()?;
            let start = segment.get("start")?.as_i64()?.max(0);
            let raw_end = segment.get("stop")?.as_i64()?;
            let end = duration.map_or(raw_end, |value| raw_end.min(value));
            (end > start).then(|| {
                json!({
                    "type": segment_type,
                    "startMs": start * 1000,
                    "endMs": end * 1000
                })
            })
        })
        .collect()
}

trait ValueString {
    fn to_string_value(&self) -> Option<String>;
}

impl ValueString for Value {
    fn to_string_value(&self) -> Option<String> {
        non_empty_scalar(self)
    }
}

fn execute(request: RuntimeRequest) -> Vec<u8> {
    let result = match request.operation {
        RuntimeOperation::Search => {
            let query = request
                .payload
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("");
            let page = request
                .payload
                .get("offset")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                / 20
                + 1;
            let sorting = match request
                .payload
                .get("sort")
                .and_then(Value::as_str)
                .unwrap_or("RELEVANCE")
            {
                "RATING" => "RATING_DESC",
                "YEAR" => "YEAR_DESC",
                "TITLE" => "FRESH_AT_DESC",
                _ => "FRESH_AT_DESC",
            };
            let mut parameters = format!("page={page}&limit=20&f[sorting]={}", encode_query(sorting));
            if !query.trim().is_empty() {
                parameters.push_str(&format!("&f[search]={}", encode_query(query)));
            }
            for (field, key) in [
                ("typeAliases", "f[types]"),
                ("statusAliases", "f[publish_statuses]"),
                ("includedGenreAliases", "f[genres]"),
            ] {
                if let Some(values) = request.payload.get(field).and_then(Value::as_array) {
                    let value = values
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .collect::<Vec<_>>()
                        .join(",");
                    if !value.is_empty() {
                        parameters.push_str(&format!("&{key}={}", encode_query(&value)));
                    }
                }
            }
            for (field, key) in [("yearFrom", "f[years][from_year]"), ("yearTo", "f[years][to_year]")] {
                if let Some(value) = request.payload.get(field).and_then(normalize_year) {
                    parameters.push_str(&format!("&{key}={value}"));
                }
            }
            let url = format!("{}?{parameters}", api_url("anime/catalog/releases"));
            host_http(&request.request_id, url).and_then(|body| {
                let value = json_body(&body, "search")?;
                let items = value
                    .get("data")
                    .or_else(|| value.get("items"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                Ok(json!({ "items": items.iter().filter_map(title).collect::<Vec<_>>() }))
            })
        }
        RuntimeOperation::FilterCatalog => filter_catalog(&request.request_id),
        RuntimeOperation::Details => {
            let id = request
                .payload
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "details id is missing".to_owned());
            id.and_then(|id| {
                release(&request.request_id, id).and_then(|value| {
                    title(&value).ok_or_else(|| "AniLiberty returned an invalid release".to_owned())
                })
            })
        }
        RuntimeOperation::PlaybackGroups => {
            let title_id = request
                .payload
                .get("titleId")
                .and_then(Value::as_str)
                .ok_or_else(|| "playback titleId is missing".to_owned());
            title_id.and_then(|id| playback_groups(&request.request_id, id))
        }
        RuntimeOperation::PlayerLinks => {
            let title_id = request
                .payload
                .get("titleId")
                .and_then(Value::as_str)
                .ok_or_else(|| "player links titleId is missing".to_owned());
            let episode_id = request
                .payload
                .get("episodeId")
                .and_then(Value::as_str)
                .ok_or_else(|| "player links episodeId is missing".to_owned());
            title_id.and_then(|title_id| {
                episode_id
                    .and_then(|episode_id| player_links(&request.request_id, title_id, episode_id))
            })
        }
    };
    match result {
        Ok(payload) => serde_json::to_vec(&RuntimeResponse {
            request_id: request.request_id,
            payload: Some(payload),
            error_code: None,
            error_message: None,
            protocol_version: RUNTIME_PROTOCOL_VERSION,
        })
        .unwrap(),
        Err(error) => runtime_error(request.request_id, error),
    }
}

static mut HEAP: usize = 4096;

#[no_mangle]
pub extern "C" fn beakokit_reset() {
    unsafe {
        HEAP = 4096;
    }
}

#[no_mangle]
pub extern "C" fn beakokit_alloc(length: i32) -> i32 {
    if length < 0 {
        return -1;
    }
    unsafe {
        let pointer = HEAP;
        let Some(next) = HEAP.checked_add(length as usize) else { return -1; };
        if next > i32::MAX as usize || pointer > i32::MAX as usize { return -1; }
        HEAP = next;
        pointer as i32
    }
}

#[no_mangle]
pub extern "C" fn beakokit_call(pointer: i32, length: i32) -> i64 {
    if pointer < 0 || length < 0 || length as usize > MAX_RUNTIME_REQUEST_BYTES {
        let message = if pointer < 0 { "runtime request pointer is invalid" } else { "runtime request exceeds size limit" };
        let response = runtime_error("invalid-request".to_owned(), message);
        let response_pointer = beakokit_alloc(response.len() as i32) as usize;
        unsafe { core::ptr::copy_nonoverlapping(response.as_ptr(), response_pointer as *mut u8, response.len()); }
        return ((response_pointer as u64) << 32 | response.len() as u64) as i64;
    }
    let request =
        unsafe { core::slice::from_raw_parts(pointer as *const u8, length.max(0) as usize) };
    let response = match serde_json::from_slice::<Value>(request) {
        Ok(value) => match validate_runtime_request(&value) {
            Ok(request_id) => match serde_json::from_value::<RuntimeRequest>(value) {
                Ok(mut request) => { request.request_id = request_id; execute(request) },
                Err(error) => runtime_error("invalid-request".to_owned(), error.to_string()),
            },
            Err(error) => runtime_error("invalid-request".to_owned(), error),
        },
        Err(error) => runtime_error("invalid-request".to_owned(), error.to_string()),
    };
    let response = if response.len() > MAX_RUNTIME_RESPONSE_BYTES {
        runtime_error("response-too-large".to_owned(), "runtime response exceeds size limit")
    } else {
        response
    };
    let response_pointer = beakokit_alloc(response.len() as i32) as usize;
    unsafe {
        core::ptr::copy_nonoverlapping(
            response.as_ptr(),
            response_pointer as *mut u8,
            response.len(),
        );
    }
    ((response_pointer as u64) << 32 | response.len() as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_release_metadata_for_client() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/release.json")).unwrap();
        let parsed = title(&fixture).unwrap();
        assert_eq!(parsed["id"], "42");
        assert_eq!(parsed["russianName"], "Test title");
        assert_eq!(parsed["type"], "tv");
        assert_eq!(parsed["year"], 2024);
        assert_eq!(parsed["episodeCount"], 12);
        assert_eq!(parsed["status"], "ongoing");
        assert_eq!(parsed["description"], "Test title");
        assert_eq!(parsed["synonyms"], json!(["One", "Two"]));
    }

    #[test]
    fn rejects_unsafe_release_ids_before_host_call() {
        assert!(release("test", "../admin").is_err());
        assert!(reference_options("test", "reference?id=1").is_err());
    }
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "host")]
extern "C" {
    #[link_name = "call"]
    fn host_call(pointer: *const u8, length: i32) -> i64;
}

#[cfg(not(target_arch = "wasm32"))]
unsafe extern "C" fn host_call(_pointer: *const u8, _length: i32) -> i64 { -1 }
