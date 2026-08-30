// KickAssAnime scripted extension for Hibiki. Pure JSON API (kaa.lt), Jsoup only needed to strip
// HTML-entity-encoded JSON out of the player pages. Ported from the compiled-in
// KickAssAnime/KickAssAnimeExtractor.
//
// The upstream Kotlin extractor still carries an old AES+SHA1 signed-URL scheme for its
// VidStreaming/DuckStream/BirdStream servers (per-server hardcoded keys, HMAC-style signature over
// IP/UA/route/timestamp). Checking the live site (2026-08) shows every server now renders through a
// single unified Astro player component that inlines the real manifest URL directly into the HTML
// as an HTML-entity-encoded JSON blob (`{&quot;manifest&quot;:[0,&quot;https://...m3u8&quot;],...}`)
// - the old crypto path is dead on the current site, so this port skips it entirely and just
// regexes the manifest out. Rhino has no AES/SHA1 available anyway (java/Packages are stripped from
// scope), so this simplification also avoids needing a pure-JS crypto implementation.
//
// Only HLS manifests are usable: the host's PlayerType has no DASH variant, so DASH-only servers
// (BirdStream, seen as "type=dash" in its server url) are silently skipped.

function S(value) { return value === null || value === undefined ? null : String(value); }

var BASE_URL = "https://kaa.lt";
var API_URL = BASE_URL + "/api/show";
var MAX_RESULTS = 50;

var LOCALE_NAMES = {
    "ja-JP": "Japanese", "en-US": "English", "es-ES": "Spanish", "es-419": "Spanish (Latin America)",
    "ko-KR": "Korean", "zh-CN": "Chinese",
};

function localeName(locale) { return LOCALE_NAMES[locale] || locale; }

function statusOf(value) {
    switch (String(value || "")) {
        case "finished_airing": return "released";
        case "currently_airing": return "ongoing";
        default: return null;
    }
}

function posterUrl(image) {
    if (!image || !image.hq) return null;
    return BASE_URL + "/image/poster/" + image.hq + ".jpg";
}

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

function toAnimeTitle(obj) {
    var englishName = obj.title_en || null;
    var originalName = obj.title || englishName || obj.slug;
    return title({
        id: obj.slug,
        englishName: englishName,
        originalName: originalName,
        japaneseName: obj.title_original || null,
        year: obj.year !== undefined ? obj.year : null,
        type: obj.type || null,
        episodeCount: obj.episode_count || null,
        posterUrl: posterUrl(obj.poster),
        status: statusOf(obj.status),
        description: obj.synopsis || null,
        genres: obj.genres || [],
        ageRating: obj.rating || null,
    });
}

function apiGet(path) {
    var response = fetch(API_URL + path, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error("KickAssAnime returned HTTP " + response.status + " for " + path);
    return JSON.parse(S(response.body));
}

function fetchPage(query, sort, page) {
    if (query.length > 0) {
        var response = fetch(BASE_URL + "/api/fsearch", {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ page: page, query: query }),
        });
        if (!response.ok) throw new Error("KickAssAnime returned HTTP " + response.status);
        return JSON.parse(S(response.body)).result || [];
    }
    if (sort === "RATING") return apiGet("/trending?page=" + page).result || [];
    return (JSON.parse(S(fetch(BASE_URL + "/api/anime?page=" + page, { headers: { "Accept": "application/json" } }).body)).result) || [];
}

// kaa.lt paginates by its own fixed page size, not by the host's arbitrary offset/limit, so pages
// are fetched and concatenated until there's enough to satisfy the request before slicing.
function collectResults(query, sort, wanted) {
    var results = [];
    var page = 1;
    while (results.length < wanted && page <= 50) {
        var items = fetchPage(query, sort, page);
        if (items.length === 0) break;
        results = results.concat(items);
        page += 1;
    }
    return results;
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var offset = Math.max(request.offset || 0, 0);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var query = (request.query || "").trim();
        var sort = request.sort || "RELEVANCE";

        var results = collectResults(query, sort, offset + limit);
        return results.slice(offset, offset + limit).map(toAnimeTitle);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        var results = apiGet("/recent?type=all&page=1").result || [];
        return results.map(toAnimeTitle).slice(0, safeLimit);
    },

    getById: function (id) {
        return toAnimeTitle(apiGet("/" + id));
    },

    getSettings: function () {
        return { sortOptions: [{ id: "relevance", title: "Relevance" }, { id: "rating", title: "Trending" }] };
    },

    getPlaybackGroups: function (titleId) {
        var locales = apiGet("/" + titleId + "/language").result || [];
        var groups = [];
        for (var i = 0; i < locales.length; i++) {
            var locale = locales[i];
            var firstPage = apiGet("/" + titleId + "/episodes?page=1&lang=" + encodeURIComponent(locale));
            var items = (firstPage.result || []).slice();
            var pageCount = (firstPage.pages || []).length;
            for (var p = 2; p <= pageCount; p++) {
                var nextPage = apiGet("/" + titleId + "/episodes?page=" + p + "&lang=" + encodeURIComponent(locale));
                items = items.concat(nextPage.result || []);
            }
            if (items.length === 0) continue;

            var episodes = items.map(function (item) {
                return {
                    id: "ep-" + item.episode_string + "-" + item.slug,
                    number: parseFloat(item.episode_string) || 0,
                    title: item.title || null,
                };
            });
            episodes.sort(function (a, b) { return a.number - b.number; });
            groups.push({ id: locale, title: localeName(locale), episodes: episodes, qualityLabel: null });
        }
        return groups;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var servers = apiGet("/" + titleId + "/episode/" + episodeId).servers || [];
        var links = [];
        for (var i = 0; i < servers.length; i++) {
            var server = servers[i];
            var response = fetch(server.src, {
                headers: {
                    "Accept": "text/html",
                    "Referer": BASE_URL + "/",
                    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
                },
            });
            if (!response.ok) continue;

            var html = S(response.body).split("&quot;").join("\"");
            var match = /manifest":\s*\[0,\s*"([^"]+)"]/.exec(html);
            if (match === null) continue;

            var manifestUrl = match[1].replace(/^(https?:)\/+/, "$1//");
            if (manifestUrl.indexOf(".m3u8") < 0) continue; // DASH-only servers aren't playable (no DASH PlayerType)

            links.push({
                url: manifestUrl, type: "DIRECT_HLS", quality: null,
                headers: { "Referer": BASE_URL + "/" },
                playerName: server.name || null, translation: null, segments: [], videoId: null,
            });
        }
        return links;
    },
};
