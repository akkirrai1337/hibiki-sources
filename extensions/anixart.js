// Anixart scripted extension for Hibiki. Pure JSON API (api.anixart.tv), no Jsoup needed.
//
// Shape of the API, since it is undocumented:
//   POST /filter/{page}            body {sort, genres[], category_id, status_id, start_year, end_year}
//   POST /search/releases/{page}   body {query, searchBy: 0}   - no sort/filter support here
//   GET  /release/{id}             full payload incl. related_releases / recommended_releases
//   GET  /episode/{id}             dubbing "types"
//   GET  /episode/{id}/{typeId}    players ("sources") for one dubbing
//   GET  /episode/{id}/{typeId}/{sourceId}   episode list with playable urls
// Every page is a fixed 25 items, so the host's arbitrary limit/offset window is served by
// fetching the pages it spans and slicing (see `pagedFetch`).
//
// Filter dictionaries are *not* exposed by the API (/filter/genres and friends answer 200 with an
// empty body), so the genre vocabulary below was harvested from the catalog itself; genres are
// matched by their Russian display name, which is exactly what the filter body expects.

var BASE_URL = "https://api.anixart.tv";
var SITE_URL = "https://anixart.tv/";
var PAGE_SIZE = 25;

// `sort` lives in the request body - the `?sort=` query parameter the site also sends is ignored
// by the backend. Verified empirically: 0 orders by last_update_date, 1 by grade, 2 by year,
// 3 by popularity (the ordering the app's own "popular" tab shows).
var SORT_LAST_UPDATE = 0;
var SORT_GRADE = 1;
var SORT_YEAR = 2;
var SORT_POPULAR = 3;

var CATEGORY_OPTIONS = [
    { id: "1", title: "Сериал", alias: "tv" },
    { id: "2", title: "Фильм", alias: "movie" },
    { id: "3", title: "OVA", alias: "ova" },
    { id: "6", title: "Спешл", alias: "special" },
];

var STATUS_OPTIONS = [
    { id: "1", title: "Вышел", alias: "released" },
    { id: "2", title: "Выходит", alias: "ongoing" },
    { id: "3", title: "Анонс", alias: "announcement" },
];

// Anixart's age_rating is the Russian ordinal scale, not the MAL one (0 means "not set").
var AGE_RATINGS = [null, "0+", "6+", "12+", "16+", "18+"];

var GENRES = [
    "cgdct", "авангард", "боевые искусства", "вампиры", "взрослые персонажи", "видеоигры",
    "военное", "выживание", "гарем", "гонки", "городское фэнтези", "гурман", "гэг-юмор",
    "детектив", "драма", "жестокость", "забота о детях", "игра с высокими ставками",
    "изобразительное искусство", "исторический", "исэкай", "иясикэй", "командный спорт",
    "комедия", "культура отаку", "любовный многоугольник", "медицина", "меха", "мифология",
    "музыка", "организованная преступность", "пародия", "повседневность", "приключения",
    "психологическое", "путешествие во времени", "работа", "реинкарнация", "романтика",
    "романтический подтекст", "самураи", "сверхъестественное", "спорт", "стратегические игры",
    "супер сила", "сэйнэн", "сёдзё", "сёнен", "сёнен-ай", "сёнэн", "тайна", "триллер",
    "удостоено наград", "ужасы", "фантастика", "фэнтези", "хулиганы", "школа", "шоу-бизнес",
    "экшен", "этти",
];

function S(value) { return value === null || value === undefined ? null : String(value); }

function normalize(value) {
    if (value === null || value === undefined) return null;
    var trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
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

function request(path, body) {
    var options = { headers: { "Accept": "application/json" } };
    if (body !== null && body !== undefined) {
        options.method = "POST";
        options.headers["Content-Type"] = "application/json; charset=utf-8";
        options.body = JSON.stringify(body);
    }
    var response = fetch(BASE_URL + path, options);
    if (!response.ok) throw new Error("Anixart returned HTTP " + response.status);
    var payload = JSON.parse(S(response.body));
    if (payload.code !== 0 && payload.code !== undefined) {
        throw new Error("Anixart returned error code " + payload.code);
    }
    return payload;
}

// The catalog and search endpoints both page in fixed 25-item blocks, while the host asks for an
// arbitrary limit/offset window - fetch exactly the blocks that window touches, then slice.
function pagedFetch(pathPrefix, body, offset, limit) {
    var firstPage = Math.floor(offset / PAGE_SIZE);
    var lastPage = Math.floor(Math.max(offset + limit - 1, offset) / PAGE_SIZE);
    var collected = [];
    for (var page = firstPage; page <= lastPage; page++) {
        var payload = request(pathPrefix + page, body);
        var content = payload.content || [];
        collected = collected.concat(content);
        if (content.length < PAGE_SIZE) break;
    }
    var start = offset - firstPage * PAGE_SIZE;
    return collected.slice(start, start + limit);
}

function optionAlias(options, id, field) {
    for (var i = 0; i < options.length; i++) {
        if (options[i].id === String(id)) return options[i][field];
    }
    return null;
}

function posterUrl(payload) {
    var image = normalize(payload.image);
    if (image !== null) return image;
    var poster = normalize(payload.poster);
    return poster !== null ? "https://s.anixmirai.com/posters/" + poster + ".jpg" : null;
}

// `year` is a display string that can carry a range for multi-cour releases ("1999, 2000") - the
// host wants a single number, so take the first one it mentions.
function parseYear(value) {
    var match = /\d{4}/.exec(String(value === null || value === undefined ? "" : value));
    return match !== null ? parseInt(match[0], 10) : null;
}

function splitList(value) {
    var normalized = normalize(value);
    if (normalized === null) return [];
    return distinct(normalized.split(",").map(function (part) { return part.trim(); })
        .filter(function (part) { return part.length > 0; }));
}

function toRatings(payload) {
    if (!payload.grade || payload.grade <= 0) return [];
    return [{ source: "Anixart", value: payload.grade, votes: payload.vote_count || null }];
}

function toShortTitle(payload) {
    if (!payload || payload.id === undefined || payload.id === null) return null;
    var name = normalize(payload.title_ru) || normalize(payload.title_original) || String(payload.id);
    return {
        id: String(payload.id),
        title: name,
        posterUrl: posterUrl(payload),
        type: payload.category ? optionAlias(CATEGORY_OPTIONS, payload.category.id, "alias") : null,
        year: parseYear(payload.year),
        episodeCount: payload.episodes_total || payload.episodes_released || null,
        status: payload.status ? optionAlias(STATUS_OPTIONS, payload.status.id, "alias") : null,
    };
}

function toAnimeTitle(payload) {
    var russianName = normalize(payload.title_ru);
    var originalName = normalize(payload.title_original);
    var studios = normalize(payload.studio) !== null ? [normalize(payload.studio)] : [];
    var screenshots = (payload.screenshot_images || []).map(normalize)
        .filter(function (value) { return value !== null; });
    var related = (payload.related_releases || []).map(toShortTitle)
        .filter(function (value) { return value !== null; });

    return AnimeTitle({
        id: String(payload.id),
        russianName: russianName,
        originalName: originalName || russianName || String(payload.id),
        englishName: null,
        japaneseName: null,
        synonyms: splitList(payload.title_alt),
        year: parseYear(payload.year),
        type: payload.category ? optionAlias(CATEGORY_OPTIONS, payload.category.id, "alias") : null,
        episodeCount: payload.episodes_total || payload.episodes_released || null,
        availableEpisodeCount: payload.episodes_released || null,
        posterUrl: posterUrl(payload),
        status: payload.status ? optionAlias(STATUS_OPTIONS, payload.status.id, "alias") : null,
        description: normalize(payload.description),
        // `aired_on_date` is Unix seconds and only meaningful while a release is still airing;
        // AnimeTitle.nextEpisodeAt is epoch milliseconds everywhere in the host app.
        nextEpisodeAt: (payload.status && payload.status.id === 2 && payload.aired_on_date > 0)
            ? payload.aired_on_date * 1000 : null,
        genres: splitList(payload.genres),
        ratings: toRatings(payload),
        ageRating: AGE_RATINGS[payload.age_rating] || null,
        viewCount: payload.favorites_count !== undefined ? payload.favorites_count : null,
        screenshots: distinct(screenshots),
        sourceMaterial: normalize(payload.source),
        studios: studios,
        franchiseAnime: related,
        relatedAnime: related,
        season: payload.season !== undefined ? payload.season : null,
    });
}

function sortValue(sort) {
    switch (sort) {
        case "RATING": return SORT_GRADE;
        case "YEAR": return SORT_YEAR;
        default: return SORT_POPULAR;
    }
}

function firstId(list) {
    if (!list || list.length === 0) return null;
    var value = normalize(list[0]);
    if (value === null) return null;
    var parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
}

function episodeNumber(episode) {
    var name = String(episode.name === null || episode.name === undefined ? "" : episode.name);
    var match = /\d+(?:\.\d+)?/.exec(name.replace(",", "."));
    if (match !== null) return parseFloat(match[0]);
    // Fall back to `position`, which is 1-based on some sources and 0-based on others.
    return episode.position > 0 ? episode.position : episode.position + 1;
}

function dubbingTypes(titleId) {
    return request("/episode/" + titleId, null).types || [];
}

function playerSources(titleId, typeId) {
    return request("/episode/" + titleId + "/" + typeId, null).sources || [];
}

function episodeList(titleId, typeId, sourceId) {
    return request("/episode/" + titleId + "/" + typeId + "/" + sourceId, null).episodes || [];
}

// One dubbing can be carried by several players; they mirror the same episode list, so the group's
// episode list comes from whichever player claims the most of them, and only `getPlayerLinks` pays
// for fetching the rest.
function richestSource(sources) {
    var best = null;
    for (var i = 0; i < sources.length; i++) {
        if (best === null || (sources[i].episodes_count || 0) > (best.episodes_count || 0)) best = sources[i];
    }
    return best;
}

function toPlayerLink(episode, source, dubbing) {
    var url = normalize(episode.url);
    if (url === null) return null;
    var type;
    if (episode.iframe) type = "EMBED";
    else if (/\.m3u8(\?|$)/i.test(url)) type = "DIRECT_HLS";
    else type = "DIRECT_MP4";
    return {
        url: url,
        type: type,
        quality: null,
        headers: { "Referer": SITE_URL },
        playerName: normalize(source ? source.name : null),
        translation: dubbing,
        segments: [],
    };
}

var Provider = {
    search: function (requestJson) {
        var searchRequest = JSON.parse(requestJson);
        var limit = searchRequest.limit || 20;
        var offset = searchRequest.offset || 0;
        var query = (searchRequest.query || "").trim();
        var items;
        if (query.length > 0) {
            // The search endpoint takes no sort or filter arguments, so a text query is answered
            // by relevance alone; filters only narrow the browsable catalog below.
            items = pagedFetch("/search/releases/", { query: query, searchBy: 0 }, offset, limit);
        } else {
            var body = { sort: sortValue(searchRequest.sort || "RELEVANCE") };
            var genres = (searchRequest.includedGenreAliases || [])
                .map(normalize).filter(function (value) { return value !== null; });
            if (genres.length > 0) body.genres = genres;
            var categoryId = firstId(searchRequest.typeAliases);
            if (categoryId !== null) body.category_id = categoryId;
            var statusId = firstId(searchRequest.statusAliases);
            if (statusId !== null) body.status_id = statusId;
            if (searchRequest.yearFrom) body.start_year = searchRequest.yearFrom;
            if (searchRequest.yearTo) body.end_year = searchRequest.yearTo;
            items = pagedFetch("/filter/", body, offset, limit);
        }
        return items.map(toAnimeTitle);
    },

    latest: function (limit) {
        var wanted = Math.max(limit || 20, 1);
        return pagedFetch("/filter/", { sort: SORT_LAST_UPDATE }, 0, wanted).map(toAnimeTitle);
    },

    getById: function (id) {
        var payload = request("/release/" + id, null).release;
        var result = toAnimeTitle(payload);
        result.similarAnime = (payload.recommended_releases || []).map(toShortTitle)
            .filter(function (value) { return value !== null; });
        return result;
    },

    getSettings: function () {
        return {
            sortOptions: [
                { id: "relevance", title: "По популярности" },
                { id: "grade", title: "По оценке" },
                { id: "year", title: "По году" },
            ],
            typeOptions: CATEGORY_OPTIONS.map(function (option) {
                return { id: option.id, title: option.title };
            }),
            statusOptions: STATUS_OPTIONS.map(function (option) {
                return { id: option.id, title: option.title };
            }),
            genreOptions: GENRES.map(function (genre) { return { id: genre, title: genre }; }),
        };
    },

    getPlaybackGroups: function (titleId) {
        var types = dubbingTypes(titleId);
        var groups = [];
        for (var i = 0; i < types.length; i++) {
            var type = types[i];
            var source = richestSource(playerSources(titleId, type.id));
            if (source === null) continue;
            var episodes = episodeList(titleId, type.id, source.id).map(function (episode) {
                var number = episodeNumber(episode);
                return { id: String(number), number: number, title: normalize(episode.name) };
            });
            episodes.sort(function (a, b) { return a.number - b.number; });
            if (episodes.length === 0) continue;
            groups.push({
                id: String(type.id),
                title: normalize(type.name) || String(type.id),
                episodes: episodes,
                qualityLabel: null,
            });
        }
        return groups;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var types = dubbingTypes(titleId);
        var dubbing = null;
        for (var t = 0; t < types.length; t++) {
            if (String(types[t].id) === String(groupId)) dubbing = normalize(types[t].name);
        }
        var target = parseFloat(String(episodeId).replace(",", "."));
        var sources = playerSources(titleId, groupId);
        var links = [];
        for (var i = 0; i < sources.length; i++) {
            var episodes = episodeList(titleId, groupId, sources[i].id);
            for (var e = 0; e < episodes.length; e++) {
                // Matched on the episode number rather than `position`, which the API reports
                // 1-based on some players and 0-based on others - two players carrying the same
                // dubbing would otherwise hand back links one episode apart.
                if (episodeNumber(episodes[e]) !== target) continue;
                var link = toPlayerLink(episodes[e], sources[i], dubbing);
                if (link !== null) links.push(link);
            }
        }
        if (links.length === 0) throw new Error("Anixart could not find this episode");
        return links;
    },
};
