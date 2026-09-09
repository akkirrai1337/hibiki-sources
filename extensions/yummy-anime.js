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

// The sort values /anime actually accepts, verified against the live API - "votes" and
// "comments" were in here and answer HTTP 400, while "rating", "rating_counters", "random" and
// "id" work and were missing. Two broken options offered and four working ones hidden.
var SORT_ALIASES = ["top", "title", "year", "rating", "rating_counters", "views", "random", "id"];
var TYPE_ALIASES = ["tv", "movie", "short_movie", "ova", "special", "short_serial", "ona"];
var STATUS_ALIASES = ["released", "ongoing", "announcement"];

/** Hibiki's library categories to the site's own list names. "favorite" is not a list there but a
 * separate flag, and "saved" has no counterpart at all, so neither appears here. */
var LIST_BY_CATEGORY = {
    "watching": "watching",
    "planned": "planned",
    "completed": "completed",
    "dropped": "dropped",
    "on_hold": "postponed",
};
var GENRE_ALIASES = [
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

/**
 * Several API calls at once, in the order asked, each already unwrapped like get() does.
 *
 * Extension scripts are synchronous, so plain get() calls run strictly one after another even when
 * they have nothing to do with each other - getById needs a title, its trailers and its
 * recommendations, and waiting for each in turn measured 364ms against 207ms for the same three
 * together. `fetchAll` is the host global that fixes that.
 *
 * Feature-detected rather than assumed: this same file runs on hosts that don't have it yet, and
 * there it simply falls back to the serial path. A failed entry comes back as null rather than
 * throwing, so one missing extra can't take the whole call down - which is what the try/catch
 * around each optional request used to be for.
 */
function getAll(paths) {
    var i, results = [];
    if (typeof fetchAll !== "function") {
        for (i = 0; i < paths.length; i++) {
            try { results.push(get(paths[i], null)); } catch (e) { results.push(null); }
        }
        return results;
    }
    var requests = [];
    for (i = 0; i < paths.length; i++) {
        requests.push({
            url: BASE_URL + paths[i],
            headers: { "Lang": requestLanguage(), "X-Application": APPLICATION_TOKEN },
        });
    }
    var responses = fetchAll(requests);
    for (i = 0; i < responses.length; i++) {
        var response = responses[i];
        if (!response || !response.ok) { results.push(null); continue; }
        try { results.push(JSON.parse(S(response.body)).response); } catch (e2) { results.push(null); }
    }
    return results;
}

/* ------------------------------------------------------------------ account ---------------- */

/*
 * Everything below needs a signed-in user. The session token is kept in the host's own per-source
 * store (the `storage` global), never in this file and never anywhere the script can leak it - and
 * the password is not kept at all, it is a parameter of login() and nothing else.
 *
 * Feature-detected like fetchAll is: a host without `storage` simply has no account, rather than
 * throwing on load and taking the catalog down with it.
 */

var TOKEN_KEY = "session_token";

function hasStorage() {
    return typeof storage === "object" && storage !== null && typeof storage.get === "function";
}

function sessionToken() {
    if (!hasStorage()) return null;
    var token = storage.get(TOKEN_KEY);
    return (token && String(token).length > 0) ? String(token) : null;
}

function authHeaders(extra) {
    var headers = { "Lang": requestLanguage(), "X-Application": APPLICATION_TOKEN };
    var token = sessionToken();
    // The site's own scheme, not Bearer: "Yummy <token>".
    if (token) headers["Authorization"] = "Yummy " + token;
    if (extra) for (var key in extra) headers[key] = extra[key];
    return headers;
}

/** The API always answers with a JSON envelope; errors carry a human message worth surfacing. */
function apiError(response) {
    var message = "YummyAnime returned HTTP " + (response ? response.status : 0);
    try {
        var parsed = JSON.parse(S(response.body));
        if (parsed && parsed.error) message = String(parsed.error);
    } catch (e) { /* keep the status-only message */ }
    return new Error(message);
}

function callApi(method, path, body) {
    var options = { method: method, headers: authHeaders(null) };
    if (body !== null && body !== undefined) {
        options.body = JSON.stringify(body);
        options.headers["Content-Type"] = "application/json";
    }
    var response = fetch(BASE_URL + path, options);
    if (!response || !response.ok) throw apiError(response);
    var parsed = JSON.parse(S(response.body));
    return parsed ? parsed.response : null;
}

function requireAccount() {
    if (!hasStorage()) throw new Error("This app cannot store a session for YummyAnime");
    if (!sessionToken()) throw new Error("Not signed in to YummyAnime");
}

function avatarUrlOf(avatars) {
    if (!avatars) return null;
    var url = avatars.big || avatars.full || avatars.small || null;
    if (!url) return null;
    // The API returns protocol-relative URLs; an image loader wants a real scheme.
    return normalizeUrl(String(url).indexOf("//") === 0 ? "https:" + url : url);
}

function toAccount(profile) {
    if (!profile) return null;
    var id = profile.id !== undefined && profile.id !== null ? String(profile.id) : null;
    if (!id) return null;
    return {
        id: id,
        name: normalize(profile.nickname) || ("id" + id),
        avatarUrl: avatarUrlOf(profile.avatars || profile.avatar),
        profileUrl: "https://ru.yummyani.me/users/" + id,
    };
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

// `posterUrl` never gets shown larger than a few hundred CSS px anywhere in the host app (catalog
// cards, the detail page's own poster, related-title strips - all well under 400px wide), but
// `fullsize` is a 784x1200 JPEG (~140KB) meant for something closer to a full-page hero image.
// `mega` is the same artwork re-encoded as 570x800 AVIF at a fraction of the size (~28KB) - still
// sharp at 2x+ device pixel ratio for anything this app actually renders it at, and a browser has
// to fully decode whatever it's given before it can downscale for display, so this isn't just a
// smaller download: it's meaningfully less decode work per poster, which matters a lot once dozens
// of cards are loading in close succession during a fast catalog scroll.
function bestImageUrl(image) {
    if (!image) return null;
    var candidates = [image.mega, image.huge, image.big, image.medium, image.fullsize, image.original, image.small, image.preview, image.thumbnail, image.url];
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

// Yummy's `next_date`/`prev_date` are Unix seconds (confirmed against /anime/schedule - e.g.
// 1788220800 -> 2026-09-01), but AnimeTitle.nextEpisodeAt is epoch milliseconds everywhere else in
// the host app - passing the raw value through silently produced a January-1970 timestamp, which
// then read as permanently in the past and hid the next-episode countdown entirely.
function extractNextDate(episodes) {
    if (!episodes || !episodes.next_date) return null;
    return episodes.next_date > 0 ? episodes.next_date * 1000 : null;
}

function title(fields) { return AnimeTitle(fields); }

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
        episodeCount: totalEpisodeCount !== null ? totalEpisodeCount : availableEpisodeCount,
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
        availableEpisodeCount: availableEpisodeCount,
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
    var nextDate = item.episodes && item.episodes.next_date > 0 ? item.episodes.next_date * 1000 : null;
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

// Deliberately no /swagger.json here any more. It was fetched on every launch to read the sort,
// status and genre enums out of the API's own schema - 471KB and ~414ms to extract about 1.5KB,
// 0.31% of what came down the wire. Worse, almost none of it was even used: the statuses matched
// the list below exactly, the genres come from /anime/genres (9KB) which is fetched anyway, and
// what was left was eight sort strings.
//
// Those are now the list above, checked against the live API rather than read from a schema at
// runtime. If the API's sorts change, the extension ships a new version - which is how everything
// else in this file already tracks the API, and is the mechanism the repository exists for.


function aliasOption(alias) { return { id: alias, title: alias }; }

function loadGenreOptions() {
    var response = get("/anime/genres", null);
    var genres = response && Array.isArray(response.genres) ? response.genres : [];
    var options = [];
    var seen = {};
    for (var i = 0; i < genres.length; i++) {
        var alias = normalize(genres[i].href);
        if (alias === null || seen[alias]) continue;
        seen[alias] = true;
        options.push({ id: alias, title: normalize(genres[i].title) || alias });
    }
    return options;
}

function buildSettings(sortAliases, typeAliases, statusAliases, genreOptions) {
    var sortOptions = distinct(["relevance"].concat(sortAliases)).map(aliasOption);
    return {
        sortOptions: sortOptions,
        typeOptions: typeAliases.map(aliasOption),
        statusOptions: statusAliases.map(aliasOption),
        genreOptions: genreOptions.map(function (option) {
            return typeof option === "string" ? aliasOption(option) : option;
        }),
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
        case "alloha": return 1;
        case "aksor": return 2;
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
        // All three at once - they don't depend on each other, and the title alone is no use
        // without the page's other two sections anyway. The title is the only one that matters:
        // if it failed there is nothing to return, so that one still throws the way it always did.
        var fetched = getAll(["/anime/" + id, "/anime/" + id + "/trailers", "/anime/" + id + "/recommendations"]);
        var payload = fetched[0];
        if (!payload) throw new Error("YummyAnime could not load this title");
        var result = toAnimeTitle(payload, language);
        try {
            var trailers = fetched[1];
            if (trailers && trailers.length > 0) {
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
            var recommendations = fetched[2];
            result.similarAnime = (recommendations || []).map(function (r) {
                var t2 = toAnimeTitle(r, language);
                return { id: t2.id, title: t2.russianName || t2.englishName || t2.originalName, posterUrl: t2.posterUrl, type: t2.type, year: t2.year, episodeCount: t2.episodeCount, status: t2.status };
            });
        } catch (ignored) { /* recommendations are best-effort */ }
        return result;
    },

    getSettings: function () {
        // One 9KB request, for the only part that genuinely has to come from the server: the genre
        // list, which is long and does change. Everything else is known.
        var genreOptions;
        try {
            genreOptions = loadGenreOptions();
        } catch (ignored) {
            genreOptions = GENRE_ALIASES;
        }
        return buildSettings(SORT_ALIASES, TYPE_ALIASES, STATUS_ALIASES, genreOptions);
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
        var requestedDubbing = String(groupId || "").trim();
        var matching = videos.filter(function (v) {
            var dubbing = String(v.data.dubbing || "").replace(/^Озвучка\s*/, "").trim();
            return parseEpisodeNumber(v.number) === targetNumber &&
                (requestedDubbing.length === 0 || dubbing === requestedDubbing);
        });
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

    /*
     * Account. The password reaches this function and goes no further: what is kept is the token
     * the API hands back, and only that.
     *
     * `need_json` asks the API to answer with the token in the body rather than only as a cookie,
     * which is the difference between a session this app can carry and one only a browser could.
     */
    login: function (json) {
        if (!hasStorage()) throw new Error("This app cannot store a session for YummyAnime");
        var request = JSON.parse(json);
        var response = fetch(BASE_URL + "/profile/login", {
            method: "POST",
            headers: { "Lang": requestLanguage(), "X-Application": APPLICATION_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({
                login: String(request.login || ""),
                password: String(request.password || ""),
                need_json: true,
            }),
        });
        if (!response || !response.ok) throw apiError(response);
        var parsed = JSON.parse(S(response.body));
        var token = parsed && parsed.response ? parsed.response.token : null;
        if (!token) throw new Error("YummyAnime did not return a session token");
        storage.set(TOKEN_KEY, String(token));

        // Read the profile back, so a caller gets a name and an avatar rather than just "it
        // worked". A token that cannot fetch its own profile is not a session worth keeping.
        try {
            var account = toAccount(callApi("GET", "/profile", null));
            if (account) return account;
        } catch (e) {
            storage.remove(TOKEN_KEY);
            throw e;
        }
        storage.remove(TOKEN_KEY);
        throw new Error("YummyAnime returned an unexpected profile");
    },

    logout: function () {
        if (!sessionToken()) return true;
        // The token goes first: if telling the server fails, this app is still signed out, which
        // is what the person asked for. A stale server session expires on its own.
        try { callApi("POST", "/profile/logout", null); } catch (e) { /* local sign-out stands */ }
        storage.remove(TOKEN_KEY);
        return true;
    },

    getAccount: function () {
        if (!sessionToken()) return null;
        try {
            return toAccount(callApi("GET", "/profile", null));
        } catch (e) {
            // A token the server no longer accepts is worse than no token: it makes the app look
            // signed in while nothing an account unlocks actually works.
            storage.remove(TOKEN_KEY);
            return null;
        }
    },

    /* Comments are public - reading them needs no account, only posting does. */
    listComments: function (json) {
        var request = JSON.parse(json);
        var animeId = String(request.animeId || "");
        var parentId = request.parentId !== null && request.parentId !== undefined ? String(request.parentId) : null;
        var skip = request.offset || 0;
        var path = parentId
            ? "/comments/" + encodeURIComponent(parentId) + "/children?skip=" + skip
            : "/comments/anime/" + encodeURIComponent(animeId) + "?skip=" + skip + "&sort=new";
        var response = callApi("GET", path, null);
        // The two endpoints disagree about their shape: the thread one answers with an object
        // carrying `comments`, the children one with a bare array.
        var items = response && response.comments ? response.comments : (response || []);
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || item.deleted_at) continue;
            out.push({
                id: String(item.id),
                authorName: normalize(item.name) || "",
                authorAvatarUrl: avatarUrlOf(item.avatars),
                text: String(item.text || ""),
                createdAt: (item.time || 0) * 1000,
                likes: (item.likes || 0) - (item.dislikes || 0),
                replyCount: item.children_count || 0,
                parentId: item.parent_id ? String(item.parent_id) : null,
            });
        }
        return out;
    },

    postComment: function (json) {
        requireAccount();
        var request = JSON.parse(json);
        var body = { text: String(request.text || "") };
        if (request.parentId) body.parent_id = Number(request.parentId);
        var created = callApi("POST", "/comments/anime/" + encodeURIComponent(String(request.animeId)), body);
        return {
            id: created && created.id !== undefined ? String(created.id) : "",
            authorName: normalize(created && created.name) || "",
            authorAvatarUrl: avatarUrlOf(created && created.avatars),
            text: String((created && created.text) || request.text || ""),
            createdAt: created && created.time ? created.time * 1000 : Date.now(),
            likes: 0,
            replyCount: 0,
            parentId: request.parentId ? String(request.parentId) : null,
        };
    },

    listReviews: function (json) {
        var request = JSON.parse(json);
        var response = callApi("GET", "/anime/" + encodeURIComponent(String(request.animeId)) + "/reviews", null);
        var items = (response && response.reviews) || [];
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            out.push({
                id: String(item.review_id),
                authorName: normalize(item.nickname) || normalize(item.author) || "",
                authorAvatarUrl: avatarUrlOf(item.avatar),
                // text_html when the whole review came back, text_preview in a listing - the two
                // endpoints differ, and a review with neither is not worth showing.
                text: String(item.text_html || item.text_preview || ""),
                createdAt: (item.create_date || 0) * 1000,
                rating: item.rating && item.rating.average !== undefined ? item.rating.average : null,
                likes: item.total_likes || 0,
            });
        }
        return out;
    },

    postReview: function (json) {
        requireAccount();
        var request = JSON.parse(json);
        var created = callApi("POST", "/reviews", {
            anime_id: Number(request.animeId),
            text: String(request.text || ""),
            commentable: true,
            rating: { average: Number(request.rating || 0), category: [] },
        });
        return {
            id: created && created.review_id !== undefined ? String(created.review_id) : "",
            authorName: "",
            authorAvatarUrl: null,
            text: String(request.text || ""),
            createdAt: Date.now(),
            rating: request.rating === undefined ? null : request.rating,
            likes: 0,
        };
    },

    /*
     * Pushes one title's status, and its score when there is one, to the account.
     *
     * This is what the site's own profile actually records - lists, ratings, reviews - and it is
     * as close to "activity" as its API goes. There is no endpoint anywhere in their web client
     * that takes watched minutes or episode progress for anime, so nothing here pretends to send
     * any.
     */
    syncLibraryEntry: function (json) {
        requireAccount();
        var request = JSON.parse(json);
        var animeId = encodeURIComponent(String(request.animeId));
        var list = LIST_BY_CATEGORY[String(request.category || "")] || null;

        if (String(request.category || "") === "favorite") {
            callApi("PUT", "/anime/" + animeId + "/list/fav", {});
        } else if (list) {
            callApi("PUT", "/anime/" + animeId + "/list", { list: list });
        } else {
            // Removed from the library here means removed there, not left behind under whatever
            // status it last had.
            try { callApi("DELETE", "/anime/" + animeId + "/list", null); } catch (e) { /* already absent */ }
        }

        if (request.rating !== null && request.rating !== undefined) {
            callApi("PUT", "/anime/" + animeId + "/rate", { rate: Number(request.rating) });
        }
        return true;
    },
};
