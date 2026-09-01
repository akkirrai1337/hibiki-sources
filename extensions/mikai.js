// Mikai exposes its catalog and player data through a public JSON API.  In contrast to scraping
// the Nuxt pages, this retains every Ukrainian release: a group is a voice track or subtitle
// release from one translation team, and each episode may offer ASHDI and MOON mirrors.
function S(value) { return value === null || value === undefined ? "" : String(value); }

var BASE_URL = "https://mikai.me";
var API_URL = "https://api.mikai.me/public/v1";
var MAX_RESULTS = 100;
var MIN_YEAR = 1917;
var MAX_YEAR = 2026;

function title(fields) { return AnimeTitle(fields); }

function api(path) {
    var response = fetch(API_URL + path, {
        headers: {
            "Accept": "application/json",
            "Origin": BASE_URL,
            "Referer": BASE_URL + "/"
        }
    });
    if (!response.ok) throw new Error("Mikai returned HTTP " + response.status + " for " + path);
    var body = JSON.parse(S(response.body));
    if (!body.ok) throw new Error("Mikai did not return a successful response");
    return body.result;
}

function statusOf(value) {
    switch (S(value).toLowerCase()) {
        case "finished": return "released";
        case "ongoing": return "ongoing";
        case "announce": return "announced";
        default: return null;
    }
}

function typeOf(value) {
    switch (S(value).toLowerCase()) {
        case "tv": return "tv";
        case "movie": return "movie";
        case "ova": return "ova";
        case "ona": return "ona";
        case "special": return "special";
        default: return S(value) || null;
    }
}

function posterOf(item) {
    var images = item.images || {};
    var poster = images.uaPoster || images.poster || {};
    poster = poster.images || poster;
    var medium = poster.medium || poster.big || poster.small || {};
    return medium.webp || medium.jpg || null;
}

function toTitle(item) {
    item = item || {};
    var titles = item.titles || {};
    var episodes = item.episodes;
    var episodeCount = typeof episodes === "object" && episodes !== null ? episodes.total : episodes;
    var available = typeof episodes === "object" && episodes !== null ? episodes.localized : null;
    return title({
        id: S((item.ids || {}).mikai),
        russianName: titles.ua || titles.english || titles.original || null,
        englishName: titles.english || null,
        originalName: titles.original || titles.ua || titles.english || null,
        year: item.year || null,
        type: typeOf(item.format),
        episodeCount: episodeCount || null,
        availableEpisodeCount: available || null,
        posterUrl: posterOf(item),
        status: statusOf(item.status),
        description: item.description || null,
        genres: (item.genres || []).map(function (genre) { return genre.ua || genre.name; })
    });
}

function queryValue(value) { return encodeURIComponent(S(value)); }

function sortParams(sort) {
    switch (S(sort).toUpperCase()) {
        case "TITLE": return "sort=name&order=asc";
        case "RATING": return "sort=mal_rating&order=desc";
        case "YEAR": return "sort=year&order=desc";
        default: return "sort=updated&order=desc";
    }
}

function listPage(request, page, limit) {
    var params = ["page=" + page, "limit=" + limit];
    var query = S(request.query).trim();
    if (query) params.push("search=" + queryValue(query));
    else params.push(sortParams(request.sort));

    var types = request.typeAliases || [];
    if (types.length) params.push("formats=" + queryValue(types.join(",")));
    var genres = request.includedGenreAliases || [];
    if (genres.length) params.push("genres=" + queryValue(genres.join(",")));
    if (request.yearFrom) params.push("yearFrom=" + Math.max(MIN_YEAR, request.yearFrom));
    if (request.yearTo) params.push("yearTo=" + Math.min(MAX_YEAR, request.yearTo));
    return api("/anime?" + params.join("&"));
}

function list(request) {
    var offset = Math.max(request.offset || 0, 0);
    var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
    var pageSize = 100;
    var firstPage = Math.floor(offset / pageSize) + 1;
    var localOffset = offset % pageSize;
    var items = [];
    for (var page = firstPage; items.length < localOffset + limit; page++) {
        var pageItems = listPage(request, page, pageSize);
        items = items.concat(pageItems);
        if (pageItems.length < pageSize) break;
    }
    return items.slice(localOffset, localOffset + limit);
}

function player(titleId) { return api("/anime/" + queryValue(titleId) + "/player"); }

function groupTitle(release) {
    var teams = release.teams || [];
    var names = [];
    for (var i = 0; i < teams.length; i++) if (teams[i].name) names.push(teams[i].name);
    var name = names.join(" + ") || "Mikai";
    return release.kind === "sub" ? name + " · Субтитри" : name + " · Озвучення";
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var items = list(request);
        return items.map(toTitle);
    },

    latest: function (limit) {
        return list({ offset: 0, limit: limit || 20, sort: "RELEVANCE" }).map(toTitle);
    },

    getSettings: function () {
        var genres = api("/genres");
        return {
            sortOptions: [
                { id: "relevance", title: "Оновленнями" },
                { id: "title", title: "Абеткою" },
                { id: "rating", title: "Рейтингом" },
                { id: "year", title: "Роком" }
            ],
            typeOptions: [
                { id: "tv", title: "ТБ-серіал" }, { id: "movie", title: "Фільм" },
                { id: "ova", title: "OVA" }, { id: "ona", title: "ONA" },
                { id: "special", title: "Спешл" }
            ],
            genreOptions: genres.map(function (genre) { return { id: genre.name, title: genre.ua || genre.name }; })
        };
    },

    getById: function (id) { return toTitle(api("/anime/" + queryValue(id))); },

    getPlaybackGroups: function (titleId) {
        var releases = player(titleId).releases || [];
        var groups = [];
        for (var i = 0; i < releases.length; i++) {
            var release = releases[i];
            var episodes = release.episodes || [];
            if (!episodes.length) continue;
            groups.push({
                id: release.id,
                title: groupTitle(release),
                episodes: episodes.map(function (episode) {
                    return { id: release.id + ":" + S(episode.number), number: episode.number, title: episode.label || null };
                }),
                qualityLabel: release.kind === "sub" ? "SUB" : null
            });
        }
        return groups;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var separator = S(episodeId).lastIndexOf(":");
        var episodeNumber = S(episodeId).substring(separator + 1);
        var releases = player(titleId).releases || [];
        for (var i = 0; i < releases.length; i++) {
            var release = releases[i];
            if (release.id !== groupId) continue;
            var episodes = release.episodes || [];
            for (var j = 0; j < episodes.length; j++) {
                if (S(episodes[j].number) !== episodeNumber) continue;
                var sources = episodes[j].sources || [];
                return sources.map(function (source) {
                    return {
                        url: source.embedUrl, type: "EMBED", quality: null,
                        headers: { "Referer": BASE_URL + "/" },
                        playerName: source.provider || null, translation: groupTitle(release), segments: [], videoId: null
                    };
                });
            }
        }
        throw new Error("Mikai episode is unavailable: " + episodeId);
    }
};
