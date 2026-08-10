use serde::{Deserialize, Serialize};
use beakokit_html_sdk::{host_get_request, is_http_url, non_empty_scalar, normalize_status, normalize_type, parse_year, safe_path_segment, sanitize_runtime_error, validate_runtime_request, HostResponse, JsonDocument, DEFAULT_MAX_DOCUMENT_BYTES, MAX_HOST_RESPONSE_BYTES, MAX_RUNTIME_REQUEST_BYTES, MAX_RUNTIME_RESPONSE_BYTES};
use serde_json::{json, Value};

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
const BASE_URL: &str = "https://api.yani.tv";
const APPLICATION_TOKEN: &str = "wawegr8j13it4rdw";
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)]
enum RuntimeOperation {
    #[serde(rename = "SEARCH")] Search,
    #[serde(rename = "FILTER_CATALOG")] FilterCatalog,
    #[serde(rename = "LATEST")] Latest,
    #[serde(rename = "DETAILS")] Details,
    #[serde(rename = "PLAYBACK_GROUPS")] PlaybackGroups,
    #[serde(rename = "PLAYER_LINKS")] PlayerLinks,
}

#[derive(Deserialize)]
struct RuntimeRequest { #[serde(rename = "requestId")] request_id: String, operation: RuntimeOperation, payload: Value }

#[derive(Serialize)]
struct RuntimeResponse {
    #[serde(rename = "requestId")] request_id: String,
    payload: Option<Value>,
    #[serde(rename = "errorCode")] error_code: Option<&'static str>,
    #[serde(rename = "errorMessage")] error_message: Option<String>,
    #[serde(rename = "protocolVersion")] protocol_version: u32,
}

fn error(request_id: String, message: impl Into<String>) -> Vec<u8> {
    let message = sanitize_runtime_error(&message.into());
    serde_json::to_vec(&RuntimeResponse { request_id, payload: None, error_code: Some("SOURCE_FAILURE"), error_message: Some(message), protocol_version: RUNTIME_PROTOCOL_VERSION }).unwrap()
}

fn http(request_id: &str, path: &str, query: &str) -> Result<String, String> {
    let url = if query.is_empty() { format!("{BASE_URL}{path}") } else { format!("{BASE_URL}{path}?{query}") };
    let request = host_get_request(request_id, url, json!({
        "Accept": "application/json", "Lang": "ru", "X-Application": APPLICATION_TOKEN
    }), MAX_RESPONSE_BYTES);
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let packed = unsafe { host_call(bytes.as_ptr(), bytes.len() as i32) };
    if packed < 0 { return Err("YummyAnime host HTTP request failed".to_owned()); }
    let ptr = (packed as u64 >> 32) as usize;
    let len = (packed as u64 & u32::MAX as u64) as usize;
    let raw = unsafe { core::slice::from_raw_parts(ptr as *const u8, len) };
    if raw.len() > MAX_HOST_RESPONSE_BYTES {
        return Err("YummyAnime host response exceeds size limit".to_owned());
    }
    let response: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    HostResponse::from_value_limited(&response, "YummyAnime", MAX_RESPONSE_BYTES as usize)
        .map(|response| response.body().to_owned())
        .map_err(|error| format!("YummyAnime HTTP response invalid: {error:?}"))
}

fn enc(value: &str) -> String {
    value.bytes().flat_map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![b as char],
        b => format!("%{b:02X}").chars().collect(),
    }).collect()
}

fn scalar(value: &Value) -> Option<String> {
    non_empty_scalar(value)
}

fn normalized_url(value: &str) -> String {
    if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_owned()
    }
}

fn envelope(body: &str) -> Result<Value, String> {
    let value = json_body(body, "envelope")?;
    Ok(value.get("response").cloned().unwrap_or(value))
}

fn json_body(body: &str, operation: &str) -> Result<Value, String> {
    JsonDocument::parse_limited(body, DEFAULT_MAX_DOCUMENT_BYTES)
        .map(|document| document.root().clone())
        .map_err(|error| format!("YummyAnime {operation} JSON parse failed: {error:?}"))
}

fn title(value: &Value) -> Option<Value> {
    let id = value.get("anime_id").and_then(scalar)?;
    let russian = value.get("title").and_then(Value::as_str).filter(|v| !v.trim().is_empty());
    let english = value.get("title_en").or_else(|| value.get("title_english")).and_then(Value::as_str).filter(|v| !v.trim().is_empty());
    let original = value.get("title_orig").or_else(|| value.get("title_original")).and_then(Value::as_str).or_else(|| english.or(russian));
    let poster = value.get("poster").or_else(|| value.get("image"));
    let poster_url = poster.and_then(|p| {
        p.as_str().map(normalized_url).or_else(|| {
            ["fullsize", "mega", "huge", "big", "medium", "small", "original", "preview", "thumbnail", "url"]
                .iter()
                .find_map(|key| p.get(*key).and_then(Value::as_str).filter(|v| !v.trim().is_empty()))
                .map(normalized_url)
        })
    });
    let raw_type = value.get("type").and_then(|v| v.get("alias").or(Some(v))).and_then(Value::as_str);
    let type_alias = raw_type.and_then(normalize_type).or_else(|| raw_type.map(str::to_owned));
    let raw_status = value.get("anime_status").and_then(|v| v.get("alias").or(Some(v))).and_then(Value::as_str).or_else(|| value.get("status").and_then(Value::as_str));
    let status = raw_status.and_then(normalize_status).or_else(|| raw_status.map(str::to_owned));
    let year = value.get("year").and_then(|year| year.as_i64().or_else(|| year.as_str().and_then(parse_year)));
    let age_rating = value.get("min_age").and_then(|v| v.get("title").or_else(|| v.get("title_long")).or(Some(v))).and_then(Value::as_str);
    let genres = value.get("genres").and_then(Value::as_array).map(|items| items.iter().filter_map(|v| v.get("alias").or_else(|| v.get("name")).or_else(|| v.get("title")).and_then(Value::as_str).map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
    Some(json!({
        "id": id, "russianName": russian, "englishName": english, "originalName": original,
        "japaneseName": value.get("title_jp").or_else(|| value.get("title_japanese")),
        "synonyms": value.get("synonyms").or_else(|| value.get("aliases")).cloned().unwrap_or_else(|| json!([])),
        "year": year, "type": type_alias, "episodeCount": value.get("episodes_count"),
        "posterUrl": poster_url, "status": status,
        "description": value.get("description").and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .or_else(|| russian.or(english).or(original))
            .unwrap_or("Описание отсутствует"),
        "nextEpisodeAt": null, "genres": genres, "ratings": [], "ageRating": age_rating,
        "viewCount": value.get("views"), "screenshots": [], "trailer": null, "sourceMaterial": null,
        "studios": [], "mainCharacters": [], "similarAnime": [], "franchiseAnime": [],
        "relatedAnime": [], "season": value.get("season"), "availableEpisodeCount": null, "posterFallbackUrl": null
    }))
}

fn array(body: &str) -> Result<Vec<Value>, String> { Ok(envelope(body)?.as_array().cloned().unwrap_or_default()) }

fn videos(request_id: &str, id: &str) -> Result<Vec<Value>, String> {
    let id = safe_path_segment(id).ok_or("YummyAnime anime id is invalid")?;
    array(&http(request_id, &format!("/anime/{id}/videos"), "")?)
}

fn number(value: &str) -> Option<f64> { value.replace(',', ".").parse::<f64>().ok() }

fn dubbing(video: &Value) -> Option<String> {
    video.pointer("/data/dubbing").and_then(Value::as_str).map(|v| v.trim_start_matches("Озвучка ").trim().to_owned()).filter(|v| !v.is_empty())
}

fn playback_groups(request_id: &str, id: &str) -> Result<Value, String> {
    let mut groups = Vec::new();
    let items = videos(request_id, id)?;
    let mut names: Vec<String> = items.iter().filter_map(dubbing).collect();
    names.sort(); names.dedup();
    for name in names {
        let mut seen = Vec::new();
        let episodes = items.iter().filter(|v| dubbing(v).as_deref() == Some(&name)).filter_map(|v| {
            let episode_id = scalar(v.get("number")?)?;
            if seen.iter().any(|id: &String| id == &episode_id) { return None; }
            let episode_number = number(&episode_id)?;
            seen.push(episode_id.clone());
            Some(json!({ "id": episode_id, "number": episode_number, "title": v.get("title") }))
        }).collect::<Vec<_>>();
        if !episodes.is_empty() { groups.push(json!({ "id": name, "title": name, "qualityLabel": null, "episodes": episodes })); }
    }
    Ok(json!({ "groups": groups }))
}

fn player_links(request_id: &str, id: &str, episode_id: &str) -> Result<Value, String> {
    let links = videos(request_id, id)?.into_iter().filter(|v| scalar(v.get("number").unwrap_or(&Value::Null)).as_deref() == Some(episode_id)).filter_map(|v| {
        let url = normalized_url(v.get("iframe_url").and_then(Value::as_str)?);
        if !is_http_url(&url) { return None; }
        let player = v.pointer("/data/player").and_then(Value::as_str).unwrap_or("YummyAnime").trim_start_matches("Плеер ").trim().to_owned();
        let translation = dubbing(&v).unwrap_or_else(|| "YummyAnime".to_owned());
        let mut segments = Vec::new();
        for (field, kind) in [("opening", "OPENING"), ("ending", "ENDING")] {
            if let Some(skip) = v.get("skips").and_then(|s| s.get(field)).and_then(Value::as_object) {
                let start = skip.get("time").and_then(Value::as_i64).unwrap_or(-1);
                let length = skip.get("length").and_then(Value::as_i64).unwrap_or(0);
                if start >= 0 && length > 0 { segments.push(json!({ "type": kind, "startMs": start * 1000, "endMs": (start + length) * 1000 })); }
            }
        }
        Some(json!({ "url": url, "type": "EMBED", "quality": null, "headers": { "Referer": "https://ru.yummyani.me/" }, "playerName": player, "translation": translation, "segments": segments, "videoId": v.get("video_id") }))
    }).collect::<Vec<_>>();
    Ok(json!({ "links": links }))
}

fn filters() -> Value {
    let option = |id: &str| json!({ "id": id, "title": id });
    let sorts = ["relevance", "top", "title", "year", "votes", "views", "comments"].iter().map(|v| option(v)).collect::<Vec<_>>();
    let types = ["tv", "movie", "short_movie", "ova", "special", "short_serial", "ona"].iter().map(|v| option(v)).collect::<Vec<_>>();
    let statuses = ["released", "ongoing", "announcement"].iter().map(|v| option(v)).collect::<Vec<_>>();
    json!({ "sortOptions": sorts, "typeOptions": types, "statusOptions": statuses, "genreOptions": [] })
}

fn execute(request: RuntimeRequest) -> Result<Value, String> {
    match request.operation {
        RuntimeOperation::FilterCatalog => Ok(filters()),
        RuntimeOperation::Latest => {
            let items = array(&http(&request.request_id, "/anime/schedule", "")?)?;
            Ok(json!({ "items": items.iter().filter_map(title).collect::<Vec<_>>() }))
        }
        RuntimeOperation::Search => {
            let p = &request.payload; let offset = p.get("offset").and_then(Value::as_i64).unwrap_or(0); let limit = p.get("limit").and_then(Value::as_i64).unwrap_or(20);
            let mut q = format!("limit={limit}&offset={offset}");
            if let Some(value) = p.get("query").and_then(Value::as_str).filter(|v| !v.trim().is_empty()) { q.push_str(&format!("&q={}", enc(value))); }
            if let Some(sort) = p.get("sort").and_then(Value::as_str) {
                let sort = match sort { "TITLE" => "title", "YEAR" => "year", "VOTES" => "votes", "VIEWS" => "views", "COMMENTS" => "comments", _ => "top" };
                q.push_str(&format!("&sort={sort}"));
            }
            for (field, key) in [("yearFrom", "year_from"), ("yearTo", "year_to")] { if let Some(v) = p.get(field).and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_i64().map(|n| n.to_string()))) { q.push_str(&format!("&{key}={}", enc(&v))); } }
            for (field, key) in [("typeAliases", "types"), ("statusAliases", "statuses"), ("includedGenreAliases", "genres"), ("excludedGenreAliases", "genres_exclude")] { if let Some(values) = p.get(field).and_then(Value::as_array) { let joined = values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","); if !joined.is_empty() { q.push_str(&format!("&{key}={}", enc(&joined))); } } }
            let items = array(&http(&request.request_id, "/anime", &q)?)?;
            Ok(json!({ "items": items.iter().filter_map(title).collect::<Vec<_>>() }))
        }
        RuntimeOperation::Details => { let id = request.payload.get("id").and_then(Value::as_str).ok_or("details id is missing")?; let id = safe_path_segment(id).ok_or("YummyAnime anime id is invalid")?; let body = http(&request.request_id, &format!("/anime/{id}"), "")?; let value = envelope(&body)?; title(&value).ok_or_else(|| "YummyAnime returned an invalid title".to_owned()) }
        RuntimeOperation::PlaybackGroups => { let id = request.payload.get("titleId").and_then(Value::as_str).ok_or("playback titleId is missing")?; playback_groups(&request.request_id, id) }
        RuntimeOperation::PlayerLinks => { let id = request.payload.get("titleId").and_then(Value::as_str).ok_or("player links titleId is missing")?; let episode = request.payload.get("episodeId").and_then(Value::as_str).ok_or("player links episodeId is missing")?; player_links(&request.request_id, id, episode) }
    }
}

static mut HEAP: usize = 4096;
#[no_mangle] pub extern "C" fn beakokit_reset() { unsafe { HEAP = 4096; } }
#[no_mangle] pub extern "C" fn beakokit_alloc(length: i32) -> i32 {
    if length < 0 { return -1; }
    unsafe {
        let ptr = HEAP;
        let Some(next) = HEAP.checked_add(length as usize) else { return -1; };
        if next > i32::MAX as usize || ptr > i32::MAX as usize { return -1; }
        HEAP = next;
        ptr as i32
    }
}
#[no_mangle] pub extern "C" fn beakokit_call(pointer: i32, length: i32) -> i64 {
    if pointer < 0 || length < 0 || length as usize > MAX_RUNTIME_REQUEST_BYTES {
        let message = if pointer < 0 { "runtime request pointer is invalid" } else { "runtime request exceeds size limit" };
        let response = error("invalid-request".to_owned(), message);
        let ptr = beakokit_alloc(response.len() as i32) as usize;
        unsafe { core::ptr::copy_nonoverlapping(response.as_ptr(), ptr as *mut u8, response.len()); }
        return ((ptr as u64) << 32 | response.len() as u64) as i64;
    }
    let input = unsafe { core::slice::from_raw_parts(pointer as *const u8, length.max(0) as usize) };
    let response = match serde_json::from_slice::<Value>(input) {
        Ok(value) => match validate_runtime_request(&value) {
            Ok(request_id) => match serde_json::from_value::<RuntimeRequest>(value) {
                Ok(mut request) => { request.request_id = request_id; let request_id = request.request_id.clone(); match execute(request) {
                    Ok(payload) => serde_json::to_vec(&RuntimeResponse { request_id, payload: Some(payload), error_code: None, error_message: None, protocol_version: RUNTIME_PROTOCOL_VERSION }).unwrap(),
                    Err(message) => error(request_id, message),
                } }
                Err(parse_error) => error("invalid-request".to_owned(), parse_error.to_string()),
            },
            Err(validation_error) => error("invalid-request".to_owned(), validation_error),
        },
        Err(e) => error("invalid-request".to_owned(), e.to_string()),
    };
    let response = if response.len() > MAX_RUNTIME_RESPONSE_BYTES {
        error("response-too-large".to_owned(), "runtime response exceeds size limit")
    } else {
        response
    };
    let ptr = beakokit_alloc(response.len() as i32) as usize;
    unsafe { core::ptr::copy_nonoverlapping(response.as_ptr(), ptr as *mut u8, response.len()); }
    ((ptr as u64) << 32 | response.len() as u64) as i64
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "host")]
extern "C" { #[link_name = "call"] fn host_call(pointer: *const u8, length: i32) -> i64; }

#[cfg(not(target_arch = "wasm32"))]
unsafe extern "C" fn host_call(_pointer: *const u8, _length: i32) -> i64 { -1 }
