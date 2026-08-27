// AnimeGo scripted extension for Hibiki. Jsoup-heavy HTML scraper plus a couple of AJAX endpoints
// that return `{"data":{"content": "<html fragment>"}}` - the fragment is fed to
// Jsoup.parseBodyFragment. Ported from the compiled-in AnimeGoCatalogClient/AnimeGoPlaybackClient.
//
// Simplification vs. the original Kotlin: search-result description enrichment
// (`enrichSearchDescriptions`) ran with 4-way concurrency (Semaphore/async/awaitAll). Rhino's
// `fetch` is synchronous, so this port does the same enrichment sequentially - same result, just
// not concurrent (this endpoint isn't latency-critical).

function S(value) { return value === null || value === undefined ? null : String(value); }

var BASE_URL = "https://animego.me";
var MAX_RESULTS = 50;
var PAGE_SIZE = 20;
var ANIME_SLUG = /^[a-z0-9][a-z0-9-]*-\d+$/;
var ANIMEGO_ALIAS = /^!?[a-z0-9][a-z0-9+_-]*$/;
var ID_AT_END = /-(\d+)$/;
var POSTER_PROXY_URL = "https://images.weserv.nl/";

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

function getHtml(path, query) {
    var url = BASE_URL + path + (query ? ("?" + query) : "");
    var response = fetch(url, {});
    if (response.status >= 400) throw new Error("AnimeGo returned HTTP " + response.status);
    return S(response.body);
}

function ajaxJson(path, params) {
    var query = "entities=true";
    if (params) for (var key in params) query += "&" + key + "=" + encodeURIComponent(params[key]);
    var url = BASE_URL + path + "?" + query;
    var response = fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
    if (response.status >= 400) throw new Error("AnimeGo returned HTTP " + response.status);
    var body = S(response.body);
    // Some AJAX catalog pages fall back to returning the page's raw HTML rather than the
    // {"data":{"content": ...}} JSON envelope - if it doesn't parse as JSON, just use it as-is.
    var json = null;
    try { json = JSON.parse(body); } catch (ignored) { /* not JSON, treat body as raw HTML below */ }
    var data = json && json.data;
    return { html: (data && data.content) || body, endPage: !!(data && data.endPage) };
}

function toAnimeType(raw) {
    switch (String(raw || "").trim().toLowerCase()) {
        case "tvseries": case "сериал": return "tv";
        case "movie": case "фильм": return "movie";
        case "ova": return "ova";
        case "ona": return "ona";
        case "спешл": case "special": return "special";
        default: {
            var trimmed = String(raw || "").trim().toLowerCase();
            return trimmed.length > 0 ? trimmed : null;
        }
    }
}

function toStatusAlias(value) {
    var lower = value.toLowerCase();
    if (lower.indexOf("онгоинг") >= 0) return "ongoing";
    if (lower.indexOf("вышел") >= 0 || lower.indexOf("заверш") >= 0) return "released";
    if (lower.indexOf("анонс") >= 0) return "announcement";
    return value;
}

function toPosterProxyUrl(url) {
    if (!url || url.indexOf("https://img.cdngos.com/") !== 0) return null;
    return POSTER_PROXY_URL + "?url=" + encodeURIComponent(url) + "&w=500&h=700&fit=cover&output=webp";
}

function animeSlugFromUrl(url) {
    var match = /\/anime\/([^/?]+)/.exec(url || "");
    if (match === null) return null;
    return ANIME_SLUG.test(match[1]) ? match[1] : null;
}

function fieldValue(document, label) {
    var candidates = document.select("div");
    for (var i = 0; i < candidates.size(); i++) {
        var el = candidates.get(i);
        if (S(el.ownText()).trim().toLowerCase() === label.toLowerCase()) {
            var sibling = el.nextElementSibling();
            if (sibling === null) return null;
            var text = S(sibling.text()).trim();
            return text.length > 0 ? text : null;
        }
    }
    return null;
}

function parseCards(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var cards = document.select(".ani-grid__item, .ani-list__item");
    var results = [];
    var seen = {};
    for (var i = 0; i < cards.size(); i++) {
        var card = cards.get(i);
        var link = card.selectFirst(".ani-grid__item-title a[href^=/anime/], .ani-list__item-title a[href^=/anime/]");
        if (link === null) continue;
        var slug = animeSlugFromUrl(S(link.absUrl("href")));
        if (slug === null || seen[slug]) continue;

        var genreEls = card.select(".ani-grid__item-genres__link, .ani-list__item-genres__link");
        var metadata = [];
        for (var g = 0; g < genreEls.size(); g++) metadata.push(S(genreEls.get(g).text()).trim());

        var titleAttr = S(link.attr("title")).trim();
        var russianName = titleAttr.length > 0 ? titleAttr : S(link.text()).trim();
        if (russianName.length === 0) continue;

        var originalEl = card.selectFirst(".ani-grid__item-body > .fw-lighter, .ani-list__item-body > .fw-lighter");
        var originalName = originalEl !== null ? S(originalEl.text()).trim() : "";
        if (originalName.length === 0) originalName = russianName;

        var ratingEl = card.selectFirst(".rating-badge");
        var ratings = [];
        if (ratingEl !== null) {
            var ratingValue = parseFloat(S(ratingEl.text()).replace(",", "."));
            if (!isNaN(ratingValue)) ratings.push({ source: "AnimeGo", value: ratingValue, votes: null });
        }

        var posterEl = card.selectFirst(".ani-grid__item-picture img[src], .ani-list__item-picture img[src]");
        var sourcePosterUrl = posterEl !== null ? S(posterEl.absUrl("src")) : null;
        var posterUrl = sourcePosterUrl !== null ? (toPosterProxyUrl(sourcePosterUrl) || sourcePosterUrl) : null;

        var year = null;
        for (var m = 0; m < metadata.length; m++) {
            var parsedYear = parseInt(metadata[m], 10);
            if (!isNaN(parsedYear) && String(parsedYear) === metadata[m]) { year = parsedYear; break; }
        }

        var descriptionEl = card.selectFirst(".ani-list__item-description");
        var description = descriptionEl !== null ? S(descriptionEl.text()).trim() : null;
        if (description !== null && description.length === 0) description = null;

        seen[slug] = true;
        results.push(title({
            id: slug,
            russianName: russianName,
            englishName: originalName !== russianName ? originalName : null,
            originalName: originalName,
            year: year,
            type: metadata.length > 0 ? toAnimeType(metadata[0]) : null,
            posterUrl: posterUrl,
            description: description,
            ratings: ratings,
            posterFallbackUrl: sourcePosterUrl !== null && sourcePosterUrl !== posterUrl ? sourcePosterUrl : null,
        }));
    }
    return results;
}

function parseDetails(id, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var scripts = document.select("script[type=application/ld+json]");
    var schema = null;
    for (var i = 0; i < scripts.size(); i++) {
        try {
            var parsed = JSON.parse(S(scripts.get(i).data()));
            if (parsed && (parsed["@type"] === "TVSeries" || parsed["@type"] === "Movie")) { schema = parsed; break; }
        } catch (ignored) { /* not JSON, skip */ }
    }
    if (schema === null) throw new Error("AnimeGo details schema is missing for " + id);

    var name = S((document.selectFirst("h1") || {}).text ? document.selectFirst("h1").text() : "").trim();
    var originalName = schema.alternateName || schema.name || name;
    if (!name || !originalName) throw new Error("AnimeGo details title is missing for " + id);

    var rating = schema.aggregateRating;
    var episodeText = fieldValue(document, "Эпизоды");
    var sourcePosterUrl = schema.image || null;
    var posterUrl = sourcePosterUrl !== null ? (toPosterProxyUrl(sourcePosterUrl) || sourcePosterUrl) : null;

    var synonymEls = document.select(".entity__title-synonyms li");
    var synonyms = [];
    for (var s = 0; s < synonymEls.size(); s++) {
        var syn = S(synonymEls.get(s).text()).trim();
        if (syn.length > 0) synonyms.push(syn);
    }

    var genres = Array.isArray(schema.genre) ? schema.genre.filter(function (g) { return g && String(g).trim().length > 0; }) : [];
    var ratings = [];
    if (rating && rating.ratingValue) ratings.push({ source: "AnimeGo", value: rating.ratingValue, votes: rating.ratingCount || null });

    var statusText = fieldValue(document, "Статус");
    var availableEpisodeCount = null;
    if (episodeText) {
        var parsedAvailable = parseInt(episodeText.split("/")[0].trim(), 10);
        if (!isNaN(parsedAvailable)) availableEpisodeCount = parsedAvailable;
    }

    var descriptionEl = document.selectFirst(".description");
    var description = schema.description || (descriptionEl !== null ? S(descriptionEl.text()).trim() : null);

    return title({
        id: id,
        russianName: name,
        englishName: originalName !== name ? originalName : null,
        originalName: originalName,
        synonyms: synonyms,
        year: schema.datePublished ? parseInt(String(schema.datePublished).substring(0, 4), 10) : null,
        type: toAnimeType(schema["@type"]),
        episodeCount: typeof schema.numberOfEpisodes === "number" ? schema.numberOfEpisodes : null,
        posterUrl: posterUrl,
        status: statusText ? toStatusAlias(statusText.toLowerCase()) : null,
        description: description,
        genres: genres,
        ratings: ratings,
        ageRating: schema.contentRating || null,
        sourceMaterial: fieldValue(document, "Первоисточник"),
        studios: schema.productionCompany && schema.productionCompany.name ? [schema.productionCompany.name] : [],
        availableEpisodeCount: availableEpisodeCount,
        posterFallbackUrl: sourcePosterUrl !== null && sourcePosterUrl !== posterUrl ? sourcePosterUrl : null,
    });
}

function pathAliases(list) {
    var seen = {};
    var result = [];
    for (var i = 0; i < (list || []).length; i++) {
        var value = String(list[i]).trim().toLowerCase();
        if (!ANIMEGO_ALIAS.test(value) || seen[value]) continue;
        seen[value] = true;
        result.push(value);
    }
    return result;
}

function toFilterPath(request) {
    var segments = [];
    if (request.yearFrom && request.yearTo) segments.push("year-from-" + request.yearFrom + "-to-" + request.yearTo);
    else if (request.yearFrom) segments.push("year-from-" + request.yearFrom);
    else if (request.yearTo) segments.push("year-to-" + request.yearTo);

    var genreList = (request.includedGenreAliases || []).concat((request.excludedGenreAliases || []).map(function (g) {
        return "!" + String(g).replace(/^!/, "");
    }));
    var genres = pathAliases(genreList);
    if (genres.length > 0) segments.push("genres-is-" + genres.join("-or-"));

    var types = pathAliases(request.typeAliases);
    if (types.length > 0) segments.push("type-is-" + types.join("-or-"));

    var statuses = pathAliases(request.statusAliases);
    if (statuses.length > 0) segments.push("status-is-" + statuses.join("-or-"));

    return segments.length === 0 ? "/anime" : "/anime/filter/" + segments.join("/") + "/apply";
}

function toAnimeGoSort(sort) {
    if (sort === "YEAR") return { sort: "startDate", direction: "desc" };
    if (sort === "RATING") return { sort: "rating", direction: "desc" };
    return { sort: "createdAt", direction: "asc" };
}

function collectCatalogPages(request, limit) {
    var firstPage = Math.floor(Math.max(request.offset || 0, 0) / PAGE_SIZE) + 1;
    var page = firstPage;
    var skip = Math.max(request.offset || 0, 0) % PAGE_SIZE;
    var result = [];
    var seen = {};
    var basePath = toFilterPath(request);
    var sortInfo = toAnimeGoSort(request.sort);
    while (result.length < limit) {
        var path = page === 1 ? basePath : (basePath + "/" + page);
        var pageResponse = ajaxJson(path, sortInfo);
        var cards = parseCards(pageResponse.html);
        for (var i = skip; i < cards.length && result.length < limit; i++) {
            if (seen[cards[i].id]) continue;
            seen[cards[i].id] = true;
            result.push(cards[i]);
        }
        skip = 0;
        if (pageResponse.endPage || cards.length === 0) break;
        page += 1;
    }
    return result;
}

function enrichSearchDescriptions(titles) {
    return titles.map(function (summary) {
        try {
            var details = Provider.getById(summary.id);
            return (details.description && details.description.length > 0) ? details : summary;
        } catch (ignored) {
            return summary;
        }
    });
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var query = (request.query || "").trim();
        if (query.length > 0) {
            var results = parseCards(getHtml("/search/all", "q=" + encodeURIComponent(query)))
                .slice(Math.max(request.offset || 0, 0), Math.max(request.offset || 0, 0) + limit);
            return enrichSearchDescriptions(results);
        }
        return collectCatalogPages(request, limit);
    },

    latest: function (limit) {
        return parseCards(getHtml("/anime", null)).slice(0, Math.min(Math.max(limit || 20, 1), MAX_RESULTS));
    },

    getById: function (id) {
        var slug = String(id).trim();
        if (!ANIME_SLUG.test(slug)) throw new Error("AnimeGo title id is invalid: " + id);
        return parseDetails(slug, getHtml("/anime/" + slug, null));
    },

    getSettings: function () {
        var document = Jsoup.parse(getHtml("/anime", null), BASE_URL);
        return {
            sortOptions: [
                { id: "relevance", title: "date added" },
                { id: "year", title: "newest" },
                { id: "rating", title: "rating" },
            ],
            typeOptions: filterOptions(document, "type_"),
            statusOptions: filterOptions(document, "status_"),
            genreOptions: filterOptions(document, "genres_").filter(function (o) { return o.id.indexOf("!") !== 0; }),
        };
    },

    getPlaybackGroups: function (titleId) {
        var idMatch = ID_AT_END.exec(titleId);
        if (idMatch === null) throw new Error("AnimeGo title id has no numeric suffix: " + titleId);
        var content = ajaxPlayer("/player/" + idMatch[1]);
        var items = Jsoup.parseBodyFragment(content).select(".player-video-bar__item[data-episode]");
        var episodes = [];
        var seen = {};
        for (var i = 0; i < items.size(); i++) {
            var el = items.get(i);
            var episodeId = S(el.attr("data-episode"));
            if (!episodeId || seen[episodeId]) continue;
            var numberAttr = S(el.attr("data-episode-number"));
            var number = numberAttr ? parseFloat(numberAttr) : NaN;
            if (isNaN(number)) {
                var numberEl = el.selectFirst(".player-video-bar__number");
                number = numberEl !== null ? parseFloat(S(numberEl.text()).trim()) : NaN;
            }
            if (isNaN(number)) continue;
            seen[episodeId] = true;
            episodes.push({ id: episodeId, number: number, title: S(el.attr("data-episode-title")) || null });
        }
        if (episodes.length === 0) return [];
        return [{ id: titleId, title: "AnimeGo", episodes: episodes, qualityLabel: null }];
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var content = ajaxPlayer("/player/videos/" + episodeId);
        var items = Jsoup.parseBodyFragment(content).select("[data-player]");
        var links = [];
        for (var i = 0; i < items.size(); i++) {
            var el = items.get(i);
            var rawUrl = S(el.attr("data-player"));
            if (!rawUrl) continue;
            links.push({
                url: Jsoup.resolve(BASE_URL, rawUrl), type: "EMBED", quality: null,
                headers: { "Referer": BASE_URL + "/" },
                playerName: S(el.attr("data-provider-title")) || null,
                translation: S(el.attr("data-translation-title")) || null,
                segments: [], videoId: null,
            });
        }
        links.sort(function (a, b) { return playerPriority(a.playerName) - playerPriority(b.playerName); });
        return links;
    },
};

function ajaxPlayer(path) {
    var response = fetch(BASE_URL + path, {
        headers: { "X-Requested-With": "XMLHttpRequest", "Referer": BASE_URL + "/" },
    });
    if (response.status >= 400) throw new Error("AnimeGo returned HTTP " + response.status);
    var json = JSON.parse(S(response.body));
    return json.data.content;
}

function filterOptions(document, namePrefix) {
    var inputs = document.select("input[name^=" + namePrefix + "][value]");
    var options = [];
    var seen = {};
    for (var i = 0; i < inputs.size(); i++) {
        var input = inputs.get(i);
        var id = S(input.attr("value")).trim();
        if (id.length === 0 || seen[id]) continue;
        seen[id] = true;
        var formCheck = input.closest(".form-check");
        var labelEl = formCheck !== null ? formCheck.selectFirst("label") : null;
        var labelText = labelEl !== null ? S(labelEl.text()).trim() : "";
        var title = labelText.length > 0 ? labelText : (S(input.attr("data-text")).trim() || id);
        options.push({ id: id, title: title });
    }
    return options;
}

function playerPriority(name) {
    switch (String(name || "").toLowerCase()) {
        case "aniboom": return 0;
        case "cvh": return 1;
        case "kodik": return 2;
        case "sibnet": return 3;
        default: return 10;
    }
}
