use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use beakokit_html_sdk::{bounded_pagination, clean_element_text, first_attribute, host_get_request, is_http_url, normalize_status, normalize_type, parse_year, positive_finite, safe_path_segment, sanitize_runtime_error, unpack_host_response, validate_pagination, validate_playback_payload, validate_player_links_payload, validate_runtime_input, validate_runtime_request, validate_title_metadata, HostResponse, HtmlDocument, JsonDocument, Selector, MAX_RUNTIME_RESPONSE_BYTES, DEFAULT_MAX_DOCUMENT_BYTES};

const BASE_URL: &str = "https://animepahetv.to";
const PROTOCOL: u32 = 1;
const MAX_BODY: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)] struct Request { #[serde(rename = "requestId")] request_id: String, operation: Operation, payload: Value }
#[derive(Deserialize)] enum Operation { #[serde(rename = "SEARCH")] Search, #[serde(rename = "FILTER_CATALOG")] FilterCatalog, #[serde(rename = "LATEST")] Latest, #[serde(rename = "DETAILS")] Details, #[serde(rename = "PLAYBACK_GROUPS")] PlaybackGroups, #[serde(rename = "PLAYER_LINKS")] PlayerLinks }
#[derive(Serialize)] struct Response { #[serde(rename = "requestId")] request_id: String, payload: Option<Value>, #[serde(rename = "errorCode")] error_code: Option<&'static str>, #[serde(rename = "errorMessage")] error_message: Option<String>, #[serde(rename = "protocolVersion")] protocol_version: u32 }

fn fail(id: String, message: impl Into<String>) -> Vec<u8> {
    serde_json::to_vec(&Response { request_id: id, payload: None, error_code: Some("SOURCE_FAILURE"), error_message: Some(sanitize_runtime_error(&message.into())), protocol_version: PROTOCOL }).unwrap()
}

fn get(request_id: &str, path: &str, headers: Value) -> Result<String, String> {
    let envelope = host_get_request(request_id, format!("{BASE_URL}{path}"), headers, MAX_BODY);
    let bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    let packed = unsafe { host_call(bytes.as_ptr(), bytes.len() as i32) };
    let raw = unsafe { unpack_host_response(packed, "AnimePahe")? };
    let value: Value = serde_json::from_slice(raw).map_err(|e| format!("AnimePahe host response JSON invalid: {e}"))?;
    HostResponse::from_value_limited(&value, "AnimePahe", MAX_BODY as usize)
        .map(|response| response.body().to_owned())
        .map_err(|e| format!("AnimePahe HTTP response invalid: {e:?}"))
}

fn page(request_id: &str, path: &str) -> Result<String, String> {
    get(request_id, path, json!({ "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }))
}

fn ajax(request_id: &str, path: &str, referer: &str) -> Result<String, String> {
    get(request_id, path, json!({ "Accept": "application/json,text/html;q=0.9,*/*;q=0.8", "X-Requested-With": "XMLHttpRequest", "Referer": format!("{BASE_URL}{referer}") }))
}

fn enc(value: &str) -> String { value.bytes().flat_map(|b| match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![b as char], b => format!("%{b:02X}").chars().collect() }).collect() }

fn html(body: &str, operation: &str) -> Result<HtmlDocument, String> {
    HtmlDocument::parse_limited(body, BASE_URL, DEFAULT_MAX_DOCUMENT_BYTES).map_err(|e| format!("AnimePahe {operation} HTML parse failed: {e:?}"))
}

fn id_from_href(href: &str) -> Option<String> {
    let value = href.trim_end_matches('/').split('?').next()?;
    let id = value.rsplit("/anime/").next()?.split('/').next()?;
    safe_path_segment(id).map(str::to_owned)
}

fn text_in(element: beakokit_html_sdk::ElementRef<'_>, selectors: &[&str]) -> Option<String> {
    selectors.iter().find_map(|selector| element.select(&beakokit_html_sdk::Selector::parse(selector).ok()?).find_map(clean_element_text))
}

fn field_in(element: beakokit_html_sdk::ElementRef<'_>, labels: &[&str]) -> Option<String> {
    let selector = beakokit_html_sdk::Selector::parse("p, li, .item, .row, span").ok()?;
    element.select(&selector).filter_map(clean_element_text).find_map(|text| {
        let (key, value) = text.split_once(':')?;
        labels.iter().any(|label| key.trim().eq_ignore_ascii_case(label)).then_some(value.trim().to_owned()).filter(|value| !value.is_empty())
    })
}

fn number(value: &str) -> Option<f64> { value.trim().replace(',', ".").parse::<f64>().ok().and_then(positive_finite) }

fn card_items(body: &str) -> Result<Vec<Value>, String> {
    let document = html(body, "catalog")?;
    let link_selector = Selector::parse("a.anime-name, .anime-name a, a.anime-poster").expect("valid AnimePahe link selector");
    let image_selector = Selector::parse("img, picture source").expect("valid AnimePahe image selector");
    let mut containers = document.select(".anime-item").map_err(|e| format!("AnimePahe catalog containers failed: {e:?}"))?;
    if !containers.is_empty() {
        let mut result = Vec::new();
        for container in containers.drain(..) {
            let Some(link) = container.select(&link_selector).into_iter().find(|link| first_attribute(*link, &["href", "data-href", "data-url"]).is_some()) else { continue };
            let Some(href) = first_attribute(link, &["href", "data-href", "data-url"]) else { continue };
            let Some(id) = id_from_href(&document.absolute_url(&href)) else { continue };
            let Some(name) = container.select(&Selector::parse(".anime-name a, .anime-name, .anime-title").expect("valid AnimePahe title selector")).into_iter().find_map(clean_element_text) else { continue };
            let poster = container.select(&image_selector).into_iter().find_map(|image| first_attribute(image, &["src", "data-src", "data-lazy-src", "data-background-image"]).and_then(|value| document.absolute_http_url(&value)));
            let year = text_in(container, &[".anime-year", ".release-year", "[data-year]"]).and_then(|value| parse_year(&value));
            let type_alias = text_in(container, &[".anime-type", ".type", "[data-type]"]).and_then(|value| normalize_type(&value));
            let status = text_in(container, &[".anime-status", ".status", "[data-status]"]).and_then(|value| normalize_status(&value));
            let score = text_in(container, &[".anime-score", ".anime-rating", ".score"]).and_then(|s| number(&s));
            let episode_count = text_in(container, &[".anime-episodes", ".episode-count"]).and_then(|value| value.split(|c: char| !c.is_ascii_digit()).find_map(|part| part.parse::<i64>().ok().filter(|n| *n > 0)));
            let genres = text_in(container, &[".anime-genre a", ".anime-genres a", ".genres a"]).into_iter().collect::<Vec<_>>();
            result.push(title_json(id, name, poster, year, type_alias, status, episode_count, score, genres));
        }
        if !result.is_empty() {
            for (index, item) in result.iter().enumerate() { validate_title_metadata(item, "AnimePahe", &format!("catalog item {index}"))?; }
            return Ok(result);
        }
    }
    let cards = document.linked_cards_unique(
        "a[href*='/anime/'], a[data-href*='/anime/'], a[data-url*='/anime/']",
        &[".anime-name", ".anime-title", ".anime-item-title", ".title", "h2", "h3"],
        "img, picture source, [data-src], [data-background-image]",
    ).map_err(|e| format!("AnimePahe catalog cards failed: {e:?}"))?;
    let mut result = Vec::new();
    for card in cards {
        let Some(href) = card.url.as_deref() else { continue };
        let Some(id) = id_from_href(href) else { continue };
        let Some(name) = card.title.filter(|s| !s.trim().is_empty()) else { continue };
        let element = card.element;
        let poster = card.image_url.filter(|s| is_http_url(s));
        let year = field_in(element, &["Aired", "Year"])
            .or_else(|| text_in(element, &[".anime-year", ".release-year", "[data-year]"]))
            .and_then(|value| parse_year(&value));
        let type_alias = field_in(element, &["Type"])
            .or_else(|| text_in(element, &[".anime-type", ".type", "[data-type]"]))
            .and_then(|value| normalize_type(&value));
        let status = field_in(element, &["Status"])
            .or_else(|| text_in(element, &[".anime-status", ".status", "[data-status]"]))
            .and_then(|value| normalize_status(&value));
        let score = text_in(element, &[".anime-score", ".anime-rating", ".score"]).and_then(|s| number(&s));
        let genres = text_in(element, &[".anime-genre a", ".anime-genres a", ".genres a"]).into_iter().collect::<Vec<_>>();
        result.push(title_json(id, name, poster, year, type_alias, status, None, score, genres));
    }
    if result.is_empty() { return Err(format!("AnimePahe catalog returned no cards; bodyBytes={}", body.len())); }
    for (index, item) in result.iter().enumerate() { validate_title_metadata(item, "AnimePahe", &format!("catalog item {index}"))?; }
    Ok(result)
}

fn title_json(id: String, name: String, poster: Option<String>, year: Option<i64>, type_alias: Option<String>, status: Option<String>, episode_count: Option<i64>, score: Option<f64>, genres: Vec<String>) -> Value {
    json!({
        "id": id, "russianName": name, "englishName": null, "originalName": name, "japaneseName": null,
        "synonyms": [], "year": year, "type": type_alias, "episodeCount": episode_count, "posterUrl": poster,
        "status": status, "description": name, "nextEpisodeAt": null, "genres": genres,
        "ratings": score.map(|v| vec![json!({"source":"AnimePahe","value":v,"votes":null})]).unwrap_or_default(),
        "ageRating": null, "viewCount": null, "screenshots": [], "trailer": null, "sourceMaterial": null,
        "studios": [], "mainCharacters": [], "similarAnime": [], "franchiseAnime": [], "relatedAnime": [], "season": null, "availableEpisodeCount": null, "posterFallbackUrl": null
    })
}

fn details(body: &str, id: &str) -> Result<Value, String> {
    let document = html(body, "details")?;
    let name = document.text_any(&[".page-detail h1 > span:not(.sr-only)", ".page-detail h1", "h1", "meta[property='og:title']"]).map_err(|e| format!("AnimePahe title parse failed: {e:?}"))?.or_else(|| document.meta_content_any(&["og:title", "twitter:title"]).ok().flatten()).ok_or_else(|| format!("AnimePahe title is missing for {id}"))?;
    let poster = document.first_image_url(".anime-poster img, .page-detail img, meta[property='og:image']").ok().flatten().filter(|s| is_http_url(s));
    let description = document.text_any(&[".anime-synopsis", ".anime-description", ".description"]).ok().flatten();
    let rows = &[".anime-info p, .anime-info li, .anime-info .item, .anime-info .row", ".anime-meta p, .anime-meta li, .anime-meta .item"];
    let aired = document.labeled_text_any(rows, &["Aired", "Released", "Year"]).ok().flatten();
    let type_value = document.labeled_text_any(rows, &["Type", "Format"]).ok().flatten();
    let status_value = document.labeled_text_any(rows, &["Status", "State"]).ok().flatten();
    let episode_value = document.labeled_text_any(rows, &["Episode", "Episodes", "Episodes Count"]).ok().flatten();
    let year = aired.as_deref().and_then(parse_year).or_else(|| document.text_any(&[".anime-year", ".release-year"]).ok().flatten().and_then(|value| parse_year(&value)));
    let type_alias = type_value.as_deref().and_then(normalize_type).or_else(|| document.text_any(&[".anime-type", ".type"]).ok().flatten().and_then(|value| normalize_type(&value)));
    let status = status_value.as_deref().and_then(normalize_status).or_else(|| document.text_any(&[".anime-status", ".status"]).ok().flatten().and_then(|value| normalize_status(&value)));
    let episodes = episode_value.as_deref().and_then(|value| value.split(|c: char| !c.is_ascii_digit()).find_map(|part| part.parse::<i64>().ok().filter(|n| *n > 0))).or_else(|| document.text_any(&[".anime-episodes", ".episode-count"]).ok().flatten().and_then(|value| value.split(|c: char| !c.is_ascii_digit()).find_map(|part| part.parse::<i64>().ok().filter(|n| *n > 0))));
    let studios = document.labeled_text_any(rows, &["Studio", "Studios"]).ok().flatten().into_iter().collect::<Vec<_>>();
    Ok(json!({ "id": id, "russianName": name, "englishName": null, "originalName": name, "japaneseName": null, "synonyms": [], "year": year, "type": type_alias, "episodeCount": episodes, "posterUrl": poster, "status": status, "description": description.or_else(|| Some(name.clone())), "nextEpisodeAt": null, "genres": document.text(".anime-genre a").unwrap_or_default(), "ratings": [], "ageRating": null, "viewCount": null, "screenshots": [], "trailer": null, "sourceMaterial": null, "studios": studios, "mainCharacters": [], "similarAnime": [], "franchiseAnime": [], "relatedAnime": [], "season": null, "availableEpisodeCount": episodes, "posterFallbackUrl": null }))
}

fn json_value(body: &str, operation: &str) -> Result<Value, String> { JsonDocument::parse_limited(body, DEFAULT_MAX_DOCUMENT_BYTES).map(|doc| doc.root().clone()).map_err(|e| format!("AnimePahe {operation} JSON parse failed: {e:?}")) }

fn episode_array(body: &str) -> Option<Value> {
    let marker = body.find("allEpisodes")?;
    let start = body[marker..].find('[')? + marker;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in body[start..].char_indices() {
        if quoted { if escaped { escaped = false } else if ch == '\\' { escaped = true } else if ch == '"' { quoted = false } continue; }
        if ch == '"' { quoted = true; continue; }
        if ch == '[' { depth += 1 } else if ch == ']' { depth -= 1; if depth == 0 { return serde_json::from_str(&body[start..start + index + 1]).ok(); } }
    }
    None
}

fn playback_groups(request_id: &str, title_id: &str) -> Result<Value, String> {
    let id = safe_path_segment(title_id).ok_or("AnimePahe title id is invalid")?;
    let body = ajax(request_id, &format!("/viewApi?m=release&id={id}&sort=episode_asc&page=1"), &format!("/anime/{id}"))?;
    let root = json_value(&body, "episodes")?;
    let first = root.pointer("/data/0/session").and_then(Value::as_str).map(str::to_owned);
    let html_body = if let Some(session) = first { page(request_id, &format!("/play/{id}/{session}"))? } else { String::new() };
    let values = episode_array(&html_body).or_else(|| root.get("data").cloned()).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let mut seen = Vec::new();
    let episodes = values.into_iter().filter_map(|item| {
        let session = item.get("md5_id").or_else(|| item.get("session")).and_then(Value::as_str)?;
        let number = item.get("chapter_number").or_else(|| item.get("episode")).and_then(|v| v.as_f64()).or_else(|| item.get("chapter_number").and_then(Value::as_str).and_then(number))?;
        if !seen.iter().any(|id: &String| id == session) { seen.push(session.to_owned()); Some(json!({"id": format!("{id}/{session}"), "number": number, "title": item.get("title").and_then(Value::as_str) })) } else { None }
    }).collect::<Vec<_>>();
    let payload = json!({ "groups": if episodes.is_empty() { Vec::<Value>::new() } else { vec![json!({"id":id,"title":"English","qualityLabel":null,"episodes":episodes})] } });
    validate_playback_payload(&payload, "AnimePahe")?;
    Ok(payload)
}

fn player_links(request_id: &str, episode_id: &str) -> Result<Value, String> {
    let title_id = episode_id.split('/').next().ok_or("AnimePahe episode title id is missing")?;
    let session = episode_id.rsplit('/').next().ok_or("AnimePahe episode id is invalid")?;
    let session = safe_path_segment(session).ok_or("AnimePahe episode session is invalid")?;
    let body = ajax(request_id, &format!("/anime/get-servers/{session}"), &format!("/play/{title_id}/{session}"));
    let root = json_value(&body?, "servers")?;
    let links = root.get("servers").or_else(|| root.get("data")).and_then(Value::as_array).into_iter().flatten().filter_map(|server| {
        let url = ["url", "link", "src", "iframe", "player_url"].iter().find_map(|key| server.get(*key).and_then(Value::as_str)).unwrap_or("").trim();
        if !is_http_url(url) { return None; }
        Some(json!({"url":url,"type":"EMBED","quality":server.get("resolution"),"headers":{"Referer":format!("{BASE_URL}/")},"playerName":server.get("name"),"translation":"English"}))
    }).collect::<Vec<_>>();
    if !links.is_empty() {
        let payload = json!({ "links": links });
        validate_player_links_payload(&payload, "AnimePahe")?;
        return Ok(payload);
    }

    let play_html = page(request_id, &format!("/play/{title_id}/{session}"))?;
    let fallback = episode_array(&play_html).and_then(|value| value.as_array().cloned()).unwrap_or_default().into_iter().find(|item| item.get("md5_id").and_then(Value::as_str) == Some(session));
    let player_id = fallback.and_then(|item| item.get("s_id").and_then(|value| value.as_str().map(str::to_owned).or_else(|| value.as_i64().map(|number| number.to_string()))));
    let links = player_id.into_iter().flat_map(|id| [
        ("Megaplay", format!("https://megaplay.buzz/stream/s-2/{id}/dub")),
        ("Vidplay", format!("https://vidwish.live/stream/s-2/{id}/dub")),
    ]).map(|(name, url)| json!({"url":url,"type":"EMBED","quality":null,"headers":{"Referer":format!("{BASE_URL}/play/{title_id}/{session}")},"playerName":name,"translation":"English"})).collect::<Vec<_>>();
    let payload = json!({ "links": links });
    validate_player_links_payload(&payload, "AnimePahe")?;
    Ok(payload)
}

fn execute(request: Request) -> Result<Value, String> {
    if matches!(&request.operation, Operation::Search | Operation::Latest) { validate_pagination(&request.payload, "AnimePahe")?; }
    match request.operation {
        Operation::FilterCatalog => Ok(json!({"sortOptions":[{"id":"relevance","title":"Relevance"}],"typeOptions":[],"statusOptions":[],"genreOptions":[],"capabilities":{"supportedSorts":["RELEVANCE"],"supportedFilters":[],"features":["LATEST_RELEASES"]}})),
        Operation::Latest => { let (_, limit) = bounded_pagination(&request.payload); let items = card_items(&page(&request.request_id, "/latest-updated")?)?; Ok(json!({"items":items.into_iter().take(limit as usize).collect::<Vec<_>>() })) }
        Operation::Search => { let (offset, limit) = bounded_pagination(&request.payload); let query = request.payload.get("query").and_then(Value::as_str).unwrap_or("").trim(); let path = if query.is_empty() { "/latest-updated".to_owned() } else { format!("/search?q={}", enc(query)) }; let items = card_items(&page(&request.request_id, &path)?)?; Ok(json!({"items":items.into_iter().skip(offset as usize).take(limit as usize).collect::<Vec<_>>() })) }
        Operation::Details => { let id = request.payload.get("id").and_then(Value::as_str).ok_or("AnimePahe details id is missing")?; let id = safe_path_segment(id).ok_or("AnimePahe details id is invalid")?; let parsed = details(&page(&request.request_id, &format!("/anime/{id}"))?, id)?; validate_title_metadata(&parsed, "AnimePahe", "details")?; Ok(parsed) }
        Operation::PlaybackGroups => { let id = request.payload.get("titleId").and_then(Value::as_str).ok_or("AnimePahe playback titleId is missing")?; playback_groups(&request.request_id, id) }
        Operation::PlayerLinks => { let id = request.payload.get("episodeId").and_then(Value::as_str).ok_or("AnimePahe player episodeId is missing")?; player_links(&request.request_id, id) }
    }
}

static mut HEAP: usize = 4096;
#[no_mangle] pub extern "C" fn beakokit_reset() { unsafe { HEAP = 4096; } }
#[no_mangle] pub extern "C" fn beakokit_alloc(length: i32) -> i32 { unsafe { if length < 0 { return -1; } let pointer = HEAP; let Some(next) = HEAP.checked_add(length as usize) else { return -1 }; if next > i32::MAX as usize { return -1 } HEAP = next; pointer as i32 } }
#[no_mangle] pub extern "C" fn beakokit_call(pointer: i32, length: i32) -> i64 {
    if let Err(error) = validate_runtime_input(pointer, length) { return write(fail("invalid-request".to_owned(), error)); }
    let input = if length == 0 { &[] } else { unsafe { core::slice::from_raw_parts(pointer as *const u8, length as usize) } };
    let response = serde_json::from_slice::<Value>(input).map_err(|e| e.to_string()).and_then(|value| { let id = validate_runtime_request(&value)?; let mut request = serde_json::from_value::<Request>(value).map_err(|e| e.to_string())?; request.request_id = id; Ok(request) }).map(|request| { let id = request.request_id.clone(); match execute(request) { Ok(payload) => serde_json::to_vec(&Response { request_id:id, payload:Some(payload), error_code:None, error_message:None, protocol_version:PROTOCOL }).unwrap(), Err(error) => fail(id, error) } }).unwrap_or_else(|error| fail("invalid-request".to_owned(), error));
    write(response)
}
fn write(response: Vec<u8>) -> i64 { if response.len() > MAX_RUNTIME_RESPONSE_BYTES { return -1 } let pointer = beakokit_alloc(response.len() as i32); if pointer < 0 { return -1 } unsafe { core::ptr::copy_nonoverlapping(response.as_ptr(), pointer as *mut u8, response.len()); } ((pointer as u64) << 32 | response.len() as u64) as i64 }
#[cfg(not(test))]
#[link(wasm_import_module = "host")]
extern "C" { #[link_name = "call"] fn host_call(pointer: *const u8, length: i32) -> i64; }

#[cfg(test)]
#[no_mangle]
extern "C" fn call(_pointer: *const u8, _length: i32) -> i64 { -1 }

#[cfg(test)]
unsafe extern "C" fn host_call(pointer: *const u8, length: i32) -> i64 { call(pointer, length) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn extracts_episode_array_from_player_markup() { let body = r#"<script>allEpisodes: [{"md5_id":"ep-1","chapter_number":1,"s_id":"player-1"}], episodesPerDropdown</script>"#; assert_eq!(episode_array(body).unwrap()[0]["md5_id"], "ep-1"); assert_eq!(episode_array(body).unwrap()[0]["s_id"], "player-1"); }
    #[test] fn parses_animepahe_catalog_metadata_from_card_container() {
        let body = r#"<div class="anime-item"><a class="anime-poster" href="/anime/demo"><img src="/poster.jpg"></a><div class="anime-detail"><div class="anime-name"><a href="/anime/demo">Demo</a></div><div class="anime-meta"><span class="anime-type">TV</span><span class="anime-episodes">12 Eps</span><span class="anime-year">2026</span></div><div class="anime-genre"><a>Action</a></div></div></div>"#;
        let item = card_items(body).unwrap().remove(0);
        assert_eq!(item["year"], 2026);
        assert_eq!(item["type"], "tv");
        assert_eq!(item["episodeCount"], 12);
        assert_eq!(item["posterUrl"], "https://animepahetv.to/poster.jpg");
    }
    #[test] fn parses_nested_detail_metadata_without_fake_values() {
        let body = r#"<h1>Demo</h1><div class="anime-info"><p><strong>Type:</strong><a>TV</a></p><p><strong>Episode:</strong> 12</p><p><strong>Aired:</strong> Jul 7, 2026 to ?</p><p><strong>Studio:</strong><a><span itemprop="name">Diomedea</span></a></p></div>"#;
        let item = details(body, "demo").unwrap();
        assert_eq!(item["year"], 2026);
        assert_eq!(item["type"], "tv");
        assert_eq!(item["episodeCount"], 12);
        assert_eq!(item["studios"][0], "Diomedea");
    }
    #[test] fn rejects_unsafe_title_ids() { assert!(safe_path_segment("../admin").is_none()); assert!(safe_path_segment("one-piece-1").is_some()); }
    #[test] fn encodes_search_query() { assert_eq!(enc("one piece"), "one%20piece"); }
}
