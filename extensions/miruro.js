// Miruro scripted extension for Hibiki. Catalog metadata is a thin proxy over AniList's own GraphQL
// schema (title/coverImage/studios/relations/characters all pass straight through in AniList's own
// shape). Playback is a meta-aggregator: Miruro's own backend resolves streams from several
// upstream providers on our behalf (AllAnime, AnimePahe, the AniKoto/KuAnime engine Anichi already
// covers, AnimeDao, ...) - so one episode can come back with several independent provider options,
// several of which are ALREADY fully-resolved direct HLS/MP4 CDN links (no embed/WebView needed).
//
// Responses carry a light "x-obfuscated: 2" scrambling: base64url -> XOR with a fixed key -> gzip.
// This is NOT real encryption - the XOR key ships in plaintext to every visitor at /env2.js
// (`VITE_PIPE_OBF_KEY`), just a speed bump against naive scrapers, so it's reproduced verbatim here
// rather than treated as a secret worth protecting.
//
// /api/secure/pipe is gated by Cloudflare bot-management that binds the block to the exact client
// fingerprint (TLS/JA3), not just a missing cookie - confirmed live: a plain fetch() gets a genuine
// 403 even from a real device's own IP, and routing it through challenge() (which harvests cookies
// via a WebView, then replays them through this runtime's own HTTP client) still 403s, because the
// replaying client's TLS fingerprint never matches the WebView's. browserFetch() instead performs
// the actual request from inside the WebView's own JS/network context - a genuine same-stack
// request, not a replay - so it earns and uses the pass together, atomically.

function S(value) { return value === null || value === undefined ? null : String(value); }

var BASE_URL = "https://www.miruro.to";
var OBFUSCATION_KEY_HEX = "71951034f8fbcf53d89db52ceb3dc22c";
var MAX_RESULTS = 50;

var PROVIDER_NAMES = {
    ally: "AllAnime",
    pewe: "AnimeDB",
    bee: "AniKoto",
    kiwi: "AnimePahe",
    hop: "KickAssAnime",
    bonk: "AnimeDao",
    moo: "AnimeGG",
};

/** Rhino has no TextEncoder; this is the classic encodeURIComponent trick (same one Miruro's own
 * client JS uses) to turn a native UTF-16 JS string into a "one byte per char code" byte-string. */
function utf8Encode(str) {
    return encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (match, hex) {
        return String.fromCharCode(parseInt(hex, 16));
    });
}

function base64UrlEncode(value) {
    var byteString = utf8Encode(JSON.stringify(value));
    return Base64.encode(byteString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function xorBytes(byteString, keyHex) {
    var key = [];
    for (var i = 0; i < keyHex.length; i += 2) key.push(parseInt(keyHex.substr(i, 2), 16));
    var out = "";
    for (var j = 0; j < byteString.length; j++) out += String.fromCharCode(byteString.charCodeAt(j) ^ key[j % key.length]);
    return out;
}

function decodePipeResponse(response) {
    var body = S(response.body);
    var obfuscated = response.headers ? response.headers["x-obfuscated"] : null;
    if (!obfuscated) return JSON.parse(body);

    var standardBase64 = body.replace(/-/g, "+").replace(/_/g, "/");
    var raw = Base64.decode(standardBase64);
    if (obfuscated === "2") raw = xorBytes(raw, OBFUSCATION_KEY_HEX);
    // Gzip magic bytes (0x1f 0x8b) - the client only inflates when the obfuscated payload actually
    // carries a compressed body, same check Miruro's own JS makes.
    if (raw.charCodeAt(0) === 31 && raw.charCodeAt(1) === 139) return JSON.parse(Gzip.inflate(raw));
    return JSON.parse(raw);
}

function pipeGet(path, query) {
    var e = base64UrlEncode({ path: path, method: "GET", query: query || {}, body: null, version: "0.2.0" });
    var url = BASE_URL + "/api/secure/pipe?e=" + e;
    var response = browserFetch(BASE_URL + "/", url, {
        headers: { "Accept": "text/plain, application/json, */*" },
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error("Miruro returned HTTP " + response.status + " for " + path);
    }
    return decodePipeResponse(response);
}

/** Fills in every AnimeTitle field so the Kotlin-side JSON decode always sees a complete object. */
function title(fields) { return AnimeTitle(fields); }

function stripHtml(html) {
    if (!html) return null;
    var text = S(Jsoup.parseBodyFragment(html).text()).trim();
    return text.length > 0 ? text : null;
}

function toType(format) {
    return format ? String(format).toLowerCase() : null;
}

function toStatus(status) {
    switch (String(status || "").toUpperCase()) {
        case "RELEASING": return "ongoing";
        case "FINISHED": return "released";
        case "NOT_YET_RELEASED": return "announcement";
        case "CANCELLED": return "released";
        case "HIATUS": return "ongoing";
        default: return null;
    }
}

function bestTitleName(titleObj) {
    return (titleObj && (titleObj.english || titleObj.romaji || titleObj.native || titleObj.userPreferred)) || null;
}

function edgeNodes(connection) {
    return connection && Array.isArray(connection.edges) ? connection.edges : [];
}

function toRelatedAnimeTitle(edge) {
    var node = edge.node;
    if (!node) return null;
    return {
        id: String(node.id),
        title: bestTitleName(node.title) || String(node.id),
        posterUrl: node.coverImage ? (node.coverImage.large || node.coverImage.extraLarge || node.coverImage.medium) : null,
        type: toType(node.format),
        year: null,
        episodeCount: node.episodes !== undefined ? node.episodes : null,
        status: toStatus(node.status),
    };
}

function toCharacterTitle(edge) {
    var node = edge.node;
    if (!node) return null;
    var name = node.name ? (node.name.full || node.name.userPreferred || node.name.native) : null;
    if (!name) return null;
    return { id: String(node.id), title: name, posterUrl: node.image ? (node.image.large || node.image.medium) : null };
}

function toAnimeTitle(media) {
    var names = media.title || {};
    var originalName = names.native || names.romaji || names.english || names.userPreferred || String(media.id);
    var studioNames = edgeNodes(media.studios).map(function (edge) { return edge.node ? edge.node.name : null; }).filter(function (n) { return !!n; });
    var ratings = [];
    if (media.averageScore) ratings.push({ source: "AniList", value: media.averageScore / 10, votes: media.popularity || null });

    return title({
        id: String(media.id),
        englishName: names.english || null,
        originalName: originalName,
        japaneseName: names.native || null,
        synonyms: Array.isArray(media.synonyms) ? media.synonyms : [],
        year: media.seasonYear || (media.startDate ? media.startDate.year : null) || null,
        type: toType(media.format),
        episodeCount: media.episodes !== undefined ? media.episodes : null,
        posterUrl: media.coverImage ? (media.coverImage.large || media.coverImage.extraLarge || media.coverImage.medium) : null,
        status: toStatus(media.status),
        description: stripHtml(media.description),
        nextEpisodeAt: media.nextAiringEpisode ? media.nextAiringEpisode.airingAt : null,
        genres: Array.isArray(media.genres) ? media.genres : [],
        ratings: ratings,
        viewCount: media.popularity !== undefined ? media.popularity : null,
        trailer: media.trailer ? { id: media.trailer.id, site: media.trailer.site || "youtube", thumbnailUrl: media.trailer.thumbnail || null, sourceUrl: null } : null,
        studios: studioNames,
        mainCharacters: edgeNodes(media.characters).map(toCharacterTitle).filter(function (c) { return c !== null; }).slice(0, 12),
        relatedAnime: edgeNodes(media.relations).map(toRelatedAnimeTitle).filter(function (r) { return r !== null; }),
        similarAnime: (Array.isArray(media.recommendations) ? media.recommendations : [])
            .map(function (r) { return r.node ? toRelatedAnimeTitle({ node: r.node }) : null; })
            .filter(function (r) { return r !== null; }),
        season: media.seasonYear || null,
    });
}

function sortForBrowse(sort, hasQuery) {
    switch (sort) {
        case "RATING": return "SCORE_DESC";
        case "TITLE": return "TITLE_ROMAJI";
        case "YEAR": return "START_DATE_DESC";
        case "VOTES": return "POPULARITY_DESC";
        case "VIEWS": return "POPULARITY_DESC";
        default: return hasQuery ? null : "TRENDING_DESC";
    }
}

/** perPage above 50 502s (the server enforces AniList's own real max), so an arbitrary [offset,
 * offset+limit) window can't always be read from a single page - fetches however many consecutive
 * pages of MAX_RESULTS actually cover it (almost always 1, occasionally 2 when the window straddles
 * a page boundary) and slices the concatenated result down to exactly what was asked for. */
function fetchBrowseWindow(baseQuery, offset, limit) {
    var startPage = Math.floor(offset / MAX_RESULTS) + 1;
    var endPage = Math.floor((offset + limit - 1) / MAX_RESULTS) + 1;
    var items = [];
    for (var page = startPage; page <= endPage; page++) {
        var query = {};
        for (var key in baseQuery) query[key] = baseQuery[key];
        query.page = page;
        query.perPage = MAX_RESULTS;
        var pageItems = pipeGet("search/browse", query);
        items = items.concat(pageItems);
        if (pageItems.length < MAX_RESULTS) break;
    }
    var localOffset = offset - (startPage - 1) * MAX_RESULTS;
    return items.slice(localOffset, localOffset + limit);
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var offset = Math.max(request.offset || 0, 0);
        var query = (request.query || "").trim();

        var mediaList;
        if (query.length > 0) {
            var searchQuery = { q: query, limit: limit, offset: offset };
            var sort = sortForBrowse(request.sort, true);
            if (sort) searchQuery.sort = sort;
            mediaList = pipeGet("search", searchQuery);
        } else {
            var browseQuery = { type: "ANIME", sort: sortForBrowse(request.sort, false) };
            if (request.typeAliases && request.typeAliases.length > 0) browseQuery.format = request.typeAliases[0];
            if (request.statusAliases && request.statusAliases.length > 0) browseQuery.status = request.statusAliases[0];
            if (request.includedGenreAliases && request.includedGenreAliases.length > 0) browseQuery.genre_in = request.includedGenreAliases;
            if (request.excludedGenreAliases && request.excludedGenreAliases.length > 0) browseQuery.genre_not_in = request.excludedGenreAliases;
            if (request.yearFrom) browseQuery.startDate_greater = request.yearFrom * 10000;
            if (request.yearTo) browseQuery.startDate_lesser = (request.yearTo + 1) * 10000;
            mediaList = fetchBrowseWindow(browseQuery, offset, limit);
        }
        return mediaList.map(toAnimeTitle);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        var mediaList = pipeGet("search/browse", { type: "ANIME", status: "RELEASING", sort: "TRENDING_DESC", page: 1, perPage: safeLimit });
        return mediaList.map(toAnimeTitle);
    },

    getSettings: function () {
        return {
            sortOptions: [
                { id: "RELEVANCE", title: "Relevance" },
                { id: "RATING", title: "Rating" },
                { id: "TITLE", title: "Title" },
                { id: "YEAR", title: "Year" },
                { id: "VOTES", title: "Popularity" },
            ],
            typeOptions: [
                { id: "TV", title: "TV" },
                { id: "MOVIE", title: "Movie" },
                { id: "OVA", title: "OVA" },
                { id: "ONA", title: "ONA" },
                { id: "SPECIAL", title: "Special" },
            ],
            statusOptions: [
                { id: "RELEASING", title: "Airing" },
                { id: "FINISHED", title: "Finished" },
                { id: "NOT_YET_RELEASED", title: "Not yet aired" },
            ],
        };
    },

    getById: function (id) {
        var response = pipeGet("info/" + id, {});
        if (!response || !response.media) throw new Error("Miruro title was not found: " + id);
        return toAnimeTitle(response.media);
    },

    getPlaybackGroups: function (titleId) {
        var response = pipeGet("episodes", { anilistId: titleId });
        var providers = response.providers || {};
        var groups = [];
        for (var providerId in providers) {
            var providerEpisodes = providers[providerId].episodes || {};
            for (var category in providerEpisodes) {
                var list = providerEpisodes[category];
                if (!list || list.length === 0) continue;
                var episodes = list.map(function (ep) { return { id: ep.id, number: ep.number, title: ep.title || null }; });
                episodes.sort(function (a, b) { return a.number - b.number; });
                var providerName = PROVIDER_NAMES[providerId] || providerId;
                var categoryLabel = category === "dub" ? "Dub" : "Sub";
                groups.push({ id: providerId + ":" + category, title: providerName + " (" + categoryLabel + ")", episodes: episodes, qualityLabel: null });
            }
        }
        return groups;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var parts = String(groupId).split(":");
        var providerId = parts[0];
        var category = parts[1] || "sub";
        var response = pipeGet("sources", { episodeId: episodeId, provider: providerId, category: category, anilistId: titleId });
        var streams = response.streams || [];
        var translation = category === "dub" ? "Dub" : "Sub";

        return streams.map(function (stream) {
            var type = stream.type === "hls" ? "DIRECT_HLS" : (stream.type === "mp4" ? "DIRECT_MP4" : "EMBED");
            return {
                url: stream.url,
                type: type,
                quality: stream.quality || null,
                headers: { "Referer": stream.referer || (BASE_URL + "/") },
                playerName: stream.server || (PROVIDER_NAMES[providerId] || providerId),
                translation: translation,
                segments: [],
                videoId: null,
            };
        });
    },
};
