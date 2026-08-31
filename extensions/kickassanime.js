// KickAssAnime scripted extension for Hibiki. Pure JSON API (kaa.lt) for the catalog. Ported from
// the compiled-in KickAssAnime/KickAssAnimeExtractor.
//
// Playback is returned as a raw EMBED link to the server's own page (krussdomi.com), not a
// resolved video URL, and deliberately so: krussdomi.com's video CDN sits behind bot protection
// that rejects any plain HTTP client (ExoPlayer's included) even with a full browser-shaped header
// set - confirmed directly against the CDN, a real browser passes and curl/OkHttp-shaped requests
// get a 403 from Cloudflare regardless of Referer/Origin/User-Agent. The manifest URL itself was
// trivially extractable from the page's inlined `{&quot;manifest&quot;:[0,&quot;...&quot;]}` JSON
// (the upstream Kotlin extractor's old AES+SHA1 signed-URL scheme is dead on the live site now),
// but that doesn't help - the block is on the video *segments*, not on discovering the manifest.
// So Hibiki's app-side krussdomi.com handling (see isWebViewOnlyLink/WebViewPlaybackScreen) skips
// ExoPlayer entirely and renders this page inside a real WebView instead, letting the site's own
// player and Chromium's network stack handle it end to end.

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

function title(fields) { return AnimeTitle(fields); }

function toAnimeTitle(obj) {
    var englishName = obj.title_en || null;
    var originalName = obj.title || englishName || obj.slug;
    return title({
        id: obj.slug,
        englishName: englishName,
        originalName: originalName,
        // title_original is dropped: kaa.lt's own API serves it mojibake-corrupted (verified via a
        // plain curl against the live API, not something this extension introduces) - unpaired
        // UTF-16 surrogates in the JSON make it unrecoverable without knowing their original
        // encoding pipeline, so showing it garbled would be worse than not showing it at all.
        japaneseName: null,
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
                    // Same mojibake-corruption problem as japaneseName above, but for per-episode
                    // native-language titles - dropped rather than shown garbled.
                    title: null,
                };
            });
            episodes.sort(function (a, b) { return a.number - b.number; });
            groups.push({ id: locale, title: localeName(locale), episodes: episodes, qualityLabel: null });
        }
        return groups;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var servers = apiGet("/" + titleId + "/episode/" + episodeId).servers || [];
        return servers.map(function (server) {
            return {
                url: server.src, type: "EMBED", quality: null,
                headers: { "Referer": BASE_URL + "/" },
                playerName: server.name || null, translation: null, segments: [], videoId: null,
            };
        });
    },
};
