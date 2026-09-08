// AnimeLib scripted extension for Hibiki. Pure JSON API (api.cdnlibs.org), no Jsoup needed.
//
// Shape of the API, since it is undocumented:
//   GET /api/anime                       catalog: page, limit, sort_by, sort_type, q,
//                                        genres[], types[], status[], year_min, year_max
//   GET /api/anime/{slug}?fields[]=...   full card; `fields[]` is a strict allow-list (see
//                                        DETAIL_FIELDS - an unknown name fails the whole call
//                                        with HTTP 422, it is not ignored)
//   GET /api/anime/{slug}/similar        reader-submitted "similar" picks
//   GET /api/anime/{slug}/relations      franchise entries - MIXED MEDIA, manga included
//   GET /api/constants?fields[]=...      real genre/type/status dictionaries
//   GET /api/episodes?anime_id={slug}    episode list, no players
//   GET /api/episodes/{id}               one episode with every team's player
//
// The catalog is keyed by `slug_url` ("16133--jujutsu-kaisen-anime"), which is what the detail and
// episode endpoints take, so that - not the bare numeric id - is the title id handed to the host.

var BASE_URL = "https://api.cdnlibs.org/api";
var SITE_URL = "https://anilib.me/";
// AnimeLib is one site of the "Lib" family (manga/ranobe/anime share this backend); 5 is anime.
var SITE_ID = 5;
// The catalog rejects a limit outside 10..60 with HTTP 422 rather than clamping it itself.
var PAGE_SIZE = 60;

var DETAIL_FIELDS = [
    "summary", "genres", "otherNames", "episodes_count", "anime_status_id", "teams", "authors",
    "publisher", "franchise", "releaseDate", "rate_avg", "views", "time", "background",
];

var TYPE_ALIASES = {
    "16": "tv", "17": "movie", "18": "short_movie", "19": "special", "20": "ova", "21": "ona",
    "22": "clip",
};

var STATUS_ALIASES = { "1": "ongoing", "2": "released", "3": "announcement" };

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

function get(path, params) {
    var query = [];
    for (var i = 0; params && i < params.length; i++) {
        if (params[i][1] === null || params[i][1] === undefined) continue;
        query.push(encodeURIComponent(params[i][0]) + "=" + encodeURIComponent(String(params[i][1])));
    }
    var url = BASE_URL + path + (query.length > 0 ? "?" + query.join("&") : "");
    var response = fetch(url, { headers: { "Accept": "application/json", "Site-Id": String(SITE_ID) } });
    if (!response.ok) throw new Error("AnimeLib returned HTTP " + response.status);
    return JSON.parse(S(response.body));
}

// A validation failure answers 200-with-`data`-as-an-object instead of the usual array, so callers
// that expect a list would otherwise silently see "no results" for a malformed request.
function listOf(payload) {
    var data = payload ? payload.data : null;
    return Object.prototype.toString.call(data) === "[object Array]" ? data : [];
}

// The catalog pages in fixed blocks while the host asks for an arbitrary limit/offset window -
// fetch exactly the blocks that window touches, then slice.
function pagedFetch(params, offset, limit) {
    var firstPage = Math.floor(offset / PAGE_SIZE);
    var lastPage = Math.floor(Math.max(offset + limit - 1, offset) / PAGE_SIZE);
    var collected = [];
    for (var page = firstPage; page <= lastPage; page++) {
        var content = listOf(get("/anime", params.concat([["page", page + 1], ["limit", PAGE_SIZE]])));
        collected = collected.concat(content);
        if (content.length < PAGE_SIZE) break;
    }
    var start = offset - firstPage * PAGE_SIZE;
    return collected.slice(start, start + limit);
}

// `summary` is a ProseMirror document, not a string - walk it and keep the text leaves, breaking a
// line between block nodes so paragraphs do not run together.
function flattenSummary(node) {
    if (node === null || node === undefined) return "";
    if (typeof node === "string") return node;
    var text = "";
    if (node.type === "text" && node.text) text += node.text;
    var children = node.content;
    for (var i = 0; children && i < children.length; i++) {
        text += flattenSummary(children[i]);
    }
    if (node.type === "paragraph" || node.type === "heading") text += "\n\n";
    return text;
}

function summaryText(summary) {
    if (summary === null || summary === undefined) return null;
    if (typeof summary === "string") return normalize(summary);
    return normalize(flattenSummary(summary));
}

function coverUrl(payload) {
    var cover = payload ? payload.cover : null;
    if (!cover) return null;
    return normalize(cover.default) || normalize(cover.md) || normalize(cover.thumbnail);
}

function parseYear(payload) {
    var match = /\d{4}/.exec(String(payload.releaseDate || payload.releaseDateString || ""));
    return match !== null ? parseInt(match[0], 10) : null;
}

function typeAlias(payload) {
    return payload.type ? (TYPE_ALIASES[String(payload.type.id)] || normalize(payload.type.label)) : null;
}

function statusAlias(payload) {
    return payload.status ? (STATUS_ALIASES[String(payload.status.id)] || normalize(payload.status.label)) : null;
}

function toRatings(payload) {
    var result = [];
    var average = payload.rating ? parseFloat(payload.rating.average) : NaN;
    if (!isNaN(average) && average > 0) {
        result.push({ source: "AnimeLib", value: average, votes: payload.rating.votes || null });
    }
    if (payload.shiki_rate > 0) result.push({ source: "Shiki", value: payload.shiki_rate, votes: null });
    return result;
}

// `rus_name` is null on a fair number of entries, so every display name falls through the same
// chain rather than trusting one field.
function displayName(payload) {
    return normalize(payload.rus_name) || normalize(payload.name) || normalize(payload.eng_name)
        || String(payload.slug_url || payload.id);
}

function toShortTitle(payload) {
    if (!payload || !payload.slug_url) return null;
    return {
        id: String(payload.slug_url),
        title: displayName(payload),
        posterUrl: coverUrl(payload),
        type: typeAlias(payload),
        year: parseYear(payload),
        episodeCount: payload.episodes_count || null,
        status: statusAlias(payload),
    };
}

function toAnimeTitle(payload) {
    var genres = (payload.genres || []).map(function (genre) { return normalize(genre.name); })
        .filter(function (genre) { return genre !== null; });
    var studios = (payload.publisher || []).map(function (studio) {
        return normalize(studio.rus_name) || normalize(studio.name);
    }).filter(function (studio) { return studio !== null; });
    // `relations` mixes the whole franchise together - the manga a series adapts is in there, and
    // its slug would not resolve against any of the anime endpoints.
    var related = (payload.relations || []).map(function (entry) { return entry.media; })
        .filter(function (media) { return media && media.model === "anime"; })
        .map(toShortTitle).filter(function (value) { return value !== null; });

    return AnimeTitle({
        id: String(payload.slug_url),
        russianName: normalize(payload.rus_name),
        originalName: normalize(payload.name) || displayName(payload),
        englishName: normalize(payload.eng_name),
        japaneseName: null,
        synonyms: distinct((payload.otherNames || []).map(normalize)
            .filter(function (value) { return value !== null; })),
        year: parseYear(payload),
        type: typeAlias(payload),
        episodeCount: payload.episodes_count || null,
        availableEpisodeCount: null,
        posterUrl: coverUrl(payload),
        status: statusAlias(payload),
        description: summaryText(payload.summary),
        nextEpisodeAt: null,
        genres: distinct(genres),
        ratings: toRatings(payload),
        ageRating: payload.ageRestriction ? normalize(payload.ageRestriction.label) : null,
        viewCount: payload.views ? payload.views.total : null,
        screenshots: payload.background && normalize(payload.background.url)
            ? [normalize(payload.background.url)] : [],
        sourceMaterial: null,
        studios: distinct(studios),
        franchiseAnime: related,
        relatedAnime: related,
        season: null,
    });
}

function sortParams(sort) {
    switch (sort) {
        case "RATING": return [["sort_by", "rating_score"], ["sort_type", "desc"]];
        case "YEAR": return [["sort_by", "releaseDate"], ["sort_type", "desc"]];
        case "VIEWS": return [["sort_by", "views"], ["sort_type", "desc"]];
        // The catalog already defaults to rating_score desc, which is the closest thing it has to
        // a relevance ordering for an empty query.
        default: return [];
    }
}

function idParams(name, aliases) {
    var params = [];
    for (var i = 0; aliases && i < aliases.length; i++) {
        var value = normalize(aliases[i]);
        if (value !== null) params.push([name + "[]", value]);
    }
    return params;
}

function constantOptions(key, nameField) {
    var payload = get("/constants", [["fields[]", key]]);
    var entries = (payload.data && payload.data[key]) || [];
    var options = [];
    for (var i = 0; i < entries.length; i++) {
        var siteIds = entries[i].site_ids || [];
        var allowed = false;
        for (var s = 0; s < siteIds.length; s++) {
            if (siteIds[s] === SITE_ID) allowed = true;
        }
        if (!allowed) continue;
        var label = normalize(entries[i][nameField]);
        if (label === null) continue;
        options.push({ id: String(entries[i].id), title: label });
    }
    return options;
}

function episodeNumber(episode) {
    var parsed = parseFloat(String(episode.number).replace(",", "."));
    return isNaN(parsed) ? null : parsed;
}

function episodeLabel(episode) {
    var name = normalize(episode.name);
    var number = normalize(episode.number);
    var season = normalize(episode.season);
    var label = (season !== null && season !== "1" ? season + " сезон, " : "") + number + " серия";
    return name !== null ? label + ". " + name : label;
}

function episodes(titleId) {
    return listOf(get("/episodes", [["anime_id", titleId]]));
}

function episodeDetail(episodeId) {
    var payload = get("/episodes/" + episodeId, null);
    return payload && payload.data ? payload.data : null;
}

function groupKey(player) {
    var teamId = player.team ? player.team.id : 0;
    var typeId = player.translation_type ? player.translation_type.id : 0;
    return teamId + ":" + typeId;
}

function groupTitle(player) {
    var team = player.team ? normalize(player.team.name) : null;
    var kind = player.translation_type ? normalize(player.translation_type.label) : null;
    if (team === null) return kind || "AnimeLib";
    // "Озвучка" is the common case and adding it to every row would just be noise; the subtitle
    // rows are the ones worth marking, since the same team often supplies both.
    return kind !== null && kind !== "Озвучка" ? team + " (" + kind + ")" : team;
}

var Provider = {
    search: function (requestJson) {
        var searchRequest = JSON.parse(requestJson);
        var limit = searchRequest.limit || 20;
        var offset = searchRequest.offset || 0;
        var query = (searchRequest.query || "").trim();

        var params = sortParams(searchRequest.sort || "RELEVANCE");
        if (query.length > 0) params = params.concat([["q", query]]);
        params = params
            .concat(idParams("genres", searchRequest.includedGenreAliases))
            .concat(idParams("types", searchRequest.typeAliases))
            .concat(idParams("status", searchRequest.statusAliases));
        if (searchRequest.yearFrom) params.push(["year_min", searchRequest.yearFrom]);
        if (searchRequest.yearTo) params.push(["year_max", searchRequest.yearTo]);

        return pagedFetch(params, offset, limit).map(toAnimeTitle);
    },

    latest: function (limit) {
        var wanted = Math.max(limit || 20, 1);
        var params = [["sort_by", "last_episode_at"], ["sort_type", "desc"]];
        return pagedFetch(params, 0, wanted).map(toAnimeTitle);
    },

    getById: function (id) {
        var fields = [];
        for (var i = 0; i < DETAIL_FIELDS.length; i++) fields.push(["fields[]", DETAIL_FIELDS[i]]);
        var payload = get("/anime/" + id, fields).data;
        // `relations` and `similar` are separate calls, and neither is worth failing the whole
        // detail page over.
        try {
            payload.relations = listOf(get("/anime/" + id + "/relations", null));
        } catch (ignored) { payload.relations = []; }
        var result = toAnimeTitle(payload);
        try {
            result.similarAnime = listOf(get("/anime/" + id + "/similar", null))
                .map(function (entry) { return entry.media; })
                .filter(function (media) { return media && media.model === "anime"; })
                .map(toShortTitle).filter(function (value) { return value !== null; });
        } catch (ignored) { /* similar titles are best-effort */ }
        return result;
    },

    getSettings: function () {
        return {
            sortOptions: [
                { id: "rating_score", title: "По рейтингу" },
                { id: "views", title: "По просмотрам" },
                { id: "releaseDate", title: "По дате выхода" },
            ],
            typeOptions: constantOptions("types", "label"),
            statusOptions: constantOptions("status", "label"),
            genreOptions: constantOptions("genres", "name"),
        };
    },

    getPlaybackGroups: function (titleId) {
        var list = episodes(titleId);
        if (list.length === 0) return [];
        var episodeList = list.map(function (episode) {
            return {
                id: String(episode.number),
                number: episodeNumber(episode),
                title: episodeLabel(episode),
            };
        }).filter(function (episode) { return episode.number !== null; });
        episodeList.sort(function (a, b) { return a.number - b.number; });

        // Enumerating a team's exact coverage would cost one request per episode, so the teams are
        // read off the first and last episode instead - the union catches both the teams that
        // dropped out partway and the ones that joined late, and `getPlayerLinks` still answers
        // per-episode, so a gap in the middle surfaces there rather than being invented here.
        var probes = distinct([list[0].id, list[list.length - 1].id]);
        var groups = [];
        var seen = {};
        for (var p = 0; p < probes.length; p++) {
            var detail = episodeDetail(probes[p]);
            var players = (detail && detail.players) || [];
            for (var i = 0; i < players.length; i++) {
                var key = groupKey(players[i]);
                if (seen[key]) continue;
                seen[key] = true;
                groups.push({
                    id: key,
                    title: groupTitle(players[i]),
                    episodes: episodeList,
                    qualityLabel: null,
                });
            }
        }
        return groups;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var list = episodes(titleId);
        var target = null;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].number) === String(episodeId)) target = list[i];
        }
        if (target === null) throw new Error("AnimeLib could not find this episode");

        var detail = episodeDetail(target.id);
        var players = (detail && detail.players) || [];
        var links = [];
        for (var p = 0; p < players.length; p++) {
            if (String(groupKey(players[p])) !== String(groupId)) continue;
            var src = normalize(players[p].src);
            if (src === null) continue;
            links.push({
                url: src.indexOf("//") === 0 ? "https:" + src : src,
                type: /\.m3u8(\?|$)/i.test(src) ? "DIRECT_HLS" : "EMBED",
                quality: null,
                headers: { "Referer": SITE_URL },
                playerName: normalize(players[p].player),
                translation: groupTitle(players[p]),
                segments: [],
            });
        }
        if (links.length === 0) throw new Error("AnimeLib has no player for this episode");
        return links;
    },
};
