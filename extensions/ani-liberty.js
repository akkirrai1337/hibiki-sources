// AniLiberty scripted extension for Hibiki. Pure JSON API (anilibria.top), no Jsoup needed.
// Ported from the compiled-in AniLibertyCatalogClient/AniLibertyPlaybackClient.
//
// Simplification vs. the original Kotlin: the Kotlin version resolved playback by re-searching
// AniLiberty's own catalog by title name via a generic cross-provider TitleMatcher, even though
// catalog and playback hit the exact same site/API. The catalog id it returns (`release.id`) is
// already a valid `/anime/releases/{id}` path segment, so this port skips the redundant
// name-matching search entirely and uses the title id directly - confirmed against the existing
// fixtures (a catalog entry with id "987654" is playable at /anime/releases/987654 unchanged).

var MIRROR_URLS = ["https://anilibria.top/api/v1", "https://api.anilibria.app/api/v1"];
var PUBLIC_SITE_URL = "https://anilibria.top";

function mirrorRequest(path, params) {
    var query = "";
    if (params) {
        var parts = [];
        for (var key in params) {
            if (params[key] === null || params[key] === undefined) continue;
            parts.push(key + "=" + encodeURIComponent(String(params[key])));
        }
        if (parts.length > 0) query = "?" + parts.join("&");
    }
    var lastError = null;
    for (var i = 0; i < MIRROR_URLS.length; i++) {
        try {
            var response = fetch(MIRROR_URLS[i] + path + query, { headers: { "Accept": "application/json" } });
            if (response.ok) return JSON.parse(S(response.body));
            lastError = new Error("AniLiberty returned HTTP " + response.status);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error("AniLiberty is unavailable");
}

function S(value) {
    return value === null || value === undefined ? null : String(value);
}

function releaseArray(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === "object") return json.data || json.items || json.response || [];
    return [];
}

function releaseObject(json) {
    if (json && typeof json === "object" && json.data && typeof json.data === "object" && !Array.isArray(json.data)) return json.data;
    return json;
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

function seasonFromValue(value) {
    switch (String(value || "").toLowerCase()) {
        case "winter": return 1;
        case "spring": return 2;
        case "summer": return 3;
        case "autumn": return 4;
        default: return null;
    }
}

function toTitle(value) {
    if (!value) return null;
    var id = value.id !== undefined && value.id !== null ? String(value.id) : (value.alias || null);
    if (!id || !value.name || !value.name.main) return null;
    var poster = value.poster;
    var posterPath = poster ? ((poster.optimized && poster.optimized.src) || poster.src) : null;
    var episodes = Array.isArray(value.episodes) ? value.episodes.length : 0;
    var availableEpisodeCount = episodes > 0 ? episodes : null;
    var alt = (value.name.alternative || "").split(/[,;\n]/).map(function (n) { return n.trim(); }).filter(function (n) { return n.length > 0; });
    var genres = Array.isArray(value.genres) ? value.genres.map(function (g) { return g && (g.name || g.description); }).filter(Boolean) : [];
    return title({
        id: id,
        russianName: value.name.main,
        englishName: value.name.english || null,
        originalName: value.name.english || value.name.main,
        synonyms: alt,
        year: value.year !== undefined ? value.year : null,
        type: value.type ? value.type.value : null,
        episodeCount: value.episodes_total !== undefined ? value.episodes_total : availableEpisodeCount,
        posterUrl: posterPath ? Jsoup.resolve(PUBLIC_SITE_URL, posterPath) : null,
        status: value.is_ongoing === true ? "ongoing" : (value.is_ongoing === false ? "released" : null),
        description: value.description || null,
        genres: genres,
        ageRating: value.age_rating ? value.age_rating.label : null,
        season: value.season ? seasonFromValue(value.season.value) : null,
        availableEpisodeCount: availableEpisodeCount,
    });
}

function toAniLibertySorting(sort) {
    switch (sort) {
        case "RELEVANCE": return "FRESH_AT_DESC";
        case "RATING": return "RATING_DESC";
        case "YEAR": return "YEAR_DESC";
        default: throw new Error("AniLiberty does not support this sort");
    }
}

function csv(list, uppercase) {
    if (!list || list.length === 0) return null;
    var cleaned = [];
    for (var i = 0; i < list.length; i++) {
        var value = String(list[i]).trim();
        if (value.length === 0) continue;
        cleaned.push(uppercase ? value.toUpperCase() : value);
    }
    return cleaned.length > 0 ? cleaned.join(",") : null;
}

function referenceOptions(path) {
    var json = mirrorRequest(path, null);
    var items = releaseArray(json);
    var options = [];
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var id = item.id !== undefined ? String(item.id) : (item.value || "");
        var label = item.name || item.description || id;
        options.push({ id: id, title: label });
    }
    return options;
}

function playbackVideoSegments(episode) {
    var segments = [];
    var duration = episode.duration || null;
    addSegment(segments, episode.opening, "OPENING", duration);
    addSegment(segments, episode.ending, "ENDING", duration);
    return segments;
}

function addSegment(segments, timecode, type, durationSeconds) {
    if (!timecode || timecode.start === undefined || timecode.stop === undefined) return;
    var start = Math.max(timecode.start, 0);
    var end = timecode.stop;
    if (durationSeconds && durationSeconds > 0) end = Math.min(end, durationSeconds);
    if (end <= start) return;
    segments.push({ type: type, startMs: start * 1000, endMs: end * 1000 });
}

function hlsLink(url, quality, segments) {
    if (!url) return null;
    var normalized = url;
    if (normalized.indexOf("//") === 0) normalized = "https:" + normalized;
    else if (normalized.indexOf("://") < 0) normalized = "https://" + normalized;
    return {
        url: normalized, type: "DIRECT_HLS", quality: quality,
        headers: { "Referer": PUBLIC_SITE_URL + "/" },
        playerName: "AniLiberty", translation: "AniLiberty", segments: segments, videoId: null,
    };
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var limit = Math.min(Math.max(request.limit || 20, 1), 50);
        var page = Math.floor(Math.max(request.offset || 0, 0) / limit) + 1;
        var params = { page: page, limit: limit };
        if (request.query && request.query.trim().length > 0) params["f[search]"] = request.query.trim();
        var types = csv(request.typeAliases, true);
        if (types) params["f[types]"] = types;
        var statuses = csv(request.statusAliases, true);
        if (statuses) params["f[publish_statuses]"] = statuses;
        var genres = csv(request.includedGenreAliases, false);
        if (genres) params["f[genres]"] = genres;
        if (request.yearFrom) params["f[years][from_year]"] = request.yearFrom;
        if (request.yearTo) params["f[years][to_year]"] = request.yearTo;
        params["f[sorting]"] = toAniLibertySorting(request.sort || "RELEVANCE");

        var json = mirrorRequest("/anime/catalog/releases", params);
        var items = releaseArray(json);
        var results = [];
        for (var i = 0; i < items.length; i++) {
            var t = toTitle(items[i]);
            if (t !== null) results.push(t);
        }
        return results;
    },

    latest: function (limit) {
        var json = mirrorRequest("/anime/releases/latest", { limit: Math.min(Math.max(limit || 20, 1), 50) });
        var items = releaseArray(json);
        var results = [];
        for (var i = 0; i < items.length; i++) {
            var t = toTitle(items[i]);
            if (t !== null) results.push(t);
        }
        return results;
    },

    getById: function (id) {
        var releaseId = String(id).trim();
        if (releaseId.length === 0) throw new Error("AniLiberty release id is blank");
        var json = mirrorRequest("/anime/releases/" + releaseId, null);
        var t = toTitle(releaseObject(json));
        if (t === null) throw new Error("AniLiberty returned an invalid release: " + id);
        return t;
    },

    getSettings: function () {
        return {
            sortOptions: [
                { id: "relevance", title: "Relevance" },
                { id: "rating", title: "Rating" },
                { id: "year", title: "Year" },
            ],
            typeOptions: referenceOptions("/anime/catalog/references/types"),
            statusOptions: referenceOptions("/anime/catalog/references/publish-statuses"),
            genreOptions: referenceOptions("/anime/catalog/references/genres"),
        };
    },

    getPlaybackGroups: function (titleId) {
        var json = mirrorRequest("/anime/releases/" + titleId, null);
        var release = releaseObject(json);
        var rawEpisodes = (release && release.episodes) || [];
        var episodes = [];
        var seen = {};
        for (var i = 0; i < rawEpisodes.length; i++) {
            var e = rawEpisodes[i];
            if (!e.id || seen[e.id] || !(e.ordinal > 0)) continue;
            seen[e.id] = true;
            episodes.push({ id: e.id, number: e.ordinal, title: e.name || null });
        }
        episodes.sort(function (a, b) { return a.number - b.number; });
        if (episodes.length === 0) return [];
        return [{ id: titleId, title: "AniLiberty", episodes: episodes, qualityLabel: "HLS" }];
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var json = mirrorRequest("/anime/releases/" + titleId, null);
        var release = releaseObject(json);
        var rawEpisodes = (release && release.episodes) || [];
        var episode = null;
        for (var i = 0; i < rawEpisodes.length; i++) {
            if (rawEpisodes[i].id === episodeId) { episode = rawEpisodes[i]; break; }
        }
        if (episode === null) throw new Error("AniLiberty could not find this episode");
        var segments = playbackVideoSegments(episode);
        var links = [];
        var candidates = [
            [episode.hls_1080, "1080p"], [episode.hls_720, "720p"], [episode.hls_480, "480p"],
            [episode.hls_360, "360p"], [episode.hls_240, "240p"],
        ];
        var seenUrls = {};
        for (var c = 0; c < candidates.length; c++) {
            var link = hlsLink(candidates[c][0], candidates[c][1], segments);
            if (link !== null && !seenUrls[link.url]) { seenUrls[link.url] = true; links.push(link); }
        }
        return links;
    },
};
