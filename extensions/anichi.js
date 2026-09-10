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
        return fetch(url, { headers: { "Referer": BASE_URL + "/", "User-Agent": BROWSER_USER_AGENT } }).ok;
    } catch (e) {
        return true;
    }
}

/** Checks all mirrors in one network wave. A status-0 batch item represents the same transport
 * failure that isEmbedReachable deliberately treats as inconclusive, so it also fails open. */
function getEmbedReachability(urls) {
    if (typeof fetchAll !== "function") {
        var serial = [];
        for (var i = 0; i < urls.length; i++) serial.push(isEmbedReachable(urls[i]));
        return serial;
    }
    try {
        var requests = [];
        for (var j = 0; j < urls.length; j++) {
            requests.push({
                url: urls[j],
                headers: { "Referer": BASE_URL + "/", "User-Agent": BROWSER_USER_AGENT },
            });
        }
        var responses = fetchAll(requests);
        var reachable = [];
        for (var r = 0; r < responses.length; r++) {
            reachable.push(!responses[r] || responses[r].status === 0 || responses[r].ok);
        }
        return reachable;
    } catch (e) {
        var fallback = [];
        for (var k = 0; k < urls.length; k++) fallback.push(isEmbedReachable(urls[k]));
        return fallback;
    }
}

var BASE_URL = "https://anichi.to";
var MAX_RESULTS = 50;
var LISTING_PAGE_SIZE = 30;
// The host's Ktor client otherwise identifies itself as "Hibiki/0.1 Android" by default - an
// obvious non-browser signature that this site's bot-management can and does 500 on, even though
// the exact same page loads fine (confirmed directly) from a real Ktor/Node/browser client that
// sends a normal desktop-Chrome User-Agent instead. Every request here overrides it explicitly.
var BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
var XHR_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": BROWSER_USER_AGENT,
};

var ANIME_PATH = /^anime\/([^/]+)\/?$/;

/** Fills in every AnimeTitle field so the Kotlin-side JSON decode always sees a complete object. */
function title(fields) { return AnimeTitle(fields); }

// Transient statuses (429/5xx) don't need handling here - the host's fetch() already retries
// those automatically (with backoff and Retry-After support) before returning, so a non-ok
// response here is already past that.

function getHtml(path) {
    var headers = { "Referer": BASE_URL + "/", "User-Agent": BROWSER_USER_AGENT };
    var response = fetch(BASE_URL + path, { headers: headers });
    if (!response.ok) throw new Error("Anichi returned HTTP " + response.status + " for " + path);
    return S(response.body);
}

function ajaxRequest(path, referer) {
    var headers = { "Referer": referer || (BASE_URL + "/") };
    for (var key in XHR_HEADERS) headers[key] = XHR_HEADERS[key];
    return { url: BASE_URL + path, headers: headers };
}

function parseAjaxResponse(response, path) {
    if (!response.ok) throw new Error("Anichi ajax returned HTTP " + response.status + " for " + path);
    var data = JSON.parse(S(response.body));
    if (data.status !== 200) throw new Error("Anichi ajax reported status " + data.status + " for " + path);
    return data.result;
}

function fetchAjax(path, referer) {
    var request = ajaxRequest(path, referer);
    return parseAjaxResponse(fetch(request.url, { headers: request.headers }), path);
}

/** Resolves independent ajax endpoints concurrently on both desktop and Android. Individual bad
 * mirrors become null, just like the old per-server try/catch, without delaying healthy ones. */
function fetchAjaxResults(paths, referer) {
    var results = [];
    if (typeof fetchAll !== "function") {
        for (var s = 0; s < paths.length; s++) {
            try { results.push(fetchAjax(paths[s], referer)); } catch (e) { results.push(null); }
        }
        return results;
    }

    var requests = [];
    for (var i = 0; i < paths.length; i++) requests.push(ajaxRequest(paths[i], referer));
    var responses;
    try {
        responses = fetchAll(requests);
    } catch (e) {
        for (var f = 0; f < paths.length; f++) {
            try { results.push(fetchAjax(paths[f], referer)); } catch (ignored) { results.push(null); }
        }
        return results;
    }
    for (var j = 0; j < paths.length; j++) {
        try { results.push(parseAjaxResponse(responses[j], paths[j])); } catch (error) { results.push(null); }
    }
    return results;
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
    return collectPaginated(fetchPage, wanted, LISTING_PAGE_SIZE);
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
        var serversToResolve = [];
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
                serversToResolve.push({ linkId: linkId, serverName: serverName, typeLabel: typeLabel });
            }
        }

        // The old implementation waited for two requests per server before starting the next
        // one. Resolve all opaque ids together, then probe all unique embed URLs together: three
        // network waves total regardless of how many mirrors the episode exposes.
        var resolvePaths = [];
        for (var p = 0; p < serversToResolve.length; p++) {
            resolvePaths.push("/ajax/server?get=" + encodeURIComponent(serversToResolve[p].linkId));
        }
        var resolvedServers = fetchAjaxResults(resolvePaths);
        var candidates = [];
        for (var c = 0; c < resolvedServers.length; c++) {
            var resolved = resolvedServers[c];
            var embedUrl = resolved && resolved.url ? String(resolved.url) : null;
            if (!embedUrl || seenUrls[embedUrl]) continue;
            seenUrls[embedUrl] = true;
            candidates.push({ url: embedUrl, server: serversToResolve[c] });
        }

        var candidateUrls = [];
        for (var u = 0; u < candidates.length; u++) candidateUrls.push(candidates[u].url);
        var reachability = getEmbedReachability(candidateUrls);
        for (var l = 0; l < candidates.length; l++) {
            if (!reachability[l]) continue;
            var candidate = candidates[l];
            links.push({
                url: candidate.url, type: "EMBED", quality: null, headers: referer,
                playerName: candidate.server.serverName + " (" + candidate.server.typeLabel + ")",
                translation: null, segments: [], videoId: null,
            });
        }
        return links;
    },
};
