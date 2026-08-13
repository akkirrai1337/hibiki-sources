use serde::{Deserialize, Serialize};
use beakokit_html_sdk::{bounded_pagination, host_get_request, is_http_url, non_empty_scalar, non_empty_text, non_negative_i64, normalize_status, normalize_type, normalize_year, positive_finite, safe_path_segment, sanitize_runtime_error, unpack_host_response, validate_pagination, validate_playback_payload, validate_player_links_payload, validate_runtime_input, validate_runtime_request, validate_search_query, validate_string_filters, validate_title_metadata, HostResponse, JsonDocument, DEFAULT_MAX_DOCUMENT_BYTES, MAX_RUNTIME_RESPONSE_BYTES};
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
    let raw = unsafe { unpack_host_response(packed, "YummyAnime")? };
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
    let value = value.trim();
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
    let id = safe_path_segment(&value.get("anime_id").and_then(scalar)?)?.to_owned();
    let russian = value.get("title").and_then(non_empty_text);
    let english = value.get("title_en").or_else(|| value.get("title_english")).and_then(non_empty_text);
    let original_raw = value.get("title_orig").or_else(|| value.get("title_original")).and_then(non_empty_text);
    let display_name = russian.as_ref().or(english.as_ref()).or(original_raw.as_ref())?.clone();
    let original = original_raw.clone().or(english.clone()).or_else(|| Some(display_name.clone()));
    let poster = value.get("poster").or_else(|| value.get("image"));
    let poster_url = poster.and_then(|p| {
            p.as_str().map(normalized_url).filter(|url| is_http_url(url)).or_else(|| {
            ["fullsize", "mega", "huge", "big", "medium", "small", "original", "preview", "thumbnail", "url"]
                .iter()
                .find_map(|key| p.get(*key).and_then(Value::as_str).filter(|v| !v.trim().is_empty()))
                .map(normalized_url)
                .filter(|url| is_http_url(url))
        })
    });
    let raw_type = value.get("type").and_then(|v| v.get("alias").or(Some(v))).and_then(Value::as_str);
    let type_alias = raw_type.and_then(normalize_type);
    let raw_status = value.get("anime_status").and_then(|v| v.get("alias").or(Some(v))).and_then(Value::as_str).or_else(|| value.get("status").and_then(Value::as_str));
    let status = raw_status.and_then(normalize_status);
    let year = value.get("year").and_then(normalize_year);
    let age_rating = value.get("min_age").and_then(|v| v.get("title").or_else(|| v.get("title_long")).or(Some(v))).and_then(non_empty_text);
    let genres = value.get("genres").and_then(Value::as_array).map(|items| items.iter().filter_map(|v| v.get("title").or_else(|| v.get("name")).or_else(|| v.get("alias")).and_then(non_empty_text)).collect::<Vec<_>>()).unwrap_or_default();
    let episode_count = value.get("episodes_count").and_then(non_negative_i64)
        .or_else(|| value.get("episodes").and_then(|episodes| episodes.get("count")).and_then(non_negative_i64));
    let synonyms = value.get("synonyms").or_else(|| value.get("aliases")).map(string_values).unwrap_or_default();
    Some(json!({
        "id": id, "russianName": russian.clone().or_else(|| Some(display_name.clone())), "englishName": english, "originalName": original,
        "japaneseName": value.get("title_jp").or_else(|| value.get("title_japanese")),
        "synonyms": synonyms,
        "year": year, "type": type_alias, "episodeCount": episode_count,
        "posterUrl": poster_url, "status": status,
        "description": value.get("description").and_then(non_empty_text)
            .or_else(|| russian.clone().or(english.clone()).or(original.clone()))
            .unwrap_or_else(|| "Описание отсутствует".to_owned()),
        "nextEpisodeAt": null, "genres": genres, "ratings": [], "ageRating": age_rating,
        "viewCount": value.get("views"), "screenshots": [], "trailer": null, "sourceMaterial": null,
        "studios": [], "mainCharacters": [], "similarAnime": [], "franchiseAnime": [],
        "relatedAnime": [], "season": value.get("season"), "availableEpisodeCount": null, "posterFallbackUrl": null
    }))
}

fn string_values(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().filter_map(non_empty_text).collect(),
        value => non_empty_text(value).into_iter().collect(),
    }
}

fn array(body: &str) -> Result<Vec<Value>, String> {
    envelope(body)?
        .as_array()
        .cloned()
        .ok_or_else(|| "YummyAnime API response expected an array".to_owned())
}

fn catalog_titles(items: &[Value]) -> Result<Vec<Value>, String> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let parsed = title(item).ok_or_else(|| format!("YummyAnime catalog item {index} is invalid"))?;
            validate_title_metadata(&parsed, "YummyAnime", &format!("catalog item {index}"))?;
            Ok(parsed)
        })
        .collect()
}

fn videos(request_id: &str, id: &str) -> Result<Vec<Value>, String> {
    let id = safe_path_segment(id).ok_or("YummyAnime anime id is invalid")?;
    array(&http(request_id, &format!("/anime/{id}/videos"), "")?)
}

fn number(value: &str) -> Option<f64> { value.trim().replace(',', ".").parse::<f64>().ok() }

fn video_episode(video: &Value) -> Result<Option<(String, f64)>, String> {
    let Some(raw_number) = video.get("number") else { return Ok(None); };
    let episode_id = scalar(raw_number)
        .ok_or_else(|| "YummyAnime video number is not a valid scalar".to_owned())?;
    let episode_number = number(&episode_id)
        .and_then(positive_finite)
        .ok_or_else(|| format!("YummyAnime video episode number is invalid: {episode_id}"))?;
    Ok(Some((episode_id, episode_number)))
}

fn dubbing(video: &Value) -> Option<String> {
    video.pointer("/data/dubbing").and_then(Value::as_str).map(|v| v.trim_start_matches("Озвучка ").trim().to_owned()).filter(|v| !v.is_empty())
}

fn validate_dubbing_groups(items: &[Value]) -> Result<(), String> {
    if !items.is_empty() && !items.iter().any(|video| dubbing(video).is_some()) {
        return Err("YummyAnime videos contain no valid dubbing groups".to_owned());
    }
    Ok(())
}

fn playback_groups(request_id: &str, id: &str) -> Result<Value, String> {
    let mut groups = Vec::new();
    let items = videos(request_id, id)?;
    validate_dubbing_groups(&items)?;
    let mut names: Vec<String> = items.iter().filter_map(dubbing).collect();
    names.sort(); names.dedup();
    for name in names {
        let mut seen = Vec::new();
        let mut episodes = Vec::new();
        for video in items.iter().filter(|v| dubbing(v).as_deref() == Some(&name)) {
            let Some((episode_id, episode_number)) = video_episode(video)? else { continue; };
            if seen.iter().any(|id: &String| id == &episode_id) { continue; }
            seen.push(episode_id.clone());
            episodes.push(json!({ "id": episode_id, "number": episode_number, "title": video.get("title") }));
        }
        if !episodes.is_empty() { groups.push(json!({ "id": name, "title": name, "qualityLabel": null, "episodes": episodes })); }
    }
    let payload = json!({ "groups": groups });
    validate_playback_payload(&payload, "YummyAnime")?;
    Ok(payload)
}

fn player_links(request_id: &str, id: &str, episode_id: &str) -> Result<Value, String> {
    let matching = videos(request_id, id)?.into_iter().filter(|v| scalar(v.get("number").unwrap_or(&Value::Null)).as_deref() == Some(episode_id)).collect::<Vec<_>>();
    if matching.is_empty() {
        return Err(format!("YummyAnime episode was not found: {episode_id}"));
    }
    let links = matching.into_iter().filter_map(|v| {
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
    ensure_player_links(&links, episode_id)?;
    let payload = json!({ "links": links });
    validate_player_links_payload(&payload, "YummyAnime")?;
    Ok(payload)
}

fn ensure_player_links(links: &[Value], episode_id: &str) -> Result<(), String> {
    if links.is_empty() {
        return Err(format!("YummyAnime episode has no valid HTTP player links: {episode_id}"));
    }
    Ok(())
}

fn filters() -> Value {
    let option = |id: &str| json!({ "id": id, "title": id });
    let sorts = ["relevance", "top", "title", "year", "votes", "views", "comments"].iter().map(|v| option(v)).collect::<Vec<_>>();
    let types = ["tv", "movie", "short_movie", "ova", "special", "short_serial", "ona"].iter().map(|v| option(v)).collect::<Vec<_>>();
    let statuses = ["released", "ongoing", "announcement"].iter().map(|v| option(v)).collect::<Vec<_>>();
    json!({ "sortOptions": sorts, "typeOptions": types, "statusOptions": statuses, "genreOptions": [] })
}

fn string_filter_values(payload: &Value, field: &str) -> Result<Option<Vec<String>>, String> {
    let Some(value) = payload.get(field) else { return Ok(None); };
    let values = value
        .as_array()
        .ok_or_else(|| format!("YummyAnime filter field {field} must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("YummyAnime filter field {field} item {index} must be a string"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(values))
}

fn execute(request: RuntimeRequest) -> Result<Value, String> {
    if matches!(&request.operation, RuntimeOperation::Search | RuntimeOperation::Latest) { validate_pagination(&request.payload, "YummyAnime")?; }
    if matches!(&request.operation, RuntimeOperation::Search) { validate_search_query(&request.payload, "YummyAnime")?; }
    if matches!(&request.operation, RuntimeOperation::Search) { validate_string_filters(&request.payload, &["typeAliases", "statusAliases", "includedGenreAliases", "excludedGenreAliases"], "YummyAnime")?; }
    match request.operation {
        RuntimeOperation::FilterCatalog => Ok(filters()),
        RuntimeOperation::Latest => {
            let items = array(&http(&request.request_id, "/anime/schedule", "")?)?;
            Ok(json!({ "items": catalog_titles(&items)? }))
        }
        RuntimeOperation::Search => {
            let p = &request.payload; let (offset, limit) = bounded_pagination(p);
            let mut q = format!("limit={limit}&offset={offset}");
            if let Some(value) = p.get("query").and_then(Value::as_str).filter(|v| !v.trim().is_empty()) { q.push_str(&format!("&q={}", enc(value))); }
            if let Some(sort) = p.get("sort").and_then(Value::as_str) {
                let sort = match sort { "TITLE" => "title", "YEAR" => "year", "VOTES" => "votes", "VIEWS" => "views", "COMMENTS" => "comments", _ => "top" };
                q.push_str(&format!("&sort={sort}"));
            }
            for (field, key) in [("yearFrom", "year_from"), ("yearTo", "year_to")] { if let Some(v) = p.get(field).and_then(normalize_year).map(|value| value.to_string()) { q.push_str(&format!("&{key}={}", enc(&v))); } }
            for (field, key) in [("typeAliases", "types"), ("statusAliases", "statuses"), ("includedGenreAliases", "genres"), ("excludedGenreAliases", "genres_exclude")] { if let Some(values) = string_filter_values(p, field)? { let joined = values.join(","); if !joined.is_empty() { q.push_str(&format!("&{key}={}", enc(&joined))); } } }
            let items = array(&http(&request.request_id, "/anime", &q)?)?;
            Ok(json!({ "items": catalog_titles(&items)? }))
        }
        RuntimeOperation::Details => { let id = request.payload.get("id").and_then(Value::as_str).ok_or("details id is missing")?; let id = safe_path_segment(id).ok_or("YummyAnime anime id is invalid")?; let body = http(&request.request_id, &format!("/anime/{id}"), "")?; let value = envelope(&body)?; let parsed = title(&value).ok_or_else(|| "YummyAnime returned an invalid title".to_owned())?; validate_title_metadata(&parsed, "YummyAnime", "title")?; Ok(parsed) }
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
    if let Err(message) = validate_runtime_input(pointer, length) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_api_metadata_for_client() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/anime.json")).unwrap();
        let parsed = title(&fixture).unwrap();
        assert_eq!(parsed["id"], "100");
        assert_eq!(parsed["russianName"], "Yummy title");
        assert_eq!(parsed["type"], "tv");
        assert_eq!(parsed["year"], 2023);
        assert_eq!(parsed["episodeCount"], 24);
        assert_eq!(parsed["status"], "released");
        assert_eq!(parsed["posterUrl"], "https://cdn.example/poster.jpg");
        let with_blank_synonym = json!({
            "anime_id": "103",
            "title": "Synonym title",
            "synonyms": ["  One  ", "", 42, "Two"]
        });
        assert_eq!(title(&with_blank_synonym).unwrap()["synonyms"], json!(["One", "Two"]));
        let with_blank_genre = json!({
            "anime_id": "102",
            "title": "Genre title",
            "genres": [{ "name": "  Action  " }, { "name": "   " }, { "title": "Drama" }]
        });
        assert_eq!(title(&with_blank_genre).unwrap()["genres"], json!(["Action", "Drama"]));
        let current_api_shape = json!({
            "anime_id": "104",
            "title": "Current API title",
            "episodes": { "count": 61 },
            "genres": [{ "title": "Сёнэн", "alias": "senen" }]
        });
        let current = title(&current_api_shape).unwrap();
        assert_eq!(current["episodeCount"], 61);
        assert_eq!(current["genres"], json!(["Сёнэн"]));
    }

    #[test]
    fn rejects_unsafe_anime_ids_before_host_call() {
        assert!(videos("test", "../admin").is_err());
    }

    #[test]
    fn normalizes_missing_display_name_and_unknown_metadata() {
        let fixture = json!({
            "anime_id": "101",
            "title_en": "English title",
            "type": "SERVICE_INTERNAL",
            "status": "INTERNAL_STATUS"
        });
        let parsed = title(&fixture).unwrap();

        assert_eq!(parsed["russianName"], "English title");
        assert_eq!(parsed["originalName"], "English title");
        assert_eq!(parsed["type"], Value::Null);
        assert_eq!(parsed["status"], Value::Null);
    }

    #[test]
    fn trims_normalized_media_urls() {
        assert_eq!(normalized_url("  //cdn.example/video  "), "https://cdn.example/video");
    }

    #[test]
    fn rejects_non_array_api_collections() {
        assert!(array(r#"{"response":{"unexpected":true}}"#).is_err());
    }

    #[test]
    fn rejects_invalid_catalog_items_instead_of_hiding_them() {
        let items = vec![
            json!({"anime_id":"100", "title":"Valid"}),
            json!({"title":"Missing id"}),
        ];
        assert!(catalog_titles(&items).is_err());
    }

    #[test]
    fn validates_yummyanime_video_episode_numbers() {
        assert_eq!(video_episode(&json!({"number":"2"})).unwrap(), Some(("2".to_owned(), 2.0)));
        assert_eq!(video_episode(&json!({"number":" 2,5 "})).unwrap(), Some(("2,5".to_owned(), 2.5)));
        assert!(video_episode(&json!({"number":"broken"})).is_err());
        assert_eq!(video_episode(&json!({"title":"service video"})).unwrap(), None);
    }

    #[test]
    fn rejects_empty_yummyanime_player_results() {
        assert!(ensure_player_links(&[], "2").is_err());
        assert!(ensure_player_links(&[json!({"url":"https://example.org/player"})], "2").is_ok());
    }

    #[test]
    fn diagnoses_videos_without_dubbing_groups() {
        assert!(validate_dubbing_groups(&[json!({"number":"1"})]).is_err());
        assert!(validate_dubbing_groups(&[json!({"data":{"dubbing":"Dub"}})]).is_ok());
        assert!(validate_dubbing_groups(&[]).is_ok());
    }

    #[test]
    fn validates_yummyanime_filter_arrays() {
        assert_eq!(string_filter_values(&json!({"types":["tv", " movie "]}), "types").unwrap(), Some(vec!["tv".to_owned(), "movie".to_owned()]));
        assert!(string_filter_values(&json!({"types":"tv"}), "types").is_err());
        assert!(string_filter_values(&json!({"types":["tv", 1]}), "types").is_err());
    }
}
