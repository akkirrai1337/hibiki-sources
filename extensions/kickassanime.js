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

// A related title as the short card the detail page lists.
function toRelatedStub(obj) {
    var name = obj.title_en || obj.title;
    if (!obj.slug || !name) return null;
    return { id: obj.slug, title: name, posterUrl: posterUrl(obj.poster), type: obj.type || null, year: obj.year !== undefined ? obj.year : null, episodeCount: null, status: null };
}

// The site keeps a franchise's other entries behind their own request. Best effort: a title page must not
// fail for want of them.
function relatedOf(id) {
    try {
        var list = apiGet("/" + id + "/related");
        if (!Array.isArray(list)) return [];
        return list.map(toRelatedStub).filter(function (stub) { return stub !== null; });
    } catch (error) {
        return [];
    }
}

function apiGet(path) {
    var response = fetch(API_URL + path, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error("KickAssAnime returned HTTP " + response.status + " for " + path);
    return JSON.parse(S(response.body));
}

function fetchPage(query, sort, page, variant) {
    var encoded = encodeFilters(variant);
    if (query.length > 0) {
        var payload = { page: page, query: query };
        if (encoded) payload.filters = encoded;
        var response = fetch(BASE_URL + "/api/fsearch", {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error("KickAssAnime returned HTTP " + response.status);
        return JSON.parse(S(response.body)).result || [];
    }
    if (encoded) {
        var filtered = fetch(BASE_URL + "/api/anime?page=" + page + "&filters=" + encodeURIComponent(encoded), { headers: { "Accept": "application/json" } });
        if (!filtered.ok) throw new Error("KickAssAnime returned HTTP " + filtered.status);
        return JSON.parse(S(filtered.body)).result || [];
    }
    if (sort === "popular") return apiGet("/popular?page=" + page).result || [];
    if (sort === "trending") return apiGet("/trending?page=" + page).result || [];
    return (JSON.parse(S(fetch(BASE_URL + "/api/anime?page=" + page, { headers: { "Accept": "application/json" } }).body)).result) || [];
}

// kaa.lt paginates by its own fixed page size, not by the host's arbitrary offset/limit, so pages
// are fetched and concatenated until there's enough to satisfy the request before slicing.
function collectResults(query, sort, wanted, variants) {
    var results = [];
    for (var v = 0; v < variants.length && results.length < wanted; v++) {
        var page = 1;
        while (results.length < wanted && page <= 50) {
            var items = fetchPage(query, sort, page, variants[v]);
            if (items.length === 0) break;
            results = results.concat(items);
            page += 1;
        }
    }
    return results;
}


// Search filters are this source's own (declared in getSettings().filters); their picked values
// arrive as request.filters[id]. An unset filter is absent.
function picked(filters, id) {
    var v = filters && filters[id];
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return [v];
    return Array.isArray(v.include) ? v.include : [];
}
function dropped(filters, id) {
    var v = filters && filters[id];
    return v && Array.isArray(v.exclude) ? v.exclude : [];
}
function span(filters, id) {
    var v = filters && filters[id];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/* ---------------------------------------------------------------- filters -------------------- */

// The catalog API takes one `filters` argument: base64 of {"genres":[...],"year":N,"status":"...",
// "type":"..."} (checked against the live API - each key narrows /api/anime on its own). It has no
// endpoint listing the values, so the genre names are a fixed list; a name the site doesn't know
// simply matches nothing. `year` is a single year, so a range becomes one request per year.
var GENRE_NAMES = ["Action", "Adult Cast", "Adventure", "Anthropomorphic", "Avant Garde", "Award Winning", "Boys Love", "CGDCT", "Childcare", "Combat Sports", "Comedy", "Crossdressing", "Delinquents", "Detective", "Drama", "Ecchi", "Educational", "Erotica", "Fantasy", "Gag Humor", "Girls Love", "Gore", "Gourmet", "Harem", "High Stakes Game", "Historical", "Horror", "Idols (Female)", "Idols (Male)", "Isekai", "Iyashikei", "Josei", "Kids", "Love Polygon", "Magical Sex Shift", "Mahou Shoujo", "Martial Arts", "Mecha", "Medical", "Military", "Music", "Mystery", "Mythology", "Organized Crime", "Otaku Culture", "Parody", "Performing Arts", "Pets", "Psychological", "Racing", "Reincarnation", "Reverse Harem", "Romance", "Romantic Subtext", "Samurai", "School", "Sci-Fi", "Seinen", "Shoujo", "Shounen", "Showbiz", "Slice of Life", "Space", "Sports", "Strategy Game", "Super Power", "Supernatural", "Survival", "Suspense", "Team Sports", "Time Travel", "Urban Fantasy", "Vampire", "Video Game", "Villainess", "Visual Arts", "Workplace"];
var MAX_FILTER_YEARS = 6;

function siteFilters() {
    return [
        { id: "genres", title: "Genres", type: "multi", options: GENRE_NAMES.map(function (name) { return { id: name, title: name }; }) },
        { id: "type", title: "Type", type: "select", options: [
            { id: "tv", title: "TV" }, { id: "movie", title: "Movie" }, { id: "ona", title: "ONA" },
            { id: "ova", title: "OVA" }, { id: "special", title: "Special" }, { id: "tv_special", title: "TV Special" },
        ] },
        { id: "status", title: "Status", type: "select", options: [{ id: "finished", title: "Finished Airing" }, { id: "airing", title: "Currently Airing" }] },
        { id: "year", title: "Year", type: "range", min: 1967, max: new Date().getFullYear() },
    ];
}

/** One filter object per year asked for (or a single one), in the API's own shape. */
function filterVariants(filters) {
    var base = {};
    var genres = picked(filters, "genres");
    if (genres.length) base.genres = genres;
    var type = picked(filters, "type")[0];
    if (type) base.type = type;
    var status = picked(filters, "status")[0];
    if (status) base.status = status;
    var year = span(filters, "year");
    if (!year.from && !year.to) return Object.keys(base).length ? [base] : [null];
    var to = year.to || year.from;
    var from = Math.max(year.from || year.to, to - MAX_FILTER_YEARS + 1);
    var variants = [];
    for (var y = to; y >= from; y--) {
        var variant = {};
        for (var key in base) variant[key] = base[key];
        variant.year = y;
        variants.push(variant);
    }
    return variants;
}

function encodeFilters(variant) { return variant ? Base64.encode(JSON.stringify(variant)) : ""; }

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var offset = Math.max(request.offset || 0, 0);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var query = (request.query || "").trim();
        var sort = request.sort || "default";

        var results = collectResults(query, sort, offset + limit, filterVariants(request.filters));
        return results.slice(offset, offset + limit).map(toAnimeTitle);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        var results = apiGet("/recent?type=all&page=1").result || [];
        return results.map(toAnimeTitle).slice(0, safeLimit);
    },

    getById: function (id) {
        var result = toAnimeTitle(apiGet("/" + id));
        var related = relatedOf(id);
        result.franchiseAnime = related;
        result.relatedAnime = related;
        return result;
    },

    getSettings: function () {
        return { sortOptions: [{ id: "default", title: "Catalog" }, { id: "popular", title: "Most popular" }, { id: "trending", title: "Trending" }], filters: siteFilters() };
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
