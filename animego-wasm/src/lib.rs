#![allow(clippy::items_after_test_module)]

use serde::{Deserialize, Serialize};
use beakokit_html_sdk::{attribute as element_attr, bounded_pagination, clean_element_text, first_non_empty_text, first_non_empty_url, host_get_request, is_http_url, non_empty_text, non_negative_i64, normalize_status, normalize_type, normalize_year, parse_year, positive_finite, safe_numeric_segment, safe_path_segment, sanitize_runtime_error, unpack_host_response, validate_runtime_input, validate_runtime_request, ElementRef, HostResponse, HtmlDocument, JsonDocument, Selector, DEFAULT_MAX_DOCUMENT_BYTES, MAX_RUNTIME_RESPONSE_BYTES};
use serde_json::{json, Value};

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
const CATALOG_PAGE_SIZE: i64 = 20;
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

fn error(request_id: String, message: impl Into<String>) -> Vec<u8> {
    let message = sanitize_runtime_error(&message.into());
    serde_json::to_vec(&RuntimeResponse {
        request_id,
        payload: None,
        error_code: Some("SOURCE_FAILURE"),
        error_message: Some(message),
        protocol_version: RUNTIME_PROTOCOL_VERSION,
    }).unwrap()
}

fn http(request_id: &str, path: &str, headers: Value) -> Result<String, String> {
    let request = host_get_request(request_id, format!("{}{}", BASE_URL, path), headers, MAX_RESPONSE_BYTES);
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let packed = unsafe { host_call(bytes.as_ptr(), bytes.len() as i32) };
    let raw = unsafe { unpack_host_response(packed, "AnimeGo")? };
    let response: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    HostResponse::from_value_limited(&response, "AnimeGo", MAX_RESPONSE_BYTES as usize)
        .map(|response| response.body().to_owned())
        .map_err(|error| format!("AnimeGo HTTP response invalid: {error:?}"))
}

fn page(request_id: &str, path: &str) -> Result<String, String> {
    let body = http(request_id, path, json!({ "Accept": "text/html,application/json" }))?;
    // AnimeGo returns AJAX catalog/search responses as JSON with the rendered
    // HTML in `data.content`, while ordinary pages remain plain HTML.
    response_content(&body)
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

fn poster_url(value: &str) -> (String, Option<String>) {
    let source = value.trim().to_owned();
    if !is_http_url(&source) { return (String::new(), None); }
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

fn card_titles(html: &str) -> Result<Vec<Value>, String> {
    let document = parse_html(html, "catalog")?;
    let metadata_selector = Selector::parse(
        ".ani-list__item-genres__link, .ani-grid__item-genres__link, .genres a, .meta a",
    )
        .expect("valid metadata selector");
    let metadata_attribute_selector = Selector::parse(
        "[data-year], [data-release-year], [data-type], [data-kind], [data-status]",
    )
    .expect("valid metadata attribute selector");

    let parsed = document
        .linked_cards_unique(
            "a[href*='/anime/'], a[data-href*='/anime/'], a[data-url*='/anime/'], a[data-link*='/anime/']",
            &[".ani-list__item-title", ".ani-grid__item-title", ".title", "h2", "h3"],
            "img, picture source, [data-background-image], [data-background], [data-bg]",
        )
        .map_err(|error| format!("AnimeGo catalog card extraction failed: {error:?}"))?
        .into_iter()
        .map(|card| -> Result<Option<Value>, String> {
            let Some(href) = card.url.as_deref() else { return Ok(None); };
            let Some(id) = anime_slug(href) else { return Ok(None); };
            let card_element = card.element;
            let name = card
                .title
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("AnimeGo catalog card {id} has no display title"))?;
            let original = first_class_text(card_element, "fw-lighter").unwrap_or_else(|| name.clone());
            let source_poster = card.image_url;
            let (poster, poster_fallback) = source_poster.as_deref().map(poster_url)
                .unwrap_or((String::new(), None));
            let metadata = card_element
                .select(&metadata_selector)
                .filter_map(clean_element_text)
                .filter(|value| !value.is_empty())
                .chain(
                    [
                        "data-year",
                        "data-release-year",
                        "data-type",
                        "data-kind",
                        "data-status",
                    ]
                    .into_iter()
                    .filter_map(|attribute| element_attr(card_element, attribute)),
                )
                .chain(card_element.select(&metadata_attribute_selector).flat_map(|element| {
                    [
                        "data-year",
                        "data-release-year",
                        "data-type",
                        "data-kind",
                        "data-status",
                    ]
                    .into_iter()
                    .filter_map(move |attribute| element_attr(element, attribute))
                }))
                .collect::<Vec<_>>();
            let year = metadata.iter().find_map(|value| release_year(value));
            let type_alias = metadata.iter().find_map(|value| known_type(value));
            let status = metadata.iter().find_map(|value| status_alias(value));
            let genres = metadata.iter()
                .filter(|value| release_year(value).is_none() && known_type(value).is_none() && status_alias(value).is_none())
                .cloned()
                .collect::<Vec<_>>();
            let description = first_class_text(card_element, "ani-list__item-description");

            Ok(Some(json!({
                "id": id,
                "russianName": name,
                "englishName": if original != name { Some(original.clone()) } else { None::<String> },
                "originalName": original,
                "japaneseName": null,
                "synonyms": [], "year": year, "type": type_alias,
                "episodeCount": null, "posterUrl": if poster.is_empty() { Value::Null } else { json!(poster) }, "status": status,
                "description": description.or_else(|| Some(name.clone())), "nextEpisodeAt": null,
                "genres": genres, "ratings": [], "ageRating": null, "viewCount": null,
                "screenshots": [], "trailer": null, "sourceMaterial": null, "studios": [],
                "mainCharacters": [], "similarAnime": [], "franchiseAnime": [], "relatedAnime": [],
                "season": null, "availableEpisodeCount": null, "posterFallbackUrl": poster_fallback
            })))
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    Ok(parsed)
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

fn known_type(value: &str) -> Option<String> {
    normalize_type(value)
}

fn genre_values(value: Option<&Value>) -> Vec<String> {
    let values = match value {
        Some(Value::Array(items)) => items.iter().collect::<Vec<_>>(),
        Some(value) => vec![value],
        None => Vec::new(),
    };
    let mut genres = Vec::new();
    for genre in values.into_iter().filter_map(non_empty_text) {
        if !genres.iter().any(|known| known == &genre) {
            genres.push(genre);
        }
    }
    genres
}

fn release_year(value: &str) -> Option<i64> {
    parse_year(value)
}

fn status_alias(value: &str) -> Option<String> {
    normalize_status(value)
}

fn details(id: &str, html: &str) -> Result<Value, String> {
    let document = parse_html(html, "details")?;
    let field_value = |labels: &[&str]| {
        labels.iter().find_map(|label| document.labeled_text(".entity-row, body", label).ok().flatten())
    };
    let name = document
        .text_first("h1")
        .map_err(|error| format!("AnimeGo details title selector failed for {id}: {error:?}"))?
        .or_else(|| document.meta_content_any(&["og:title", "twitter:title"]).ok().flatten())
        .ok_or_else(|| format!("AnimeGo details title is missing for {id}"))?;
    let schema = json_ld_document(&document);
    let original = schema.as_ref().and_then(|v| v.get("alternateName").or_else(|| v.get("name"))).and_then(first_non_empty_text).unwrap_or_else(|| name.clone());
    let source_poster = schema.as_ref().and_then(|v| v.get("image")).and_then(first_non_empty_url)
        .and_then(|value| document.absolute_http_url(&value))
        .or_else(|| document.meta_content_any(&["og:image", "twitter:image"]).ok().flatten()
            .and_then(|value| document.absolute_http_url(&value)))
        .or_else(|| document.first_image_url(
            ".poster img, .entity-poster img, .ani-detail__poster img, img.poster, img[class*='poster'], [data-poster]",
        ).ok().flatten());
    let (poster, poster_fallback) = source_poster.as_deref().map(poster_url)
        .unwrap_or((String::new(), None));
    let description = schema.as_ref().and_then(|v| v.get("description")).and_then(non_empty_text)
        .or_else(|| document.meta_content_any(&["og:description", "twitter:description"]).ok().flatten());
    let year = schema.as_ref().and_then(|v| v.get("datePublished").or_else(|| v.get("dateCreated"))).and_then(Value::as_str).and_then(parse_year)
        .or_else(|| ["Год", "Year"].into_iter().find_map(|label| {
            field_value(&[label]).and_then(|value| parse_year(&value))
        }));
    let episode_text = field_value(&["Эпизоды", "Episodes", "Episode count"]);
    let episode_count = schema.as_ref().and_then(|v| v.get("numberOfEpisodes")).and_then(non_negative_i64)
        .or_else(|| episode_text.as_deref().and_then(|v| v.split('/').next()).and_then(|v| v.trim().parse::<i64>().ok()).filter(|value| *value >= 0));
    let type_alias = schema.as_ref().and_then(|v| v.get("@type")).and_then(first_non_empty_text).and_then(|value| known_type(&value))
        .or_else(|| field_value(&["Тип", "Type"]).and_then(|value| known_type(&value)));
    let status = schema.as_ref()
        .and_then(|value| ["status", "publicationStatus", "airingStatus", "releaseStatus"].into_iter()
            .find_map(|key| value.get(key).and_then(first_non_empty_text)))
        .and_then(|value| status_alias(&value))
        .or_else(|| field_value(&["Статус", "Status", "State"]).and_then(|value| status_alias(&value)));
    Ok(json!({
        "id": id, "russianName": name, "englishName": if original != name { Some(original.clone()) } else { None::<String> },
        "originalName": original, "japaneseName": null, "synonyms": [], "year": year, "type": type_alias,
        "episodeCount": episode_count, "posterUrl": if poster.is_empty() { Value::Null } else { json!(poster) }, "status": status,
        "description": description.or(Some(name)), "nextEpisodeAt": null, "genres": genre_values(schema.as_ref().and_then(|v| v.get("genre"))), "ratings": [],
        "ageRating": schema.as_ref().and_then(|v| v.get("contentRating")), "viewCount": null, "screenshots": [], "trailer": null,
        "sourceMaterial": null, "studios": [], "mainCharacters": [], "similarAnime": [], "franchiseAnime": [], "relatedAnime": [],
        "season": null, "availableEpisodeCount": episode_text.as_deref().and_then(|v| v.split('/').next()).and_then(|v| v.trim().parse::<i64>().ok()).filter(|value| *value >= 0), "posterFallbackUrl": poster_fallback
    }))
}

fn json_ld_document(document: &HtmlDocument) -> Option<Value> {
    let documents = document.json_ld_documents().ok()?;
    documents.iter()
        .find(|value| value.get("@type").and_then(first_non_empty_text).and_then(|value| known_type(&value)).is_some())
        .cloned()
        .or_else(|| documents.into_iter().find(|value| {
            value.get("@type").is_some() || value.get("name").is_some() || value.get("alternateName").is_some()
        }))
}

fn filter_options(html: &str, prefix: &str) -> Result<Vec<Value>, String> {
    let document = parse_html(html, "filters")?;
    let group = prefix.trim_end_matches('_');
    let selector = format!(
        "input[name^='{prefix}'], select[name^='{group}'] option, select[data-filter='{group}'] option"
    );
    let mut seen_ids = Vec::new();
    Ok(document
        .select(&selector)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|input| {
            let id = element_attr(input, "value").filter(|value| !value.is_empty())?;
            if seen_ids.iter().any(|seen| seen == &id) { return None; }
            seen_ids.push(id.clone());
            let title = element_attr(input, "data-title")
                .or_else(|| element_attr(input, "aria-label"))
                .or_else(|| {
                    let input_id = element_attr(input, "id")?;
                    document.select("label").ok()?.into_iter()
                        .find(|label| element_attr(*label, "for").as_deref() == Some(input_id.as_str()))
                        .and_then(clean_element_text)
                })
                .or_else(|| {
                    let parent = input.parent().and_then(ElementRef::wrap)?;
                    (parent.value().name() == "label").then(|| clean_element_text(parent)).flatten()
                })
                .or_else(|| clean_element_text(input))
                .unwrap_or_else(|| id.clone());
            if title.trim().is_empty() { return None; }
            Some(json!({ "id": id, "title": title }))
        })
        .collect())
}

fn filters(html: &str) -> Result<Value, String> {
    let sort_options = ["relevance", "year", "rating"]
        .iter().map(|v| json!({"id": v, "title": v})).collect::<Vec<_>>();
    let type_options = filter_options(html, "type_")?;
    let status_options = filter_options(html, "status_")?;
    if type_options.is_empty() { return Err("AnimeGo filters contain no type options".to_owned()); }
    if status_options.is_empty() { return Err("AnimeGo filters contain no status options".to_owned()); }
    Ok(json!({
        "sortOptions": sort_options,
        "typeOptions": type_options, "statusOptions": status_options,
        "genreOptions": filter_options(html, "genres_")?,
        "capabilities": { "supportedSorts": ["RELEVANCE", "YEAR", "RATING"], "supportedFilters": ["TYPE", "STATUS", "INCLUDED_GENRES", "EXCLUDED_GENRES", "YEAR_RANGE"], "features": ["LATEST_RELEASES"], "fallbackSort": "RELEVANCE" }
    }))
}

fn string_filter_values(payload: &Value, field: &str) -> Result<Option<Vec<String>>, String> {
    let Some(value) = payload.get(field) else { return Ok(None); };
    let values = value
        .as_array()
        .ok_or_else(|| format!("AnimeGo filter field {field} must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("AnimeGo filter field {field} item {index} must be a string"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(values))
}

fn filter_path(p: &Value) -> Result<String, String> {
    let mut parts = Vec::new();
    let from = p.get("yearFrom").and_then(normalize_year).map(|value| value.to_string()); let to = p.get("yearTo").and_then(normalize_year).map(|value| value.to_string());
    if let Some(from) = from { parts.push(if let Some(to) = to { format!("year-from-{}-to-{}", enc(&from), enc(&to)) } else { format!("year-from-{}", enc(&from)) }); }
    else if let Some(to) = to { parts.push(format!("year-to-{}", enc(&to))); }
    let mut genres = Vec::new();
    if let Some(values) = string_filter_values(p, "includedGenreAliases")? {
        genres.extend(values.iter().map(|value| enc(value)));
    }
    if let Some(values) = string_filter_values(p, "excludedGenreAliases")? {
        genres.extend(values.iter().map(|value| format!("!{}", enc(value))));
    }
    if !genres.is_empty() { parts.push(format!("genres-is-{}", genres.join("-or-"))); }
    for (field, prefix) in [("typeAliases", "type-is"), ("statusAliases", "status-is")] {
        if let Some(values) = string_filter_values(p, field)? {
            let values = values.iter().map(|value| enc(value)).collect::<Vec<_>>();
            if !values.is_empty() { parts.push(format!("{prefix}-{}", values.join("-or-"))); }
        }
    }
    Ok(if parts.is_empty() { "/anime".to_owned() } else { format!("/anime/filter/{}/apply", parts.join("/")) })
}

fn catalog_sort(p: &Value) -> (&'static str, &'static str) {
    match p.get("sort").and_then(Value::as_str).unwrap_or("RELEVANCE") {
        "YEAR" => ("startDate", "desc"),
        "RATING" => ("rating", "desc"),
        _ => ("createdAt", "asc"),
    }
}

fn catalog_page_path(base: &str, offset: i64) -> String {
    if offset <= 0 {
        base.to_owned()
    } else {
        format!("{base}/{}", offset / CATALOG_PAGE_SIZE + 1)
    }
}

fn page_items(items: Vec<Value>, offset: i64, limit: i64) -> Vec<Value> {
    items
        .into_iter()
        .skip((offset.rem_euclid(CATALOG_PAGE_SIZE)) as usize)
        .take(limit as usize)
        .collect()
}

fn catalog_error_context(error: String, operation: &str, path: &str, offset: i64, limit: i64) -> String {
    format!("{error}; operation={operation}; path={path}; offset={offset}; limit={limit}")
}

fn response_content(body: &str) -> Result<String, String> {
    let Ok(document) = JsonDocument::parse_limited(body, DEFAULT_MAX_DOCUMENT_BYTES) else {
        return Ok(body.to_owned());
    };
    match document.text_any(&["/data/content", "/content", "/data/html", "/html"]) {
        Ok(content) => Ok(content),
        Err(_) if !matches!(body.trim_start().chars().next(), Some('{') | Some('[')) => {
            Ok(body.to_owned())
        }
        Err(_) => Err("AnimeGo AJAX JSON response has no HTML content field".to_owned()),
    }
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
    let mut seen_ids = Vec::new();
    let mut parsed = document
        .select("[data-episode], [data-episode-id]")
        .unwrap_or_default()
        .into_iter()
        .filter_map(|episode| {
            let id = element_attr(episode, "data-episode")
                .or_else(|| element_attr(episode, "data-episode-id"))?;
            let number = element_attr(episode, "data-episode-number")
                .or_else(|| element_attr(episode, "data-number"))
                .and_then(|value| value.trim().replace(',', ".").parse::<f64>().ok())
                .or_else(|| {
                    let content = episode.text().collect::<String>();
                    text(&content).split_whitespace()
                        .find_map(|part| part.replace(',', ".").parse::<f64>().ok())
                })
                .and_then(positive_finite)?;
            if seen_ids.iter().any(|seen| seen == &id) { return None; }
            seen_ids.push(id.clone());
            Some(json!({
                "id": id,
                "number": number,
                "title": element_attr(episode, "data-episode-title")
                    .or_else(|| element_attr(episode, "data-title"))
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

fn episode_items_with_diagnostics(html: &str) -> Result<Vec<Value>, String> {
    let items = episode_items(html)?;
    if items.is_empty() && (html.contains("data-episode") || html.contains("data-episode-id")) {
        return Err("AnimeGo episode markup contained no valid numeric episodes".to_owned());
    }
    Ok(items)
}

fn player_items(html: &str) -> Result<Vec<Value>, String> {
    let document = parse_html(html, "players")?;
    let mut seen_urls = Vec::new();
    Ok(document
        .select("[data-player], [data-video]")
        .unwrap_or_default()
        .into_iter()
        .filter_map(|player| {
            let raw_url = element_attr(player, "data-player")
                .or_else(|| element_attr(player, "data-video"))?;
            let url = document.absolute_http_url(&raw_url)?;
            if seen_urls.iter().any(|seen| seen == &url) { return None; }
            seen_urls.push(url.clone());
            Some(json!({
                "url": url,
                "type": "EMBED",
                "quality": null,
                "headers": { "Referer": format!("{BASE_URL}/") },
                "playerName": element_attr(player, "data-provider-title")
                    .or_else(|| element_attr(player, "data-provider")),
                "translation": element_attr(player, "data-translation-title")
                    .or_else(|| element_attr(player, "data-translation")),
                "segments": [],
                "videoId": null
            }))
        })
        .collect::<Vec<_>>())
}

fn player_items_with_diagnostics(html: &str) -> Result<Vec<Value>, String> {
    let items = player_items(html)?;
    if items.is_empty() && (html.contains("data-player") || html.contains("data-video")) {
        return Err("AnimeGo player response contained no valid HTTP player URLs".to_owned());
    }
    Ok(items)
}

fn execute(request: RuntimeRequest) -> Result<Value, String> {
    match request.operation {
        RuntimeOperation::FilterCatalog => filters(&page(&request.request_id, "/anime")?),
        RuntimeOperation::Latest => {
            let (offset, limit) = bounded_pagination(&request.payload);
            let path = catalog_page_path("/anime", offset);
            let items = card_titles_with_diagnostics(&page(&request.request_id, &path)?, "LATEST")
                .map_err(|error| catalog_error_context(error, "LATEST", &path, offset, limit))?;
            Ok(json!({ "items": page_items(items, offset, limit) }))
        }
        RuntimeOperation::Search => {
            let p = &request.payload; let (offset, limit) = bounded_pagination(p);
            let query = p.get("query").and_then(Value::as_str).unwrap_or("").trim();
            let path = if !query.is_empty() {
                format!("/search/all?q={}&page={}", enc(query), offset / 20 + 1)
            } else {
                let base = filter_path(p)?;
                let page = if offset > 0 { format!("/{}", offset / CATALOG_PAGE_SIZE + 1) } else { String::new() };
                let (sort, direction) = catalog_sort(p);
                format!("{base}{page}?entities=true&sort={sort}&direction={direction}")
            };
            let items = card_titles_with_diagnostics(&page(&request.request_id, &path)?, "SEARCH")
                .map_err(|error| catalog_error_context(error, "SEARCH", &path, offset, limit))?;
            Ok(json!({ "items": page_items(items, offset, limit) }))
        }
        RuntimeOperation::Details => { let id = request.payload.get("id").and_then(Value::as_str).ok_or("details id is missing")?; let id = safe_path_segment(id).ok_or("AnimeGo anime id is invalid")?; details(id, &page(&request.request_id, &format!("/anime/{id}"))?) }
        RuntimeOperation::PlaybackGroups => {
            let id = request.payload.get("titleId").and_then(Value::as_str).ok_or("playback titleId is missing")?;
            let numeric = id.rsplit('-').next().ok_or("AnimeGo title id has no numeric suffix")?;
            let numeric = safe_numeric_segment(numeric).ok_or("AnimeGo numeric id is invalid")?;
            let episodes = episode_items_with_diagnostics(&response_content(&ajax(&request.request_id, &format!("/player/{numeric}"))?)?)?;
            Ok(json!({ "groups": if episodes.is_empty() { Vec::<Value>::new() } else { vec![json!({ "id": id, "title": "AnimeGo", "qualityLabel": null, "episodes": episodes })] } }))
        }
        RuntimeOperation::PlayerLinks => {
            let id = request.payload.get("titleId").and_then(Value::as_str).ok_or("player links titleId is missing")?;
            let episode = request.payload.get("episodeId").and_then(Value::as_str).ok_or("player links episodeId is missing")?;
            let episode = safe_path_segment(episode).ok_or("AnimeGo episode id is invalid")?;
            let html = response_content(&ajax(&request.request_id, &format!("/player/videos/{episode}"))?)?;
            let links = player_items_with_diagnostics(&html)?.into_iter().filter(|v| v.get("url").and_then(Value::as_str).is_some()).collect::<Vec<_>>();
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
        let html = response_content(&body).expect("HTML content");
        let items = card_titles_with_diagnostics(&html, "SEARCH").expect("catalog cards");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "krutoy-uchitel-onidzuka-556");
        assert_eq!(items[0]["russianName"], "Крутой учитель Онидзука");
        assert_eq!(items[0]["originalName"], "GTO");
    }

    #[test]
    fn reports_ajax_json_without_html_content() {
        let error = response_content(r#"{"status":"success","data":{"unexpected":true}}"#)
            .expect_err("malformed AJAX JSON was accepted");
        assert!(error.contains("no HTML content field"));
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
    fn filters_duplicate_and_blank_options() {
        let html = r#"
            <input name="type_a" value="tv" data-title="TV">
            <input name="type_b" value="tv" data-title="TV duplicate">
            <input name="type_c" value="" data-title="Blank">
            <input name="type_d" value="movie" data-title="Movie">
        "#;
        assert_eq!(filter_options(html, "type_").unwrap(), vec![
            json!({"id":"tv", "title":"TV"}),
            json!({"id":"movie", "title":"Movie"})
        ]);
    }

    #[test]
    fn reads_filter_title_from_matching_label() {
        let html = r#"<input id="type_tv" name="type_tv" value="tv"><label for="type_tv">TV Series</label>"#;
        assert_eq!(filter_options(html, "type_").unwrap(), vec![json!({"id":"tv", "title":"TV Series"})]);
    }

    #[test]
    fn reads_filter_title_from_wrapping_label() {
        let html = r#"<label>Movie<input name="type_movie" value="movie"></label>"#;
        assert_eq!(filter_options(html, "type_").unwrap(), vec![json!({"id":"movie", "title":"Movie"})]);
    }

    #[test]
    fn reads_filter_options_from_select_controls() {
        let html = r#"
            <select name="type"><option value="tv">TV Series</option></select>
            <select data-filter="status"><option value="ongoing">Currently airing</option></select>
        "#;
        assert_eq!(filter_options(html, "type_" ).unwrap(), vec![json!({"id":"tv", "title":"TV Series"})]);
        assert_eq!(filter_options(html, "status_" ).unwrap(), vec![json!({"id":"ongoing", "title":"Currently airing"})]);
    }

    #[test]
    fn reports_missing_required_filter_groups() {
        let html = r#"
            <input name="type_tv" value="tv" data-title="TV">
            <input name="status_released" value="released" data-title="Released">
        "#;
        assert!(filters(html).is_ok());
        assert!(filters(r#"<input name="type_tv" value="tv">"#).is_err());
    }

    #[test]
    fn validates_animego_filter_arrays() {
        assert_eq!(string_filter_values(&json!({"types":["tv", " movie "]}), "types").unwrap(), Some(vec!["tv".to_owned(), "movie".to_owned()]));
        assert!(string_filter_values(&json!({"types":"tv"}), "types").is_err());
        assert!(string_filter_values(&json!({"types":["tv", 1]}), "types").is_err());
    }

    #[test]
    fn encodes_filter_values_before_building_catalog_path() {
        let path = filter_path(&json!({
            "yearFrom": "2020",
            "yearTo": "2430",
            "includedGenreAliases": ["action/romance"],
            "excludedGenreAliases": ["?unsafe"],
            "typeAliases": ["tv series"]
        })).expect("filter path");

        assert_eq!(path, "/anime/filter/year-from-2020/genres-is-action%2Fromance-or-!%3Funsafe/type-is-tv%20series/apply");
    }

    #[test]
    fn builds_catalog_pages_from_client_offsets() {
        assert_eq!(catalog_page_path("/anime", 0), "/anime");
        assert_eq!(catalog_page_path("/anime", 20), "/anime/2");
        assert_eq!(catalog_page_path("/anime/filter/apply", 40), "/anime/filter/apply/3");
    }

    #[test]
    fn slices_a_catalog_page_without_losing_offset_items() {
        let items = (0..20).map(|value| json!(value)).collect::<Vec<_>>();
        assert_eq!(page_items(items.clone(), 0, 3), vec![json!(0), json!(1), json!(2)]);
        assert_eq!(page_items(items.clone(), 5, 3), vec![json!(5), json!(6), json!(7)]);
        let second_page = (20..40).map(|value| json!(value)).collect::<Vec<_>>();
        assert_eq!(page_items(second_page, 20, 3), vec![json!(20), json!(21), json!(22)]);
    }

    #[test]
    fn adds_request_context_to_empty_catalog_errors() {
        let error = catalog_error_context("no cards".to_owned(), "SEARCH", "/search/all?page=2", 20, 20);
        assert_eq!(error, "no cards; operation=SEARCH; path=/search/all?page=2; offset=20; limit=20");
    }

    #[test]
    fn accepts_only_safe_anime_slugs() {
        assert_eq!(anime_slug("/anime/krutoy-uchitel-onidzuka-556"), Some("krutoy-uchitel-onidzuka-556".to_owned()));
        assert_eq!(anime_slug("https://animego.org/anime/title-123?tab=episodes"), Some("title-123".to_owned()));
        assert_eq!(anime_slug("/admin/title-123"), None);
        assert_eq!(anime_slug("/anime/../123"), None);
        assert_eq!(safe_numeric_segment("23659"), Some("23659"));
        assert!(safe_numeric_segment("23659-extra").is_none());
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
    fn uses_poster_alt_text_instead_of_publishing_a_service_slug() {
        let html = r#"
            <a href='/anime/example-title-123'><img alt='Example title' src='poster.webp'></a>
        "#;
        let items = card_titles_with_diagnostics(html, "SEARCH").expect("catalog cards");

        assert_eq!(items[0]["russianName"], "Example title");
        assert_ne!(items[0]["russianName"], "example-title-123");
    }

    #[test]
    fn parses_ajax_card_links_without_href() {
        let html = r#"<a data-href='/anime/ajax-title-123'><img alt='AJAX title' src='poster.webp'></a>"#;
        let items = card_titles_with_diagnostics(html, "SEARCH").expect("catalog cards");
        assert_eq!(items[0]["id"], "ajax-title-123");
        assert_eq!(items[0]["russianName"], "AJAX title");
    }

    #[test]
    fn parses_background_card_posters() {
        let html = r#"<article><a href='/anime/background-title-123'><div data-background-image='/poster.webp'>Background title</div></a></article>"#;
        let items = card_titles_with_diagnostics(html, "SEARCH").expect("catalog cards");
        assert_eq!(items[0]["posterUrl"], "https://animego.me/poster.webp");
    }

    #[test]
    fn reads_card_metadata_from_data_attributes() {
        let html = r#"
            <article>
                <a href="/anime/data-card-123"><img alt="Data card" src="poster.webp"></a>
                <span data-year="2022" data-type="TV Series" data-status="Ongoing"></span>
            </article>
        "#;
        let items = card_titles_with_diagnostics(html, "SEARCH").expect("catalog cards");
        assert_eq!(items[0]["year"], 2022);
        assert_eq!(items[0]["type"], "tv");
        assert_eq!(items[0]["status"], "ongoing");
    }

    #[test]
    fn skips_cards_without_a_display_title() {
        let html = "<a href='/anime/example-title-123'><img src='poster.webp'></a>";
        assert!(card_titles_with_diagnostics(html, "SEARCH").is_err());
    }

    #[test]
    fn normalizes_details_metadata_for_client() {
        let html = r#"
            <script type="application/ld+json">{"@type":"TVSeries","name":"GTO","datePublished":"1999-06-30","numberOfEpisodes":43}</script>
            <h1>Крутой учитель Онидзука</h1>
            <script type="application/ld+json">{{"@type":"TVSeries","name":"Крутой учитель Онидзука","alternateName":"Great Teacher Onizuka","datePublished":"1999-06-30","numberOfEpisodes":43,"genre":["Комедия"]}}</script>
            <div>Тип</div><div>Сериал</div>
            <div>Эпизоды</div><div>43</div>
            <div>Статус</div><div>Вышел</div>"#;
        let title = details("krutoy-uchitel-onidzuka-556", html).expect("details");

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
        assert_eq!(items[0]["genres"], json!(["Комедия"]));
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
        assert_eq!(title["genres"], json!(["Комедия", "Сёнен"]));
    }

    #[test]
    fn prefers_anime_json_ld_over_breadcrumb_metadata() {
        let html = r#"
            <h1>Demo title</h1>
            <script type="application/ld+json">{"@type":"BreadcrumbList","name":"Home"}</script>
            <script type="application/ld+json">{"@type":"TVSeries","name":"Demo title","datePublished":"2024-01-01","numberOfEpisodes":12}</script>
        "#;
        let title = details("demo-123", html).expect("details");
        assert_eq!(title["type"], "tv");
        assert_eq!(title["year"], 2024);
        assert_eq!(title["episodeCount"], 12);
    }

    #[test]
    fn falls_back_to_detail_poster_markup() {
        let html = r#"<h1>Markup poster</h1><div class="entity-poster"><img src="/poster.jpg"></div>"#;
        let title = details("markup-poster-123", html).expect("details");
        assert_eq!(title["posterUrl"], "https://animego.me/poster.jpg");
    }

    #[test]
    fn falls_back_to_detail_year_markup() {
        let html = r#"<h1>Markup year</h1><div class="entity-row"><div>Год</div><div>2021</div></div>"#;
        let title = details("markup-year-123", html).expect("details");
        assert_eq!(title["year"], 2021);
    }

    #[test]
    fn reads_english_detail_fields_and_schema_status() {
        let html = r#"
            <h1>English metadata</h1>
            <script type="application/ld+json">{"@type":"TVSeries","dateCreated":"2020-01-01","status":"Finished airing","numberOfEpisodes":"12"}</script>
            <div class="entity-row"><div>Type</div><div>TV Series</div></div>
            <div class="entity-row"><div>Episodes</div><div>12 / 12</div></div>
        "#;
        let title = details("english-metadata-123", html).expect("details");
        assert_eq!(title["type"], "tv");
        assert_eq!(title["year"], 2020);
        assert_eq!(title["episodeCount"], 12);
        assert_eq!(title["status"], "released");
    }

    #[test]
    fn parses_episode_cards_with_dom_and_keeps_numeric_order() {
        let html = r#"
            <button data-episode="ep-2" data-episode-number="2">2</button>
            <button data-episode="ep-1" data-episode-number="1" data-episode-title="Pilot">1</button>
            <button data-episode="ep-1" data-episode-number="1">duplicate</button>
            <button data-episode="ep-negative" data-episode-number="-1">invalid</button>
        "#;
        let episodes = episode_items(html).expect("episodes");

        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[0]["id"], "ep-1");
        assert_eq!(episodes[0]["title"], "Pilot");
        assert_eq!(episodes[1]["id"], "ep-2");
    }

    #[test]
    fn parses_episode_numbers_with_spaces_and_decimal_commas() {
        let html = r#"<button data-episode="ep-2" data-episode-number=" 2,5 ">2,5</button>"#;
        let episodes = episode_items(html).expect("episodes");
        assert_eq!(episodes[0]["number"], 2.5);
    }

    #[test]
    fn parses_alternate_episode_data_attributes() {
        let html = r#"<button data-episode-id="episode-3" data-number="3" data-title="Finale"></button>"#;
        let episodes = episode_items(html).expect("episodes");
        assert_eq!(episodes[0]["id"], "episode-3");
        assert_eq!(episodes[0]["number"], 3.0);
        assert_eq!(episodes[0]["title"], "Finale");
    }

    #[test]
    fn keeps_a_valid_episode_when_an_invalid_duplicate_comes_first() {
        let html = r#"
            <button data-episode="ep-1" data-episode-number="broken">broken</button>
            <button data-episode="ep-1" data-episode-number="1">1</button>
        "#;
        let episodes = episode_items(html).expect("episodes");

        assert_eq!(episodes.len(), 1);
        assert_eq!(episodes[0]["number"], 1.0);
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

    #[test]
    fn parses_alternate_player_data_attributes() {
        let html = r#"<button data-video="/embed/video" data-provider="Aksor" data-translation="Dub"></button>"#;
        let players = player_items(html).expect("players");
        assert_eq!(players[0]["url"], "https://animego.me/embed/video");
        assert_eq!(players[0]["playerName"], "Aksor");
        assert_eq!(players[0]["translation"], "Dub");
    }

    #[test]
    fn deduplicates_player_urls() {
        let html = r#"
            <a data-player="/embed/one" data-provider-title="Aksor"></a>
            <a data-player="https://animego.me/embed/one" data-provider-title="Aksor"></a>
            <a data-player="/embed/two" data-provider-title="Other"></a>
        "#;
        let players = player_items(html).expect("players");

        assert_eq!(players.len(), 2);
    }

    #[test]
    fn rejects_unsafe_poster_urls() {
        assert_eq!(poster_url("javascript:alert(1)"), (String::new(), None));
    }

    #[test]
    fn reports_player_markup_without_valid_http_urls() {
        let html = r#"<a data-player="javascript:alert(1)"></a>"#;
        assert!(player_items_with_diagnostics(html).is_err());
        assert!(player_items_with_diagnostics("<div>No players</div>").unwrap().is_empty());
    }

    #[test]
    fn reports_episode_markup_without_valid_numbers() {
        let html = r#"<button data-episode="broken" data-episode-number="unknown"></button>"#;
        assert!(episode_items_with_diagnostics(html).is_err());
        assert!(episode_items_with_diagnostics("<div>No episodes</div>").unwrap().is_empty());
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
                Ok(mut request) => { request.request_id = request_id; let request_id = request.request_id.clone(); match execute(request) { Ok(payload) => serde_json::to_vec(&RuntimeResponse { request_id, payload: Some(payload), error_code: None, error_message: None, protocol_version: RUNTIME_PROTOCOL_VERSION }).unwrap(), Err(message) => error(request_id, message) } }
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
