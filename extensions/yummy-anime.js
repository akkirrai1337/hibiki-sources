// YummyAnime scripted extension for Hibiki. Pure JSON API (api.yani.tv), no Jsoup needed.
// Ported from the compiled-in YummyCatalogClient/YummyPlaybackClient.
//
// Simplification vs. the original Kotlin: playback (`getDubbingCatalog`/`getPlayerLinks`) used
// title.id directly as the API's own anime id (mediaId = id), same as the catalog - so, like the
// AniLiberty port, this skips the redundant cross-provider TitleMatcher re-search entirely.
//
// The application_token is a non-secret constant already baked into the host app before this
// port (see AnimeSourceRegistry's old DEFAULT_YUMMY_APPLICATION_TOKEN) - required for stable API
// access, not a per-user credential.

var BASE_URL = "https://api.yani.tv";
var APPLICATION_TOKEN = "wawegr8j13it4rdw";

var FALLBACK_SORT_ALIASES = ["top", "title", "year", "votes", "views", "comments"];
var FALLBACK_TYPE_ALIASES = ["tv", "movie", "short_movie", "ova", "special", "short_serial", "ona"];
var FALLBACK_STATUS_ALIASES = ["released", "ongoing", "announcement"];
var FALLBACK_GENRE_ALIASES = [
    "bisenen", "dzesej", "maho-sedze", "sedze", "sedze-aj", "senen", "senen-aj", "sejnen",
    "etti", "vestern", "detektiv", "drama", "komediya", "parodiya", "prestupnyj-mir",
    "vori", "mafiya-yakudza", "ohotniki-za-golovami", "piraty", "terroristy", "ubijcy",
    "meha", "androidy", "pilotiruemye-roboty", "silovye-kostyumy", "ii", "transformery",
    "mistika", "priklyucheniya", "romantika", "lyubovnyj-treugol-nik", "triller", "uzhasy",
    "fantastika", "inoplanetyane", "kiborgi", "kosmicheskie-priklyucheniya",
    "puteshestviya-vo-vremeni", "fentezi", "al-ternativnaya-real-nost", "angely", "bogi",
    "vampiry", "ved-my", "demony", "drakony", "zombi", "magiya", "prizraki", "rysalki",
    "sovremennoe-fentezi", "sukkuby", "temnoe-fentezi", "temnye-el-fy", "fei",
    "celyj-fentezi-mir", "el-fy", "virtual-naya-real-nost", "parallel-nyj-mir", "ekshen",
    "boevye-iskusstva", "nindzya", "perestrelki", "proksi-boi", "samurai",
    "srazheniya-na-mechah", "supersposobnosti", "al-ternativnaya-istoriya", "antivojna",
    "antiutopiya", "vojna", "voennaya-tematika", "garem", "iskusstvo", "muzyka",
    "istoricheskij", "kiberpank", "kulinariya", "lolikon", "nelinejnyj-syuzhet",
    "povsednevnost", "politika", "policejskie", "postapokaliptika", "rossiya-v-anime",
    "sport", "basketbol", "stimpank", "tajnyj-zagovor", "shkola", "garem-dlya-devochek",
    "lyudi-zveri", "psihologiya", "manga", "erotica", "ne-yaponskoe", "trap",
    "sverh-estestvennoe", "igry", "isekai", "chinese3d", "motorcycles", "badguys", "bezumie",
];

function S(value) { return value === null || value === undefined ? null : String(value); }

function requestLanguage() {
    var lang = String(preferredLanguage || "ru").trim().toLowerCase();
    return (lang === "en" || lang === "eng" || lang === "english") ? "en" : "ru";
}

function get(path, params) {
    var query = "";
    if (params) {
        var parts = [];
        for (var key in params) {
            if (params[key] === null || params[key] === undefined) continue;
            parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])));
        }
        if (parts.length > 0) query = "?" + parts.join("&");
    }
    var response = fetch(BASE_URL + path + query, {
        headers: { "Lang": requestLanguage(), "X-Application": APPLICATION_TOKEN },
    });
    if (!response.ok) throw new Error("YummyAnime returned HTTP " + response.status);
    return JSON.parse(S(response.body)).response;
}

function normalize(value) {
    if (value === null || value === undefined) return null;
    var trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrl(value) {
    var normalized = normalize(value);
    if (normalized === null) return null;
    return normalized.indexOf("//") === 0 ? "https:" + normalized : normalized;
}

function hasCyrillic(value) {
    return /[Ѐ-ӿ]/.test(value);
}

function isReleasedStatus(value) {
    switch (String(value || "").trim().toLowerCase()) {
        case "released": case "completed": case "вышел": case "завершён": case "завершен": case "вийшов":
            return true;
        default:
            return false;
    }
}

function bestImageUrl(image) {
    if (!image) return null;
    var candidates = [image.fullsize, image.mega, image.huge, image.big, image.medium, image.small, image.original, image.preview, image.thumbnail, image.url];
    for (var i = 0; i < candidates.length; i++) {
        var url = normalizeUrl(candidates[i]);
        if (url !== null) return url;
    }
    return null;
}

function extractEpisodeCount(episodes, preferTotal) {
    if (episodes === null || episodes === undefined) return null;
    if (typeof episodes === "number") return episodes;
    var keys = preferTotal ? ["count", "aired"] : ["aired", "count"];
    for (var i = 0; i < keys.length; i++) {
        if (episodes[keys[i]] !== undefined && episodes[keys[i]] !== null) return episodes[keys[i]];
    }
    return null;
}

function extractNextDate(episodes) {
    if (!episodes || !episodes.next_date) return null;
    return episodes.next_date > 0 ? episodes.next_date : null;
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

function toRatings(rating) {
    if (!rating) return [];
    var result = [];
    if (rating.average > 0) result.push({ source: "Yummy", value: rating.average, votes: rating.counters || null });
    if (rating.myanimelist_rating > 0) result.push({ source: "MAL", value: rating.myanimelist_rating, votes: null });
    if (rating.shikimori_rating > 0) result.push({ source: "Shiki", value: rating.shikimori_rating, votes: null });
    if (rating.kp_rating > 0) result.push({ source: "KP", value: rating.kp_rating, votes: null });
    if (rating.worldart_rating > 0) result.push({ source: "WA", value: rating.worldart_rating, votes: null });
    if (rating.anidub_rating > 0) result.push({ source: "AniDub", value: rating.anidub_rating, votes: null });
    return result;
}

function distinct(list) {
    var seen = {};
    var result = [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] === null || list[i] === undefined || seen[list[i]]) continue;
        seen[list[i]] = true;
        result.push(list[i]);
    }
    return result;
}

function toRelatedAnimeTitle(entry) {
    var id = entry.anime_id !== undefined && entry.anime_id !== null ? String(entry.anime_id) : null;
    var entryTitle = normalize(entry.title);
    if (id === null || entryTitle === null) return null;
    return {
        id: id, title: entryTitle, posterUrl: bestImageUrl(entry.poster),
        type: entry.type ? entry.type.alias : null, year: entry.year !== undefined ? entry.year : null,
        episodeCount: null,
        status: entry.anime_status ? (normalize(entry.anime_status.alias) || normalize(entry.anime_status.title)) : null,
    };
}

function toAnimeTitle(payload, language) {
    var localizedTitle = normalize(payload.title);
    var explicitEnglishName = normalize(payload.title_en) || normalize(payload.title_english);
    var englishName = explicitEnglishName || (language === "en" && localizedTitle && !hasCyrillic(localizedTitle) ? localizedTitle : null);
    var russianName = (language !== "en" || (localizedTitle && hasCyrillic(localizedTitle))) ? localizedTitle : null;
    var japaneseName = normalize(payload.title_jp) || normalize(payload.title_japanese);
    var originalName = normalize(payload.title_orig) || normalize(payload.title_original) || japaneseName || englishName || russianName || String(payload.anime_id);

    var synonyms = [];
    [payload.synonyms, payload.other_titles, payload.alternative_titles, payload.aliases].forEach(function (list) {
        (list || []).forEach(function (value) {
            var normalized = normalize(value);
            if (normalized !== null) synonyms.push(normalized);
        });
    });
    synonyms = distinct(synonyms);

    var statusCandidates = [payload.anime_status ? payload.anime_status.alias : null, payload.anime_status ? payload.anime_status.title : null, payload.status];
    var isReleased = statusCandidates.some(isReleasedStatus);
    var availableEpisodeCount = extractEpisodeCount(payload.episodes, false);
    if (availableEpisodeCount === null) availableEpisodeCount = payload.episodes_count !== undefined ? payload.episodes_count : null;
    var totalEpisodeCount = extractEpisodeCount(payload.episodes, true);
    if (totalEpisodeCount === null) totalEpisodeCount = payload.episodes_count !== undefined ? payload.episodes_count : null;

    var genres = (payload.genres || []).map(function (g) { return normalize(g.title); }).filter(function (g) { return g !== null; });
    var studios = (payload.studios || []).map(function (s) { return normalize(s.title); }).filter(function (s) { return s !== null; });
    var screenshots = (payload.random_screenshots || [])
        .map(function (s) { return s.sizes ? (normalizeUrl(s.sizes.full) || normalizeUrl(s.sizes.small)) : null; })
        .filter(function (s) { return s !== null; });
    var related = (payload.viewing_order || []).map(toRelatedAnimeTitle).filter(function (r) { return r !== null; });

    return title({
        id: String(payload.anime_id),
        russianName: russianName, englishName: englishName, originalName: originalName, japaneseName: japaneseName,
        synonyms: synonyms,
        year: payload.year !== undefined ? payload.year : null,
        type: normalize(payload.type ? payload.type.alias : null),
        episodeCount: isReleased ? totalEpisodeCount : availableEpisodeCount,
        posterUrl: bestImageUrl(payload.poster) || bestImageUrl(payload.image),
        status: normalize(payload.anime_status ? payload.anime_status.alias : null)
            || normalize(payload.anime_status ? payload.anime_status.title : null)
            || normalize(payload.status),
        description: normalize(payload.description),
        nextEpisodeAt: extractNextDate(payload.episodes),
        genres: distinct(genres),
        ratings: toRatings(payload.rating),
        ageRating: payload.min_age ? (normalize(payload.min_age.title) || normalize(payload.min_age.title_long)) : null,
        viewCount: payload.views !== undefined ? payload.views : null,
        screenshots: distinct(screenshots),
        sourceMaterial: normalize(payload.original),
        studios: distinct(studios),
        franchiseAnime: related,
        relatedAnime: related,
        season: payload.season !== undefined ? payload.season : null,
        availableEpisodeCount: isReleased ? totalEpisodeCount : availableEpisodeCount,
    });
}

function sortParam(sort, query) {
    switch (sort) {
        case "RELEVANCE": return (query || "").trim().length === 0 ? "top" : null;
        case "RATING": return "top";
        case "TITLE": return "title";
        case "YEAR": return "year";
        case "VOTES": return "votes";
        case "VIEWS": return "views";
        case "COMMENTS": return "comments";
        default: return null;
    }
}

function csv(list) {
    if (!list || list.length === 0) return null;
    var cleaned = distinct(list.map(function (v) { return String(v).trim(); }).filter(function (v) { return v.length > 0; }));
    return cleaned.length > 0 ? cleaned.join(",") : null;
}

function scheduleToTitle(item) {
    var aired = item.episodes && item.episodes.aired > 0 ? item.episodes.aired : null;
    var total = item.episodes && item.episodes.count > 0 ? item.episodes.count : null;
    var nextDate = item.episodes && item.episodes.next_date > 0 ? item.episodes.next_date : null;
    var isAnnouncement = aired === null && nextDate !== null;
    var normalizedTitle = normalize(item.title) || String(item.anime_id);
    return title({
        id: String(item.anime_id), russianName: normalizedTitle, originalName: normalizedTitle,
        type: "TV", episodeCount: aired !== null ? aired : total,
        posterUrl: bestImageUrl(item.poster),
        status: isAnnouncement ? "announcement" : "ongoing",
        nextEpisodeAt: nextDate, availableEpisodeCount: aired,
    });
}

function loadSettingsFromSwagger() {
    var response = fetch(BASE_URL + "/swagger.json", { headers: { "Lang": requestLanguage() } });
    if (!response.ok) throw new Error("swagger unavailable");
    var root = JSON.parse(S(response.body));
    var genreAliases = enumPath(root, ["components", "schemas", "GetAnimeGenresIdResponse", "properties", "response", "properties", "alias", "enum"]);
    var statusAliases = enumPath(root, ["components", "schemas", "GetAnimeCatalogResponse", "properties", "response", "properties", "data", "items", "properties", "anime_status", "properties", "alias", "enum"]);
    var sortAliases = pathParameterEnum(root, "/anime", "sort");
    return buildSettings(
        sortAliases.length > 0 ? sortAliases : FALLBACK_SORT_ALIASES,
        FALLBACK_TYPE_ALIASES,
        statusAliases.length > 0 ? statusAliases : FALLBACK_STATUS_ALIASES,
        FALLBACK_GENRE_ALIASES,
    );
}

function enumPath(root, path) {
    var current = root;
    for (var i = 0; i < path.length; i++) {
        if (!current || typeof current !== "object") return [];
        current = current[path[i]];
    }
    return Array.isArray(current) ? current : [];
}

function pathParameterEnum(root, pathKey, parameterName) {
    var parameters = root.paths && root.paths[pathKey] && root.paths[pathKey].get ? root.paths[pathKey].get.parameters : null;
    if (!parameters) return [];
    for (var i = 0; i < parameters.length; i++) {
        if (parameters[i].name === parameterName) {
            return (parameters[i].schema && parameters[i].schema.enum) || [];
        }
    }
    return [];
}

function aliasOption(alias) { return { id: alias, title: alias }; }

function buildSettings(sortAliases, typeAliases, statusAliases, genreAliases) {
    var sortOptions = distinct(["relevance"].concat(sortAliases)).map(aliasOption);
    return {
        sortOptions: sortOptions,
        typeOptions: typeAliases.map(aliasOption),
        statusOptions: statusAliases.map(aliasOption),
        genreOptions: genreAliases.map(aliasOption),
    };
}

function getVideos(animeId) {
    return get("/anime/" + animeId + "/videos", null);
}

function parseEpisodeNumber(value) {
    var match = /\d+(?:\.\d+)?/.exec(String(value).replace(",", "."));
    return match !== null ? parseFloat(match[0]) : null;
}

function episodeIndex(videos) {
    var byNumber = {};
    for (var i = 0; i < videos.length; i++) {
        var number = parseEpisodeNumber(videos[i].number);
        if (number === null || byNumber[videos[i].number]) continue;
        byNumber[videos[i].number] = { id: videos[i].number, number: number, title: videos[i].title || null };
    }
    return byNumber;
}

function playerPriority(name) {
    switch (String(name || "").toLowerCase()) {
        case "kodik": return 0;
        case "aksor": return 1;
        case "alloha": return 2;
        case "sibnet": return 3;
        case "cvh": return 4;
        case "vk": return 5;
        default: return 10;
    }
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var params = { limit: request.limit || 20, offset: request.offset || 0 };
        var query = (request.query || "").trim();
        if (query.length > 0) params.q = query;
        var sort = sortParam(request.sort || "RELEVANCE", query);
        if (sort !== null) params.sort = sort;
        var types = csv(request.typeAliases);
        if (types) params.types = types;
        var statuses = csv(request.statusAliases);
        if (statuses) params.statuses = statuses;
        var genres = csv(request.includedGenreAliases);
        if (genres) params.genres = genres;
        var excludedGenres = csv(request.excludedGenreAliases);
        if (excludedGenres) params.genres_exclude = excludedGenres;
        if (request.yearFrom) params.year_from = request.yearFrom;
        if (request.yearTo) params.year_to = request.yearTo;

        var language = requestLanguage();
        var items = get("/anime", params);
        return items.map(function (item) { return toAnimeTitle(item, language); });
    },

    latest: function (limit) {
        var schedule = get("/anime/schedule", null);
        var filtered = schedule.filter(function (item) {
            var previous = (item.episodes && item.episodes.prev_date) || 0;
            var next = (item.episodes && item.episodes.next_date) || 0;
            var aired = (item.episodes && item.episodes.aired) || 0;
            return previous > 0 || (aired <= 0 && next > 0);
        });
        filtered.sort(function (a, b) {
            var av = (a.episodes && a.episodes.prev_date > 0 ? a.episodes.prev_date : (a.episodes && a.episodes.next_date)) || 0;
            var bv = (b.episodes && b.episodes.prev_date > 0 ? b.episodes.prev_date : (b.episodes && b.episodes.next_date)) || 0;
            return bv - av;
        });
        var seen = {};
        var result = [];
        for (var i = 0; i < filtered.length && result.length < Math.max(limit || 20, 1); i++) {
            if (seen[filtered[i].anime_id]) continue;
            seen[filtered[i].anime_id] = true;
            result.push(scheduleToTitle(filtered[i]));
        }
        return result;
    },

    getById: function (id) {
        var language = requestLanguage();
        var payload = get("/anime/" + id, null);
        var result = toAnimeTitle(payload, language);
        try {
            var trailers = get("/anime/" + id + "/trailers", null);
            if (trailers.length > 0) {
                var t = trailers[0];
                var youtubeMatch = /(?:youtube\.com\/(?:embed\/)?|youtu\.be\/)([A-Za-z0-9_-]{6,})|[?&]v=([A-Za-z0-9_-]{6,})/i.exec(t.iframe_url || "");
                var youtubeId = youtubeMatch ? (youtubeMatch[1] || youtubeMatch[2]) : null;
                result.trailer = {
                    id: youtubeId || String(t.trailer_id),
                    site: youtubeId ? "youtube" : (normalize(t.player) || "yummy").toLowerCase(),
                    thumbnailUrl: youtubeId ? ("https://img.youtube.com/vi/" + youtubeId + "/hqdefault.jpg") : null,
                    sourceUrl: normalizeUrl(t.iframe_url),
                };
            }
        } catch (ignored) { /* trailers are best-effort */ }
        try {
            var recommendations = get("/anime/" + id + "/recommendations", null);
            result.similarAnime = recommendations.map(function (r) {
                var t2 = toAnimeTitle(r, language);
                return { id: t2.id, title: t2.russianName || t2.englishName || t2.originalName, posterUrl: t2.posterUrl, type: t2.type, year: t2.year, episodeCount: t2.episodeCount, status: t2.status };
            });
        } catch (ignored) { /* recommendations are best-effort */ }
        return result;
    },

    getSettings: function () {
        try {
            return loadSettingsFromSwagger();
        } catch (error) {
            return buildSettings(FALLBACK_SORT_ALIASES, FALLBACK_TYPE_ALIASES, FALLBACK_STATUS_ALIASES, FALLBACK_GENRE_ALIASES);
        }
    },

    getPlaybackGroups: function (titleId) {
        var videos = getVideos(titleId);
        var index = episodeIndex(videos);
        var byDubbing = {};
        var order = [];
        for (var i = 0; i < videos.length; i++) {
            var dubbing = String(videos[i].data.dubbing || "").replace(/^Озвучка\s*/, "").trim();
            if (dubbing.length === 0) continue;
            if (!byDubbing[dubbing]) { byDubbing[dubbing] = []; order.push(dubbing); }
            byDubbing[dubbing].push(videos[i]);
        }
        var groups = [];
        for (var d = 0; d < order.length; d++) {
            var dubbingName = order[d];
            var seen = {};
            var episodes = [];
            var group = byDubbing[dubbingName];
            for (var v = 0; v < group.length; v++) {
                var episode = index[group[v].number];
                if (!episode || seen[episode.id]) continue;
                seen[episode.id] = true;
                episodes.push(episode);
            }
            episodes.sort(function (a, b) { return a.number - b.number; });
            if (episodes.length > 0) groups.push({ id: dubbingName, title: dubbingName, episodes: episodes, qualityLabel: null });
        }
        return groups;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var videos = getVideos(titleId);
        var targetNumber = parseEpisodeNumber(episodeId);
        var matching = videos.filter(function (v) { return parseEpisodeNumber(v.number) === targetNumber; });
        if (matching.length === 0) throw new Error("YummyAnime could not find this episode");
        var links = matching.map(function (video) {
            var segments = [];
            if (video.skips) {
                if (video.skips.opening && video.skips.opening.time >= 0 && video.skips.opening.length > 0) {
                    segments.push({ type: "OPENING", startMs: video.skips.opening.time * 1000, endMs: (video.skips.opening.time + video.skips.opening.length) * 1000 });
                }
                if (video.skips.ending && video.skips.ending.time >= 0 && video.skips.ending.length > 0) {
                    segments.push({ type: "ENDING", startMs: video.skips.ending.time * 1000, endMs: (video.skips.ending.time + video.skips.ending.length) * 1000 });
                }
            }
            var url = video.iframe_url.indexOf("//") === 0 ? "https:" + video.iframe_url : video.iframe_url;
            return {
                url: url, type: "EMBED", quality: null,
                headers: { "Referer": "https://ru.yummyani.me/" },
                playerName: String(video.data.player || "").replace(/^Плеер\s*/, "").trim(),
                translation: String(video.data.dubbing || "").replace(/^Озвучка\s*/, "").trim(),
                segments: segments, videoId: video.video_id,
            };
        });
        links.sort(function (a, b) { return playerPriority(a.playerName) - playerPriority(b.playerName); });
        return links;
    },
};
