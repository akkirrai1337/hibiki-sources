// Anichi scripted extension for Hibiki. Runs on a fork of the "KuAnime"/AniKoto engine (the same
// backend family behind hianime.to/zoro.to-style clones) - unlike the official upstream site,
// this fork's `vrf` query parameter isn't actually validated as a real signature: passing the
// plain id/query back verbatim works fine (confirmed directly against the live site), so no AES/JS
// deobfuscation is needed here despite the engine supporting it upstream.
//
// Playback resolution is a two-step ajax dance: /ajax/server/list?servers=<data-ids> lists each
// server's opaque link id, then /ajax/server?get=<linkId> resolves ONE of those to the actual
// embed URL. Most servers here resolve to megaplay.buzz - the exact CDN Hibiki already has a full
// WebView-relay pipeline for (see animepahe-player/WebViewStreamRelay) - so this source declares
// that same resolver as a dependency instead of writing a new one; a server that resolves to some
// other, not-yet-supported host just won't play until a resolver for it exists, same as any source.

function S(value) { return value === null || value === undefined ? null : String(value); }

/** A definite non-2xx (dead file, gone mirror, ...) means skip it; a network hiccup on this
 * check alone shouldn't hide an otherwise-good link, so that case fails open (returns true). */
function isEmbedReachable(url) {
    try {
        return fetch(url, { headers: { "Referer": BASE_URL + "/" } }).ok;
    } catch (e) {
        return true;
    }
}

var BASE_URL = "https://anichi.to";
var MAX_RESULTS = 50;
var LISTING_PAGE_SIZE = 30;
var XHR_HEADERS = { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" };

var ANIME_PATH = /^anime\/([^/]+)\/?$/;

/** Fills in every AnimeTitle field so the Kotlin-side JSON decode always sees a complete object. */
function title(fields) {
    var base = {
        russianName: null, englishName: null, japaneseName: null, synonyms: [],
        year: null, type: null, episodeCount: null, posterUrl: null, status: null,
        description: null, nextEpisodeAt: null, genres: [], ratings: [], ageRating: null,
        viewCount: null, screenshots: [], trailer: null, sourceMaterial: null, studios: [],
        mainCharacters: [], similarAnime: [], franchiseAnime: [], relatedAnime: [],
        season: null, availableEpisodeCount: null, posterFallbackUrl: null,
    };
    for (var key in fields) base[key] = fields[key];
    return base;
}

/** true for a status worth a single immediate retry - a transient server hiccup or rate limit,
 * not a genuine "this doesn't exist" (404) or "you're not allowed" (401/403). */
function isTransientStatus(status) {
    return status === 429 || (status >= 500 && status < 600);
}

function getHtml(path) {
    var response = fetch(BASE_URL + path, { headers: { "Referer": BASE_URL + "/" } });
    if (!response.ok && isTransientStatus(response.status)) {
        response = fetch(BASE_URL + path, { headers: { "Referer": BASE_URL + "/" } });
    }
    if (!response.ok) throw new Error("Anichi returned HTTP " + response.status + " for " + path);
    return S(response.body);
}

function fetchAjax(path, referer) {
    var headers = { "Referer": referer || (BASE_URL + "/") };
    for (var key in XHR_HEADERS) headers[key] = XHR_HEADERS[key];
    var response = fetch(BASE_URL + path, { headers: headers });
    if (!response.ok && isTransientStatus(response.status)) {
        response = fetch(BASE_URL + path, { headers: headers });
    }
    if (!response.ok) throw new Error("Anichi ajax returned HTTP " + response.status + " for " + path);
    var data = JSON.parse(S(response.body));
    if (data.status !== 200) throw new Error("Anichi ajax reported status " + data.status + " for " + path);
    return data.result;
}

/** Fragment endpoints (episode/server lists) return an HTML string in `result`. */
function getAjaxFragment(path, referer) {
    return fetchAjax(path, referer);
}

/** `/ajax/server?get=` instead returns a JSON object (`{url, skip_data}`) in `result`. */
function getAjaxResult(path, referer) {
    return fetchAjax(path, referer);
}

function idFromHref(href) {
    if (href.indexOf(BASE_URL) === 0) href = href.substring(BASE_URL.length);
    if (href.charAt(0) === "/") href = href.substring(1);
    var match = ANIME_PATH.exec(href.split("?")[0]);
    return match !== null ? match[1] : null;
}

function toType(raw) {
    return raw ? raw.trim().toLowerCase() : null;
}

function toStatus(raw) {
    if (!raw) return null;
    var normalized = raw.trim().toLowerCase();
    if (normalized.indexOf("airing") >= 0 && normalized.indexOf("finished") < 0) return "ongoing";
    if (normalized.indexOf("finished") >= 0 || normalized.indexOf("completed") >= 0) return "released";
    return normalized;
}

/** Mirrors a `<div class="series-fact"><span class="series-fact__label">Label</span><span
 * class="series-fact__value">value</span></div>` row from the anime detail page. */
function seriesFact(document, label) {
    var facts = document.select(".series-fact");
    for (var i = 0; i < facts.size(); i++) {
        var fact = facts.get(i);
        var labelEl = fact.selectFirst(".series-fact__label");
        if (labelEl === null || S(labelEl.text()).trim().toLowerCase() !== label.toLowerCase()) continue;
        var valueEl = fact.selectFirst(".series-fact__value");
        var value = valueEl !== null ? S(valueEl.text()).trim() : null;
        return value !== null && value.length > 0 ? value : null;
    }
    return null;
}

function parseCard(item) {
    var link = item.selectFirst("a[href]");
    if (link === null) return null;
    var href = S(link.absUrl("href"));
    var id = idFromHref(href);
    if (id === null) return null;

    var img = link.selectFirst("img");
    var name = img !== null ? S(img.attr("alt")).trim() : "";
    if (name.length === 0) return null;
    var posterUrl = img !== null ? S(img.absUrl("src")) : null;

    var type = null;
    var right = item.selectFirst(".meta .right");
    if (right !== null) type = toType(S(right.text()));

    return title({ id: id, englishName: name, originalName: name, posterUrl: posterUrl, type: type });
}

function parseCardList(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var items = document.select("div.ani.items > div.item");
    var results = [];
    var seen = {};
    for (var i = 0; i < items.size(); i++) {
        var parsed = parseCard(items.get(i));
        if (parsed === null || seen[parsed.id]) continue;
        seen[parsed.id] = true;
        results.push(parsed);
    }
    return results;
}

function parseDetails(id, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var titleEl = document.selectFirst("h1.series-title");
    if (titleEl === null) return null;
    var name = S(titleEl.text()).trim();
    if (name.length === 0) return null;
    var japaneseName = S(titleEl.attr("data-jp")).trim();

    var nativeEl = document.selectFirst(".series-native");
    var synonyms = [];
    if (nativeEl !== null) {
        var native = S(nativeEl.text()).trim();
        if (native.length > 0 && native !== japaneseName) synonyms.push(native);
    }

    var posterEl = document.selectFirst(".series-intro__poster img");
    var posterUrl = posterEl !== null ? S(posterEl.absUrl("src")) : null;

    var descriptionEl = document.selectFirst(".series-blurb__full p, .series-blurb__short p");
    var descriptionText = descriptionEl !== null ? S(descriptionEl.text()).trim() : null;

    var genreLinks = document.select(".series-genres__list a");
    var genres = [];
    for (var g = 0; g < genreLinks.size(); g++) genres.push(S(genreLinks.get(g).text()).trim());

    var scoreEl = document.selectFirst(".series-score b");
    var ratings = [];
    if (scoreEl !== null) {
        var scoreValue = parseFloat(S(scoreEl.text()));
        if (!isNaN(scoreValue)) ratings.push({ source: "MAL", value: scoreValue, votes: null });
    }

    var episodeCountField = seriesFact(document, "Episodes");
    var episodeCount = episodeCountField !== null ? parseInt(episodeCountField, 10) : null;
    if (episodeCount !== null && isNaN(episodeCount)) episodeCount = null;

    var airedField = seriesFact(document, "Aired");
    var year = null;
    if (airedField !== null) {
        var yearMatch = /(\d{4})/.exec(airedField);
        if (yearMatch !== null) year = parseInt(yearMatch[1], 10);
    }

    var studioField = seriesFact(document, "Studios");

    var animeIdEl = document.selectFirst("[data-id][data-url]");
    var animeId = animeIdEl !== null ? S(animeIdEl.attr("data-id")).trim() : null;

    return {
        titleData: title({
            id: id,
            englishName: name,
            originalName: name,
            japaneseName: japaneseName.length > 0 ? japaneseName : null,
            synonyms: synonyms,
            posterUrl: posterUrl,
            description: descriptionText,
            genres: genres,
            ratings: ratings,
            type: toType(seriesFact(document, "Type")),
            status: toStatus(seriesFact(document, "Status")),
            episodeCount: episodeCount,
            year: year,
            studios: studioField !== null ? [studioField] : [],
            ageRating: seriesFact(document, "Rating"),
        }),
        animeId: animeId,
    };
}

function fetchCatalogPage(path, page) {
    return parseCardList(getHtml(path + (path.indexOf("?") >= 0 ? "&" : "?") + "page=" + page));
}

function fetchSearchPage(query, page) {
    return parseCardList(getHtml("/filter?keyword=" + encodeURIComponent(query) + "&page=" + page + "&vrf=" + encodeURIComponent(query)));
}

function collectResults(fetchPage, wanted) {
    var results = [];
    var page = 1;
    var seen = {};
    while (results.length < wanted && page <= 50) {
        // A page past the site's real last page can error instead of returning an empty listing -
        // either way, there's nothing more to collect, so stop cleanly instead of surfacing a
        // fetch error for what is really just "no more results".
        var items;
        try { items = fetchPage(page); } catch (e) { break; }
        if (items.length === 0) break;
        for (var i = 0; i < items.length; i++) {
            if (seen[items[i].id]) continue;
            seen[items[i].id] = true;
            results.push(items[i]);
        }
        if (items.length < LISTING_PAGE_SIZE) break;
        page += 1;
    }
    return results;
}

function resolveAnimeId(titleId) {
    var parsed = parseDetails(titleId, getHtml("/anime/" + titleId));
    if (parsed === null || parsed.animeId === null) throw new Error("Anichi anime id was not found: " + titleId);
    return parsed.animeId;
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var offset = Math.max(request.offset || 0, 0);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var query = (request.query || "").trim();

        var results = query.length > 0
            ? collectResults(function (page) { return fetchSearchPage(query, page); }, offset + limit)
            : collectResults(function (page) { return fetchCatalogPage("/most-viewed/", page); }, offset + limit);
        return results.slice(offset, offset + limit);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        return collectResults(function (page) { return fetchCatalogPage("/latest-updated/", page); }, safeLimit).slice(0, safeLimit);
    },

    getSettings: function () {
        return { sortOptions: [{ id: "relevance", title: "Relevance" }] };
    },

    getById: function (id) {
        var path = String(id).trim();
        var parsed = parseDetails(path, getHtml("/anime/" + path));
        if (parsed === null) throw new Error("Anichi title was not found: " + id);
        return parsed.titleData;
    },

    getPlaybackGroups: function (titleId) {
        var animeId = resolveAnimeId(titleId);
        var fragment = getAjaxFragment("/ajax/episode/list/" + animeId + "?vrf=" + animeId, BASE_URL + "/anime/" + titleId);
        var document = Jsoup.parseBodyFragment(fragment, BASE_URL);
        var items = document.select("a[data-ids]");
        var episodes = [];
        for (var i = 0; i < items.size(); i++) {
            var item = items.get(i);
            var dataIds = S(item.attr("data-ids")).trim();
            if (dataIds.length === 0) continue;
            var number = parseFloat(S(item.attr("data-num"))) || (i + 1);
            var episodeTitle = S(item.parent() !== null ? item.parent().attr("title") : "").trim();
            if (episodeTitle.length === 0) {
                var nameEl = item.selectFirst(".d-title");
                episodeTitle = nameEl !== null ? S(nameEl.text()).trim() : null;
            }
            episodes.push({ id: dataIds, number: number, title: episodeTitle && episodeTitle.length > 0 ? episodeTitle : null });
        }
        if (episodes.length === 0) return [];
        episodes.sort(function (a, b) { return a.number - b.number; });
        return [{ id: titleId, title: "Episodes", episodes: episodes, qualityLabel: null }];
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var fragment = getAjaxFragment("/ajax/server/list?servers=" + encodeURIComponent(episodeId));
        var document = Jsoup.parseBodyFragment(fragment, BASE_URL);
        var typeSections = document.select(".type[data-type]");
        var referer = { "Referer": BASE_URL + "/" };
        var links = [];
        var seenUrls = {};

        for (var t = 0; t < typeSections.size(); t++) {
            var section = typeSections.get(t);
            var typeLabel = S(section.attr("data-type")).toUpperCase();
            var servers = section.select("li[data-link-id]");
            for (var i = 0; i < servers.size(); i++) {
                var server = servers.get(i);
                var linkId = S(server.attr("data-link-id")).trim();
                var serverName = S(server.text()).trim();
                if (linkId.length === 0 || serverName.length === 0) continue;

                var embedUrl;
                try {
                    var resolved = getAjaxResult("/ajax/server?get=" + encodeURIComponent(linkId));
                    embedUrl = resolved && resolved.url ? String(resolved.url) : null;
                } catch (e) {
                    embedUrl = null;
                }
                if (!embedUrl || seenUrls[embedUrl]) continue;
                seenUrls[embedUrl] = true;

                // This engine's own server list can point at a genuinely dead file (megaplay.buzz
                // returns a real, fast HTTP 410 "removed due to copyright violation" for some
                // titles/servers) - the app's own browser-based resolver has no fast way to tell
                // that apart from a slow/finicky-but-alive CDN, so it burns its whole per-player
                // timeout on it. A quick native check here is cheap and lets a truly dead mirror
                // get skipped instead of stalling playback behind it.
                if (!isEmbedReachable(embedUrl)) continue;

                links.push({
                    url: embedUrl, type: "EMBED", quality: null, headers: referer,
                    playerName: serverName + " (" + typeLabel + ")", translation: null, segments: [], videoId: null,
                });
            }
        }
        return links;
    },
};
