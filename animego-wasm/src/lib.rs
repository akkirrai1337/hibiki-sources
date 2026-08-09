use serde::{Deserialize, Serialize};
use beakokit_html_sdk::{ElementRef, HtmlDocument, JsonDocument, Selector, DEFAULT_MAX_DOCUMENT_BYTES};
use serde_json::{json, Value};

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
const HOST_PROTOCOL_VERSION: u32 = 1;
const BASE_URL: &str = "https://animego.me";
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

#[derive(Serialize)]
struct HostRequest {
    #[serde(rename = "requestId")]
    request_id: String,
    operation: &'static str,
    payload: Value,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
}

fn error(request_id: String, message: impl Into<String>) -> Vec<u8> {
    let message = message.into().replace(['\r', '\n'], " ");
    serde_json::to_vec(&RuntimeResponse {
        request_id,
        payload: None,
        error_code: Some("SOURCE_FAILURE"),
        error_message: Some(message),
        protocol_version: RUNTIME_PROTOCOL_VERSION,
    }).unwrap()
}

fn http(request_id: &str, path: &str, headers: Value) -> Result<String, String> {
    let request = HostRequest {
        request_id: format!("{request_id}-http"),
        operation: "HTTP_REQUEST",
        payload: json!({
            "method": "GET",
            "url": format!("{}{}", BASE_URL, path),
            "headers": headers,
            "body": null,
            "timeoutMillis": 30_000,
            "maxResponseBytes": MAX_RESPONSE_BYTES
        }),
        protocol_version: HOST_PROTOCOL_VERSION,
    };
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let packed = unsafe { host_call(bytes.as_ptr(), bytes.len() as i32) };
    if packed < 0 { return Err("AnimeGo host HTTP request failed".to_owned()); }
    let ptr = (packed as u64 >> 32) as usize;
    let len = (packed as u64 & u32::MAX as u64) as usize;
    let raw = unsafe { core::slice::from_raw_parts(ptr as *const u8, len) };
    let response: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    if let Some(message) = response.get("errorMessage").and_then(Value::as_str) {
        return Err(message.to_owned());
    }
    let status = response.pointer("/payload/statusCode").and_then(Value::as_u64).unwrap_or(200);
    if !(200..300).contains(&status) {
        return Err(format!("AnimeGo host HTTP request returned status {status}"));
    }
    response.pointer("/payload/body")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "AnimeGo response did not contain a body".to_owned())
}

fn page(request_id: &str, path: &str) -> Result<String, String> {
    let body = http(request_id, path, json!({ "Accept": "text/html,application/json" }))?;
    // AnimeGo returns AJAX catalog/search responses as JSON with the rendered
    // HTML in `data.content`, while ordinary pages remain plain HTML.
    Ok(response_content(&body))
}

fn parse_html(html: &str, operation: &str) -> Result<HtmlDocument, String> {
    HtmlDocument::parse_limited(html, BASE_URL, DEFAULT_MAX_DOCUMENT_BYTES)
        .map_err(|error| format!("AnimeGo {operation} HTML parse failed: {error:?}"))
}

fn ajax(request_id: &str, path: &str) -> Result<String, String> {
    http(request_id, path, json!({
        "Accept": "text/html,application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": format!("{BASE_URL}/")
    }))
}

fn enc(value: &str) -> String {
    value.bytes().flat_map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![b as char],
        b => format!("%{b:02X}").chars().collect(),
    }).collect()
}

fn scalar(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
        .or_else(|| value.as_i64().map(|v| v.to_string()))
}

fn text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut inside = false;
    for ch in value.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => output.push(ch),
            _ => {},
        }
    }
    output.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .split_whitespace()
        .collect::<Vec<_>>().join(" ")
}

fn absolute_url(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") { value.to_owned() }
    else if value.starts_with("//") { format!("https:{value}") }
    else { format!("{BASE_URL}{}", if value.starts_with('/') { value.to_owned() } else { format!("/{value}") }) }
}

fn poster_url(value: &str) -> (String, Option<String>) {
    let source = absolute_url(value);
    if source.starts_with("https://img.cdngos.com/") {
        let encoded = enc(&source);
        (format!("https://images.weserv.nl/?url={encoded}&w=500&h=700&fit=cover&output=webp"), Some(source))
    } else { (source, None) }
}

fn anime_slug(value: &str) -> Option<String> {
    let value = value.split('?').next().unwrap_or(value).trim_end_matches('/');
    let slug = value.rsplit("/anime/").next()?.split('/').next()?;
    if slug.len() > 2 && slug.chars().last()?.is_ascii_digit() && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        Some(slug.to_owned())
    } else { None }
}

fn safe_slice<'a>(html: &'a str, mut start: usize, mut end: usize) -> &'a str {
    start = start.min(html.len());
    end = end.min(html.len()).max(start);
    while start > 0 && !html.is_char_boundary(start) {
        start -= 1;
    }
    while end < html.len() && !html.is_char_boundary(end) {
        end += 1;
    }
    &html[start..end]
}

fn card_titles(html: &str) -> Result<Vec<Value>, String> {
    let document = parse_html(html, "catalog")?;
    let title_selector = Selector::parse(".ani-list__item-title, .ani-grid__item-title, .title, h2, h3")
        .expect("valid anime title selector");
    let image_selector = Selector::parse("img").expect("valid image selector");
    let metadata_selector = Selector::parse(
        ".ani-list__item-genres__link, .ani-grid__item-genres__link, .genres a, .meta a",
    )
    .expect("valid metadata selector");

    let mut parsed = document
        .select("a[href*='/anime/']")
        .expect("valid anime link selector")
        .into_iter()
        .filter_map(|link| {
            let href = link.value().attr("href")?;
            let id = anime_slug(href)?;
            let card = link.parent().and_then(ElementRef::wrap).unwrap_or(link);
            let name = link
                .value()
                .attr("title")
                .map(text)
                .filter(|value| !value.is_empty())
                .or_else(|| first_text(card, &title_selector))
                .or_else(|| clean_element_text(link))
                .unwrap_or_else(|| id.clone());
            let original = first_class_text(card, "fw-lighter").unwrap_or_else(|| name.clone());
            let source_poster = card
                .select(&image_selector)
                .next()
                .and_then(|image| {
                    ["src", "data-src", "data-original"]
                        .into_iter()
                        .find_map(|attribute| image.value().attr(attribute))
                })
                .map(absolute_url);
            let (poster, poster_fallback) = source_poster.as_deref().map(poster_url)
                .unwrap_or((String::new(), None));
            let metadata = card
                .select(&metadata_selector)
                .map(|element| clean_element_text(element))
                .flatten()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            let year = metadata.iter().find_map(|value| release_year(value));
            let type_alias = metadata.iter().find_map(|value| known_type(value));
            let description = first_class_text(card, "ani-list__item-description");

            Some(json!({
                "id": id,
                "russianName": name,
                "englishName": if original != name { Some(original.clone()) } else { None::<String> },
                "originalName": original,
                "japaneseName": null,
                "synonyms": [], "year": year, "type": type_alias,
                "episodeCount": null, "posterUrl": if poster.is_empty() { Value::Null } else { json!(poster) }, "status": null,
                "description": description.or_else(|| Some(name.clone())), "nextEpisodeAt": null,
                "genres": metadata, "ratings": [], "ageRating": null, "viewCount": null,
                "screenshots": [], "trailer": null, "sourceMaterial": null, "studios": [],
                "mainCharacters": [], "similarAnime": [], "franchiseAnime": [], "relatedAnime": [],
                "season": null, "availableEpisodeCount": null, "posterFallbackUrl": poster_fallback
            }))
        })
        .collect::<Vec<_>>();
    let mut unique = Vec::new();
    for item in parsed.drain(..) {
        if !unique.iter().any(|value: &Value| value.get("id") == item.get("id")) {
            unique.push(item);
        }
    }
    Ok(unique)
}

fn first_text(element: ElementRef<'_>, selector: &Selector) -> Option<String> {
    element
        .select(selector)
        .find_map(clean_element_text)
}

fn first_class_text(element: ElementRef<'_>, class_name: &str) -> Option<String> {
    let selector = Selector::parse(&format!(".{class_name}"))
        .expect("class name is controlled by the source");
    first_text(element, &selector)
}

fn clean_element_text(element: ElementRef<'_>) -> Option<String> {
    let value = text(&element.text().collect::<String>());
    (!value.is_empty()).then_some(value)
}

fn type_alias(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "tv" | "tvseries" | "\u{0441}\u{0435}\u{0440}\u{0438}\u{0430}\u{043b}" => "tv".to_owned(),
        "movie" | "\u{0444}\u{0438}\u{043b}\u{044c}\u{043c}" => "movie".to_owned(),
        "ova" => "ova".to_owned(),
        "ona" => "ona".to_owned(),
        _ => value.trim().to_owned(),
    }
}

fn known_type(value: &str) -> Option<String> {
    let mapped = type_alias(value);
    matches!(mapped.as_str(), "tv" | "movie" | "ova" | "ona").then_some(mapped)
}

fn release_year(value: &str) -> Option<i64> {
    let digits = value.trim_matches(|c: char| !c.is_ascii_digit());
    let year = digits.parse::<i64>().ok()?;
    (1900..=2100).contains(&year).then_some(year)
}

fn status_alias(value: &str) -> Option<String> {
    match value.trim().to_lowercase().as_str() {
        "released" | "completed" | "finished" | "\u{0432}\u{044b}\u{0448}\u{0435}\u{043b}" => Some("released".to_owned()),
        "ongoing" | "airing" | "releasing" | "\u{043e}\u{043d}\u{0433}\u{043e}\u{0438}\u{043d}\u{0433}" | "\u{0432}\u{044b}\u{0445}\u{043e}\u{0434}\u{0438}\u{0442}" => Some("ongoing".to_owned()),
        "announcement" | "announced" | "\u{0430}\u{043d}\u{043e}\u{043d}\u{0441}" => Some("announcement".to_owned()),
        _ => None,
    }
}

fn field_value(html: &str, label: &str) -> Option<String> {
    let marker = format!(">{}<", label);
    let label_at = html.find(&marker)?;
    let after_label = label_at + marker.len();
    let value_tag = safe_slice(html, after_label, html.len()).find("<div")? + after_label;
    let value_start = safe_slice(html, value_tag, html.len()).find('>')? + value_tag + 1;
    let value_end = safe_slice(html, value_start, html.len()).find("</div>")? + value_start;
    let value = text(safe_slice(html, value_start, value_end));
    (!value.is_empty()).then_some(value)
}

fn details(id: &str, html: &str) -> Result<Value, String> {
    let document = parse_html(html, "details")?;
    let name = document
        .text_first("h1")
        .map_err(|error| format!("AnimeGo details title selector failed for {id}: {error:?}"))?
        .ok_or_else(|| format!("AnimeGo details title is missing for {id}"))?;
    let schema = json_ld_document(&document);
    let original = schema.as_ref().and_then(|v| v.get("alternateName").or_else(|| v.get("name"))).and_then(Value::as_str).unwrap_or(&name).to_owned();
    let source_poster = schema.as_ref().and_then(|v| v.get("image")).and_then(Value::as_str).map(absolute_url);
    let (poster, poster_fallback) = source_poster.as_deref().map(poster_url)
        .unwrap_or((String::new(), None));
    let description = schema.as_ref().and_then(|v| v.get("description")).and_then(Value::as_str).map(str::to_owned);
    let year = schema.as_ref().and_then(|v| v.get("datePublished")).and_then(Value::as_str).and_then(|v| v.chars().take(4).collect::<String>().parse::<i64>().ok());
    let episode_text = field_value(html, "\u{042d}\u{043f}\u{0438}\u{0437}\u{043e}\u{0434}\u{044b}");
    let episode_count = schema.as_ref().and_then(|v| v.get("numberOfEpisodes")).and_then(Value::as_i64)
        .or_else(|| episode_text.as_deref().and_then(|v| v.split('/').next()).and_then(|v| v.trim().parse::<i64>().ok()));
    let type_alias = schema.as_ref().and_then(|v| v.get("@type")).and_then(Value::as_str).and_then(known_type)
        .or_else(|| field_value(html, "\u{0422}\u{0438}\u{043f}").and_then(|value| known_type(&value)));
    let status = field_value(html, "\u{0421}\u{0442}\u{0430}\u{0442}\u{0443}\u{0441}").and_then(|value| status_alias(&value));
    Ok(json!({
        "id": id, "russianName": name, "englishName": if original != name { Some(original.clone()) } else { None::<String> },
        "originalName": original, "japaneseName": null, "synonyms": [], "year": year, "type": type_alias,
        "episodeCount": episode_count, "posterUrl": if poster.is_empty() { Value::Null } else { json!(poster) }, "status": status,
        "description": description.or_else(|| Some(name)), "nextEpisodeAt": null, "genres": schema.as_ref().and_then(|v| v.get("genre")).cloned().unwrap_or_else(|| json!([])), "ratings": [],
        "ageRating": schema.as_ref().and_then(|v| v.get("contentRating")), "viewCount": null, "screenshots": [], "trailer": null,
        "sourceMaterial": null, "studios": [], "mainCharacters": [], "similarAnime": [], "franchiseAnime": [], "relatedAnime": [],
        "season": null, "availableEpisodeCount": episode_text.as_deref().and_then(|v| v.split('/').next()).and_then(|v| v.trim().parse::<i64>().ok()), "posterFallbackUrl": poster_fallback
    }))
}

fn json_ld_document(document: &HtmlDocument) -> Option<Value> {
    document.select("script[type='application/ld+json']").ok()?.into_iter().find_map(|script| {
        let body = script.text().collect::<String>();
        serde_json::from_str::<Value>(body.trim()).ok()
    })
}

fn filter_options(html: &str, prefix: &str) -> Result<Vec<Value>, String> {
    let document = parse_html(html, "filters")?;
    let selector = format!("input[name^='{prefix}']");
    Ok(document
        .select(&selector)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|input| {
            let id = element_attr(input, "value")?;
            let title = element_attr(input, "data-title")
                .or_else(|| element_attr(input, "aria-label"))
                .unwrap_or_else(|| id.clone());
            Some(json!({ "id": id, "title": title }))
        })
        .collect())
}

fn filters(html: &str) -> Result<Value, String> {
    let sort_options = ["relevance", "year", "rating"]
        .iter().map(|v| json!({"id": v, "title": v})).collect::<Vec<_>>();
    Ok(json!({
        "sortOptions": sort_options,
        "typeOptions": filter_options(html, "type_")?, "statusOptions": filter_options(html, "status_")?,
        "genreOptions": filter_options(html, "genres_")?,
        "capabilities": { "supportedSorts": ["RELEVANCE", "YEAR", "RATING"], "supportedFilters": ["TYPE", "STATUS", "INCLUDED_GENRES", "EXCLUDED_GENRES", "YEAR_RANGE"], "features": ["LATEST_RELEASES"], "fallbackSort": "RELEVANCE" }
    }))
}

fn filter_path(p: &Value) -> String {
    let mut parts = Vec::new();
    let from = p.get("yearFrom").and_then(scalar); let to = p.get("yearTo").and_then(scalar);
    if let Some(from) = from { parts.push(if let Some(to) = to { format!("year-from-{from}-to-{to}") } else { format!("year-from-{from}") }); }
    else if let Some(to) = to { parts.push(format!("year-to-{to}")); }
    let mut genres = Vec::new();
    if let Some(values) = p.get("includedGenreAliases").and_then(Value::as_array) {
        genres.extend(values.iter().filter_map(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned));
    }
    if let Some(values) = p.get("excludedGenreAliases").and_then(Value::as_array) {
        genres.extend(values.iter().filter_map(Value::as_str).filter(|v| !v.is_empty()).map(|v| format!("!{v}")));
    }
    if !genres.is_empty() { parts.push(format!("genres-is-{}", genres.join("-or-"))); }
    for (field, prefix) in [("typeAliases", "type-is"), ("statusAliases", "status-is")] {
        if let Some(values) = p.get(field).and_then(Value::as_array) {
            let values = values.iter().filter_map(Value::as_str).filter(|v| !v.is_empty()).collect::<Vec<_>>();
            if !values.is_empty() { parts.push(format!("{prefix}-{}", values.join("-or-"))); }
        }
    }
    if parts.is_empty() { "/anime".to_owned() } else { format!("/anime/filter/{}/apply", parts.join("/")) }
}

fn catalog_sort(p: &Value) -> (&'static str, &'static str) {
    match p.get("sort").and_then(Value::as_str).unwrap_or("RELEVANCE") {
        "YEAR" => ("startDate", "desc"),
        "RATING" => ("rating", "desc"),
        _ => ("createdAt", "asc"),
    }
}

fn response_content(body: &str) -> String {
    let Ok(document) = JsonDocument::parse_limited(body, DEFAULT_MAX_DOCUMENT_BYTES) else { return body.to_owned(); };
    document
        .string("/data/content")
        .or_else(|_| document.string("/content"))
        .unwrap_or_else(|_| body.to_owned())
}

fn card_titles_with_diagnostics(html: &str, operation: &str) -> Result<Vec<Value>, String> {
    let items = card_titles(html)?;
    if !items.is_empty() {
        return Ok(items);
    }
    Err(format!(
        "AnimeGo {operation} returned no cards: bodyBytes={}, animeLinks={}, contentContainer={}, jsonBody={}",
        html.len(),
        html.contains("href=\"/anime/"),
        html.contains("content-container"),
        html.trim_start().starts_with('{'),
    ))
}

fn episode_items(html: &str) -> Result<Vec<Value>, String> {
    let document = parse_html(html, "episodes")?;
    let mut parsed = document
        .select("[data-episode]")
        .unwrap_or_default()
        .into_iter()
        .filter_map(|episode| {
            let id = element_attr(episode, "data-episode")?;
            let number = element_attr(episode, "data-episode-number")
                .and_then(|value| value.replace(',', ".").parse::<f64>().ok())
                .or_else(|| {
                    let content = episode.text().collect::<String>();
                    text(&content).split_whitespace()
                        .find_map(|part| part.replace(',', ".").parse::<f64>().ok())
                })?;
            Some(json!({
                "id": id,
                "number": number,
                "title": element_attr(episode, "data-episode-title")
            }))
        })
        .collect::<Vec<_>>();
    parsed.sort_by(|left, right| {
        left.get("number").and_then(Value::as_f64)
            .partial_cmp(&right.get("number").and_then(Value::as_f64))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(parsed)
}

fn player_items(html: &str) -> Result<Vec<Value>, String> {
    let document = parse_html(html, "players")?;
    Ok(document
        .select("[data-player]")
        .unwrap_or_default()
        .into_iter()
        .filter_map(|player| {
            let url = element_attr(player, "data-player")?;
            Some(json!({
                "url": absolute_url(&url),
                "type": "EMBED",
                "quality": null,
                "headers": { "Referer": format!("{BASE_URL}/") },
                "playerName": element_attr(player, "data-provider-title"),
                "translation": element_attr(player, "data-translation-title"),
                "segments": [],
                "videoId": null
            }))
        })
        .collect::<Vec<_>>())
}

fn element_attr(element: ElementRef<'_>, name: &str) -> Option<String> {
    element.value().attr(name).map(str::to_owned)
}

fn execute(request: RuntimeRequest) -> Result<Value, String> {
    match request.operation {
        RuntimeOperation::FilterCatalog => filters(&page(&request.request_id, "/anime")?),
        RuntimeOperation::Latest => Ok(json!({ "items": card_titles_with_diagnostics(&page(&request.request_id, "/anime")?, "LATEST")?.into_iter().take(request.payload.get("limit").and_then(Value::as_i64).unwrap_or(20).max(1) as usize).collect::<Vec<_>>() })),
        RuntimeOperation::Search => {
            let p = &request.payload; let limit = p.get("limit").and_then(Value::as_i64).unwrap_or(20).clamp(1, 50); let offset = p.get("offset").and_then(Value::as_i64).unwrap_or(0).max(0);
            let query = p.get("query").and_then(Value::as_str).unwrap_or("").trim();
            let path = if !query.is_empty() {
                format!("/search/all?q={}&page={}", enc(query), offset / 20 + 1)
            } else {
                let base = filter_path(p);
                let page = if offset > 0 { format!("/{}", offset / 20 + 1) } else { String::new() };
                let (sort, direction) = catalog_sort(p);
                format!("{base}{page}?entities=true&sort={sort}&direction={direction}")
            };
            Ok(json!({ "items": card_titles_with_diagnostics(&page(&request.request_id, &path)?, "SEARCH")?.into_iter().skip((offset % 20) as usize).take(limit as usize).collect::<Vec<_>>() }))
        }
        RuntimeOperation::Details => { let id = request.payload.get("id").and_then(Value::as_str).ok_or("details id is missing")?; details(id, &page(&request.request_id, &format!("/anime/{id}"))?) }
        RuntimeOperation::PlaybackGroups => {
            let id = request.payload.get("titleId").and_then(Value::as_str).ok_or("playback titleId is missing")?;
            let numeric = id.rsplit('-').next().ok_or("AnimeGo title id has no numeric suffix")?;
            let episodes = episode_items(&response_content(&ajax(&request.request_id, &format!("/player/{numeric}"))?))?;
            Ok(json!({ "groups": if episodes.is_empty() { Vec::<Value>::new() } else { vec![json!({ "id": id, "title": "AnimeGo", "qualityLabel": null, "episodes": episodes })] } }))
        }
        RuntimeOperation::PlayerLinks => {
            let id = request.payload.get("titleId").and_then(Value::as_str).ok_or("player links titleId is missing")?;
            let episode = request.payload.get("episodeId").and_then(Value::as_str).ok_or("player links episodeId is missing")?;
            let html = response_content(&ajax(&request.request_id, &format!("/player/videos/{episode}"))?);
            let links = player_items(&html)?.into_iter().filter(|v| v.get("url").and_then(Value::as_str).is_some()).collect::<Vec<_>>();
            if id.is_empty() { return Err("AnimeGo title id is blank".to_owned()); }
            Ok(json!({ "links": links }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD_HTML: &str = r#"
        <div class="anime-card">
            <a data-kind="anime" title="Крутой учитель Онидзука" href='/anime/krutoy-uchitel-onidzuka-556'>
                <img class="poster" src="https://img.cdngos.com/poster.webp">
                <span class="fw-lighter">GTO</span>
                <span class="ani-list__item-description">Учитель в необычной школе</span>
            </a>
        </div>
    "#;

    #[test]
    fn parses_ajax_catalog_envelope_like_client_response() {
        let body = json!({ "status": "success", "data": { "content": CARD_HTML } }).to_string();
        let html = response_content(&body);
        let items = card_titles_with_diagnostics(&html, "SEARCH").expect("catalog cards");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "krutoy-uchitel-onidzuka-556");
        assert_eq!(items[0]["russianName"], "Крутой учитель Онидзука");
        assert_eq!(items[0]["originalName"], "GTO");
    }

    #[test]
    fn extracts_filter_options_from_input_dom() {
        let html = r#"
            <input name="type_tv" value="tv" data-title="TV">
            <input name="type_movie" value="movie" aria-label="Movie">
            <input name="status_released" value="released">
        "#;

        assert_eq!(filter_options(html, "type_").unwrap(), vec![json!({"id":"tv", "title":"TV"}), json!({"id":"movie", "title":"Movie"})]);
        assert_eq!(filter_options(html, "status_").unwrap(), vec![json!({"id":"released", "title":"released"})]);
    }

    #[test]
    fn reports_oversized_html_with_operation_context() {
        let html = "x".repeat(DEFAULT_MAX_DOCUMENT_BYTES + 1);
        let error = match parse_html(&html, "catalog") {
            Ok(_) => panic!("oversized HTML was accepted"),
            Err(error) => error,
        };

        assert!(error.contains("AnimeGo catalog HTML parse failed"));
        assert!(error.contains("DocumentTooLarge"));
    }

    #[test]
    fn parses_plain_html_latest_response() {
        let items = card_titles_with_diagnostics(CARD_HTML, "LATEST").expect("latest cards");

        assert_eq!(items.len(), 1);
        assert!(items[0]["posterUrl"].as_str().is_some());
        assert_eq!(items[0]["description"], "Учитель в необычной школе");
    }

    #[test]
    fn ignores_non_anime_links_and_deduplicates_cards() {
        let html = format!(
            "<a href='/login'>login</a>{CARD_HTML}{CARD_HTML}<a href='/anime/type/tv'>type</a>"
        );
        let items = card_titles_with_diagnostics(&html, "SEARCH").expect("anime cards");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "krutoy-uchitel-onidzuka-556");
    }

    #[test]
    fn uses_title_from_card_body_when_picture_link_has_no_title() {
        let html = r#"
            <div class="ani-list__item">
                <a class="ani-list__item-picture" href="/anime/monolog-farmacevta-2-2727">
                    <img alt="Монолог фармацевта 2" src="poster.webp">
                </a>
                <div class="ani-list__item-title"><a href="/anime/monolog-farmacevta-2-2727">Монолог фармацевта 2</a></div>
                <div class="fw-lighter">Kusuriya no Hitorigoto 2nd Season</div>
            </div>
        "#;
        let items = card_titles_with_diagnostics(html, "SEARCH").expect("anime cards");

        assert_eq!(items[0]["russianName"], "Монолог фармацевта 2");
        assert_eq!(items[0]["originalName"], "Kusuriya no Hitorigoto 2nd Season");
    }

    #[test]
    fn normalizes_details_metadata_for_client() {
        let html = format!(
            r#"<h1>Крутой учитель Онидзука</h1>
            <script type="application/ld+json">{{"@type":"TVSeries","name":"Крутой учитель Онидзука","alternateName":"Great Teacher Onizuka","datePublished":"1999-06-30","numberOfEpisodes":43,"genre":["Комедия"]}}</script>
            <div>Тип</div><div>Сериал</div>
            <div>Эпизоды</div><div>43</div>
            <div>Статус</div><div>Вышел</div>"#
        );
        let title = details("krutoy-uchitel-onidzuka-556", &html).expect("details");

        assert_eq!(title["type"], "tv");
        assert_eq!(title["year"], 1999);
        assert_eq!(title["episodeCount"], 43);
        assert_eq!(title["status"], "released");
    }

    #[test]
    fn parses_captured_animego_card_metadata_for_client() {
        let items = card_titles_with_diagnostics(
            include_str!("../tests/fixtures/catalog-card.html"),
            "LATEST",
        ).expect("catalog cards");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["russianName"], "Крутой учитель Онидзука");
        assert_eq!(items[0]["year"], 1999);
        assert_eq!(items[0]["type"], "tv");
        assert!(items[0]["posterUrl"].as_str().is_some());
    }

    #[test]
    fn ignores_title_id_numbers_when_card_has_no_release_year() {
        let html = r#"
            <div class="ani-list__item">
                <a class="ani-list__item-picture" href="/anime/title-2430"><img alt="Без даты" src="poster.webp"></a>
                <div class="ani-list__item-title"><a href="/anime/title-2430">Без даты</a></div>
            </div>
        "#;
        let items = card_titles_with_diagnostics(html, "LATEST").expect("catalog cards");

        assert_eq!(items[0]["year"], Value::Null);
    }

    #[test]
    fn parses_captured_animego_details_metadata_for_client() {
        let title = details(
            "krutoy-uchitel-onidzuka-556",
            include_str!("../tests/fixtures/details.html"),
        ).expect("details");

        assert_eq!(title["russianName"], "Крутой учитель Онидзука");
        assert_eq!(title["englishName"], "Great Teacher Onizuka");
        assert_eq!(title["type"], "tv");
        assert_eq!(title["year"], 1999);
        assert_eq!(title["episodeCount"], 43);
        assert_eq!(title["availableEpisodeCount"], 43);
        assert_eq!(title["status"], "released");
    }

    #[test]
    fn parses_episode_cards_with_dom_and_keeps_numeric_order() {
        let html = r#"
            <button data-episode="ep-2" data-episode-number="2">2</button>
            <button data-episode="ep-1" data-episode-number="1" data-episode-title="Pilot">1</button>
        "#;
        let episodes = episode_items(html).expect("episodes");

        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[0]["id"], "ep-1");
        assert_eq!(episodes[0]["title"], "Pilot");
        assert_eq!(episodes[1]["id"], "ep-2");
    }

    #[test]
    fn parses_player_links_by_attributes_without_raw_html_scanning() {
        let html = r#"
            <a data-player="/embed/one" data-provider-title="Aksor" data-translation-title="Dub"></a>
        "#;
        let players = player_items(html).expect("players");

        assert_eq!(players.len(), 1);
        assert_eq!(players[0]["url"], "https://animego.me/embed/one");
        assert_eq!(players[0]["playerName"], "Aksor");
    }
}

static mut HEAP: usize = 4096;
#[no_mangle] pub extern "C" fn beakokit_reset() { unsafe { HEAP = 4096; } }
#[no_mangle] pub extern "C" fn beakokit_alloc(length: i32) -> i32 { unsafe { let ptr = HEAP; HEAP += length.max(0) as usize; ptr as i32 } }
#[no_mangle] pub extern "C" fn beakokit_call(pointer: i32, length: i32) -> i64 {
    let input = unsafe { core::slice::from_raw_parts(pointer as *const u8, length.max(0) as usize) };
    let response = match serde_json::from_slice::<RuntimeRequest>(input) {
        Ok(request) => { let request_id = request.request_id.clone(); match execute(request) { Ok(payload) => serde_json::to_vec(&RuntimeResponse { request_id, payload: Some(payload), error_code: None, error_message: None, protocol_version: RUNTIME_PROTOCOL_VERSION }).unwrap(), Err(message) => error(request_id, message) } }
        Err(e) => error("invalid-request".to_owned(), e.to_string()),
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
