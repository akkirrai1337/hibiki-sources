// AnimeVost scripted extension for Hibiki.
//
// Runs inside a sandboxed Rhino interpreter (see RhinoExtensionRuntime.kt). The only globals
// available are `Jsoup` (HTML parsing), `fetch` (network, synchronous - no Promises here since
// Rhino has no native async/await) and `console`. `Jsoup.parse(...)` returns a real Jsoup
// `Document`/`Element` - call its Java methods directly (`.select()`, `.size()`, `.get(i)`, ...)
// rather than JS array sugar, since these are plain Java objects via LiveConnect. IMPORTANT: any
// String returned by a Jsoup/Java method call (`.text()`, `.attr()`, `.absUrl()`, `Jsoup.resolve`)
// comes back as a boxed Java object, not a JS string primitive - `typeof` on it is "object" and
// `===`/`charAt`/regex behave incorrectly on it. Always wrap such values with the `S()` helper
// below (a thin `String(...)` coercion) before doing any JS-side string work on them.
//
// Ported from the compiled-in Kotlin AnimeVostCatalogClient/AnimeVostPlaybackClient. Porting also
// fixes the catalog-description bug: the old Kotlin heuristic rejected every <p> that contained a
// <strong> tag, which happens to also reject the real description paragraph
// (`<p><strong>Описание: </strong>...</p>`). This version reads it the same way it reads every
// other labeled field (Год выхода, Тип, Жанр, ...): by matching the <strong> label text.

function S(value) {
    return value === null || value === undefined ? null : String(value);
}

var BASE_URL = "https://animevost.org";
var API_BASE_URL = "https://api.animevost.org";
var BROWSER_USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";
var MAX_RESULTS = 50;
var LISTING_PAGE_SIZE = 10;

var TITLE_PATH = /^tip\/[a-z-]+\/\d+-[^/]+\.html$/;
var EPISODE_COUNT = /\[\s*\d+\s+из\s+(\d+)/;
var EPISODE_PROGRESS = /\[\s*(?:\d+\s*-\s*)?(\d+)\s+из\s+(\d+)/;
var NEXT_EPISODE_DATE = /\[\s*\d+\s+серия\s*-\s*(\d{1,2})\s+([а-яё]+)/;
var YEAR_PATH = /\/god\/(\d{4})\//;
var BACKGROUND_IMAGE = /background-image:\s*url\(['"]?([^'")]+)/;
var TITLE_ID = /\/?(?:tip\/[a-z-]+\/)?(\d+)-[^/]+\.html/;
var EPISODE_NUMBER = /^\s*(\d+(?:[.,]\d+)?)/;

var RUSSIAN_MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4,
    "мая": 5, "июня": 6, "июля": 7, "августа": 8,
    "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
};

/** Fills in every AnimeTitle field so the Kotlin-side JSON decode always sees a complete object. */
function title(fields) { return AnimeTitle(fields); }

function getHtml(path, options) {
    options = options || {};
    var response = fetch(BASE_URL.replace(/\/$/, "") + path, {
        method: options.method || "GET",
        headers: {
            "User-Agent": BROWSER_USER_AGENT,
            "Referer": BASE_URL.replace(/\/$/, "") + "/",
        },
        form: options.form,
    });
    if (!response.ok) throw new Error("AnimeVost returned HTTP " + response.status);
    return S(response.body);
}

/** Mirrors AnimeVostCatalogClient.fieldValue: reads a `<p><strong>Label: </strong>value</p>` row. */
function fieldValue(element, label) {
    var paragraphs = element.select("p");
    for (var i = 0; i < paragraphs.size(); i++) {
        var p = paragraphs.get(i);
        var strong = p.selectFirst("strong");
        if (strong === null) continue;
        var strongText = S(strong.text());
        var normalized = strongText.replace(/:\s*$/, "").trim();
        if (normalized !== label) continue;
        var full = S(p.text());
        var rest = full.indexOf(strongText) === 0 ? full.substring(strongText.length) : full;
        var trimmed = rest.trim();
        if (trimmed.length > 0) return trimmed;
    }
    return null;
}

function toType(raw) {
    switch (String(raw).trim().toLowerCase()) {
        case "тв": return "tv";
        case "ova": return "ova";
        case "ona": return "ona";
        case "полнометражный фильм": return "movie";
        default: return String(raw).trim().toLowerCase();
    }
}

function parseCards(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var cards = document.select(".shortstory, article.post");
    var results = [];
    var seenIds = {};
    for (var i = 0; i < cards.size(); i++) {
        var card = cards.get(i);
        var link = card.selectFirst(".shortstoryHead h1 a[href*=/tip/], .shortstoryHead h2 a[href*=/tip/]");
        if (link === null) link = card.selectFirst("span > a[href*=/tip/]");
        if (link === null) continue;

        var href = S(link.absUrl("href"));
        var id = href.substring(BASE_URL.length);
        var qIndex = id.indexOf("?");
        if (qIndex >= 0) id = id.substring(0, qIndex);
        if (id.charAt(0) === "/") id = id.substring(1);
        if (!TITLE_PATH.test(id)) continue;
        if (seenIds[id]) continue;

        var rawName = S(link.text()).trim();
        if (rawName.length === 0) {
            var h2 = card.selectFirst("h2");
            rawName = h2 !== null ? S(h2.text()).trim() : "";
        }
        if (rawName.length === 0) continue;

        var namesRaw = rawName.split("[")[0].trim();
        var names = namesRaw.split("/").map(function (part) { return part.trim(); });
        var russianName = names[0];
        if (!russianName) continue;

        var content = card.selectFirst(".shortstoryContent");
        if (content === null) content = card;
        var h4 = content.selectFirst("h4");
        var originalName = h4 !== null ? S(h4.text()).trim() : "";

        var categories = content.select(".short-categori a");
        var categoryHrefs = [];
        for (var c = 0; c < categories.size(); c++) categoryHrefs.push(S(categories.get(c).absUrl("href")));

        var year = null;
        var yearField = fieldValue(content, "Год выхода");
        if (yearField !== null) year = parseInt(yearField.substring(0, 4), 10);
        if (year === null || isNaN(year)) {
            year = null;
            for (var y = 0; y < categoryHrefs.length; y++) {
                var yearMatch = YEAR_PATH.exec(categoryHrefs[y]);
                if (yearMatch !== null) { year = parseInt(yearMatch[1], 10); break; }
            }
        }

        var type = null;
        var typeField = fieldValue(content, "Тип");
        if (typeField !== null) type = toType(typeField);
        if (type === null) {
            for (var t = 0; t < categories.size(); t++) {
                if (S(categories.get(t).absUrl("href")).indexOf("/tip/") >= 0) { type = toType(S(categories.get(t).text())); break; }
            }
        }

        var episodeCount = null;
        var episodeMatch = EPISODE_COUNT.exec(rawName);
        if (episodeMatch !== null) episodeCount = parseInt(episodeMatch[1], 10);

        var posterUrl = null;
        var poster = content.selectFirst("img.imgRadius");
        if (poster !== null) posterUrl = S(poster.absUrl("src"));
        if (!posterUrl) {
            var bgMatch = BACKGROUND_IMAGE.exec(S(card.attr("style")));
            if (bgMatch !== null) posterUrl = S(Jsoup.resolve(BASE_URL, bgMatch[1]));
        }

        var status = null;
        for (var s = 0; s < categoryHrefs.length; s++) {
            if (categoryHrefs[s].indexOf("/ongoing/") >= 0) { status = "ongoing"; break; }
        }

        var description = fieldValue(content, "Описание");

        var genres = [];
        var genreField = fieldValue(content, "Жанр");
        if (genreField !== null) {
            genres = genreField.split(",").map(function (g) { return g.trim(); }).filter(function (g) { return g.length > 0; });
        } else {
            for (var g2 = 0; g2 < categories.size(); g2++) {
                if (S(categories.get(g2).absUrl("href")).indexOf("/zhanr/") >= 0) genres.push(S(categories.get(g2).text()));
            }
        }

        seenIds[id] = true;
        results.push(title({
            id: id,
            russianName: russianName,
            englishName: names.length > 1 ? names[1] : null,
            originalName: originalName || names[1] || russianName,
            year: year,
            type: type,
            episodeCount: episodeCount,
            posterUrl: posterUrl,
            status: status,
            description: description,
            genres: genres,
        }));
    }
    return results;
}

function parseNextEpisodeAt(rawName) {
    var match = NEXT_EPISODE_DATE.exec(rawName);
    if (match === null) return null;
    var day = parseInt(match[1], 10);
    var month = RUSSIAN_MONTHS[match[2].toLowerCase()];
    if (!month) return null;
    var now = new Date();
    var year = now.getUTCFullYear();
    var candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
        candidate = new Date(Date.UTC(year + 1, month - 1, day));
    }
    return Math.floor(candidate.getTime() / 1000);
}

function parseDetails(path, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var heading = document.selectFirst(".playerTitle h1, h1");
    if (heading === null) return null;
    var rawName = S(heading.text()).trim();
    if (rawName.length === 0) return null;

    var namesRaw = rawName.split("[")[0].trim();
    var names = namesRaw.split("/").map(function (part) { return part.trim(); });
    var russianName = names[0];
    if (!russianName) return null;

    var progress = EPISODE_PROGRESS.exec(rawName);
    var availableEpisodes = progress !== null ? parseInt(progress[1], 10) : null;
    var totalEpisodes = progress !== null ? parseInt(progress[2], 10) : null;
    var nextEpisodeAt = parseNextEpisodeAt(rawName);

    var posterMeta = document.selectFirst("meta[property='og:image']");
    var posterUrl = null;
    if (posterMeta !== null) {
        var content = S(posterMeta.attr("content")).trim();
        if (content.length > 0) posterUrl = S(Jsoup.resolve(BASE_URL, content));
    }

    var status = null;
    if (nextEpisodeAt !== null) status = "ongoing";
    else if (availableEpisodes !== null && totalEpisodes !== null && availableEpisodes < totalEpisodes) status = "ongoing";
    else if (totalEpisodes !== null) status = "released";

    var descriptionMeta = document.selectFirst("meta[property='og:description']");
    var description = null;
    if (descriptionMeta !== null) {
        var descriptionContent = S(descriptionMeta.attr("content")).trim();
        if (descriptionContent.length > 0) description = descriptionContent;
    }

    var typeSegment = path.split("tip/")[1];
    var type = typeSegment ? toType(typeSegment.split("/")[0]) : null;

    return title({
        id: path,
        russianName: russianName,
        englishName: names.length > 1 ? names[1] : null,
        originalName: names.length > 1 ? names[1] : russianName,
        type: type,
        episodeCount: totalEpisodes,
        posterUrl: posterUrl,
        status: status,
        description: description,
        nextEpisodeAt: nextEpisodeAt,
        availableEpisodeCount: availableEpisodes,
    });
}

function fetchLatestPage(page) {
    return parseCards(getHtml(page === 1 ? "/" : "/page/" + page + "/"));
}

function sortForm(sort) {
    var field = "date";
    var direction = "desc";
    switch (String(sort || "RELEVANCE").trim().toUpperCase()) {
        case "TITLE": field = "title"; direction = "asc"; break;
        case "RATING": field = "rating"; break;
        case "VIEWS": field = "news_read"; break;
        case "COMMENTS": field = "comm_num"; break;
    }
    return {
        dlenewssortby: field,
        dledirection: direction,
        set_new_sort: "dle_sort_main",
        set_direction_sort: "dle_direction_main",
    };
}

function latestInternal(offset, limit, sort) {
    var requestedLimit = Math.min(Math.max(limit, 1), MAX_RESULTS);
    var page = Math.floor(Math.max(offset, 0) / LISTING_PAGE_SIZE) + 1;
    var skip = Math.max(offset, 0) % LISTING_PAGE_SIZE;
    var result = [];
    var seen = {};
    // AnimeVost stores the selected ordering in the PHP session. The shared HTTP client retains
    // that cookie, so configure the sort once before reading any requested catalog page.
    var sortedFirstPage = parseCards(getHtml("/", { method: "POST", form: sortForm(sort) }));
    while (result.length < requestedLimit) {
        var cards = page === 1 ? sortedFirstPage : fetchLatestPage(page);
        if (cards.length === 0) break;
        for (var i = skip; i < cards.length && result.length < requestedLimit; i++) {
            if (seen[cards[i].id]) continue;
            seen[cards[i].id] = true;
            result.push(cards[i]);
        }
        if (cards.length < LISTING_PAGE_SIZE) break;
        page += 1;
        skip = 0;
    }
    return result;
}

function playlist(titleId) {
    var match = TITLE_ID.exec(titleId);
    if (match === null) throw new Error("AnimeVost title id is invalid: " + titleId);
    var response = fetch(API_BASE_URL.replace(/\/$/, "") + "/v1/playlist", {
        method: "POST",
        headers: {
            "User-Agent": BROWSER_USER_AGENT,
            "Referer": BASE_URL.replace(/\/$/, "") + "/",
        },
        form: { id: match[1] },
    });
    if (!response.ok) throw new Error("AnimeVost playlist returned HTTP " + response.status);
    var items = JSON.parse(S(response.body));
    var result = [];
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var name = item.name ? String(item.name).trim() : "";
        if (name.length === 0) continue;
        result.push({
            name: name,
            standard: item.std ? String(item.std).trim() : null,
            hd: item.hd ? String(item.hd).trim() : null,
        });
    }
    return result;
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

// The site has no filter form: its filters are category pages (/zhanr/<genre>/, /tip/<type>/,
// /god/<year>/, /ongoing/), and a page can only be one of them. So one filter picks the page to
// read - genre first, then type, ongoing, then year - and every other selected filter is applied to
// the cards that page returns. Genre slugs were checked against the live site (senen-ay is a 404
// there and is left out).
var GENRE_OPTIONS = [
    ["boyevyye-iskusstva", "Боевые искусства"], ["voyna", "Война"], ["drama", "Драма"], ["detektiv", "Детектив"],
    ["istoriya", "История"], ["komediya", "Комедия"], ["mistika", "Мистика"], ["mekha", "Меха"],
    ["makho-sedze", "Махо-сёдзё"], ["muzykalnyy", "Музыкальный"], ["povsednevnost", "Повседневность"],
    ["priklyucheniya", "Приключения"], ["parodiya", "Пародия"], ["romantika", "Романтика"], ["senen", "Сёнэн"],
    ["sedze", "Сёдзё"], ["sport", "Спорт"], ["skazka", "Сказка"], ["sedze-ay", "Сёдзё-ай"], ["samurai", "Самураи"],
    ["triller", "Триллер"], ["uzhasy", "Ужасы"], ["fantastika", "Фантастика"], ["fentezi", "Фэнтези"],
    ["shkola", "Школа"], ["etti", "Этти"],
].map(function (pair) { return { id: pair[0], title: pair[1] }; });

var SORT_FILTER_OPTIONS = [
    { id: "date", title: "По дате" },
    { id: "rating", title: "По популярности" },
    { id: "title", title: "По алфавиту" },
    { id: "views", title: "По просмотрам" },
    { id: "comments", title: "По комментариям" },
];
var SORT_FILTER_TO_ENUM = { date: "RELEVANCE", rating: "RATING", title: "TITLE", views: "VIEWS", comments: "COMMENTS" };
var MAX_FILTER_YEARS = 10;

var cachedGenreOptions = null;

// /zhanr/ lists every genre the site has; the built-in list above is the fallback if it can't be read.
function liveGenreOptions() {
    if (cachedGenreOptions !== null) return cachedGenreOptions;
    try {
        var links = Jsoup.parse(getHtml("/zhanr/"), BASE_URL).select("a[href*='/zhanr/']");
        var options = [];
        var seen = {};
        for (var i = 0; i < links.size(); i++) {
            var match = /\/zhanr\/([^/?#]+)\/?$/.exec(S(links.get(i).attr("href")));
            var label = S(links.get(i).text()).trim();
            if (!match || !label || seen[match[1]]) continue;
            seen[match[1]] = true;
            options.push({ id: match[1], title: label });
        }
        if (options.length > 0) return (cachedGenreOptions = options);
    } catch (ignored) { /* fall back below */ }
    return GENRE_OPTIONS;
}

function siteFilters() {
    return [
        { id: "sort", title: "Sort", type: "select", options: SORT_FILTER_OPTIONS },
        { id: "genres", title: "Genres", type: "select", options: liveGenreOptions() },
        { id: "type", title: "Type", type: "select", options: [{ id: "tv", title: "ТВ" }, { id: "ova", title: "OVA" }, { id: "ona", title: "ONA" }] },
        { id: "status", title: "Status", type: "select", options: [{ id: "ongoing", title: "Онгоинг" }] },
        { id: "year", title: "Year", type: "range", min: 1990, max: new Date().getFullYear() },
    ];
}

function hasSiteFilters(filters) {
    if (!filters) return false;
    var year = span(filters, "year");
    return picked(filters, "genres").length + picked(filters, "type").length + picked(filters, "status").length > 0 ||
        !!year.from || !!year.to;
}

function sortEnumFor(request) {
    var chosen = picked(request.filters, "sort")[0];
    return chosen ? SORT_FILTER_TO_ENUM[chosen] : request.sort;
}

function filterPaths(filters) {
    var genre = picked(filters, "genres")[0];
    if (genre) return ["/zhanr/" + encodeURIComponent(genre) + "/"];
    var type = picked(filters, "type")[0];
    if (type) return ["/tip/" + encodeURIComponent(type) + "/"];
    if (picked(filters, "status")[0] === "ongoing") return ["/ongoing/"];
    var year = span(filters, "year");
    if (year.from || year.to) {
        var to = year.to || year.from;
        var from = year.from || year.to;
        var paths = [];
        for (var y = Math.max(from, to - MAX_FILTER_YEARS + 1); y <= to; y++) paths.unshift("/god/" + y + "/");
        return paths;
    }
    return ["/"];
}

// What the page itself could not narrow. Genre is always the page when set, so it is only checked
// here for text-search results, which are not restricted to any page.
function cardMatches(card, filters) {
    var type = picked(filters, "type")[0];
    if (type && card.type !== type) return false;
    if (picked(filters, "status")[0] === "ongoing" && card.status !== "ongoing") return false;
    var year = span(filters, "year");
    if (year.from && (card.year === null || card.year < year.from)) return false;
    if (year.to && (card.year === null || card.year > year.to)) return false;
    var genre = picked(filters, "genres")[0];
    if (genre) {
        var wanted = liveGenreOptions().filter(function (option) { return option.id === genre; })[0];
        if (wanted && card.genres.indexOf(wanted.title) < 0) return false;
    }
    return true;
}

function filteredInternal(request) {
    var filters = request.filters;
    var offset = Math.max(request.offset || 0, 0);
    var wanted = offset + Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
    // The chosen order lives in the PHP session (see latestInternal), so set it before paging.
    getHtml("/", { method: "POST", form: sortForm(sortEnumFor(request)) });
    var results = [];
    var seen = {};
    var paths = filterPaths(filters);
    for (var p = 0; p < paths.length && results.length < wanted; p++) {
        for (var page = 1; page <= 30 && results.length < wanted; page++) {
            var cards;
            try {
                cards = parseCards(getHtml(page === 1 ? paths[p] : paths[p] + "page/" + page + "/"));
            } catch (e) {
                // A category with N full pages answers HTTP 404 for page N+1 (and an empty one for page 1): that is its end.
                if (String(e && e.message).indexOf("HTTP 404") < 0) throw e;
                break;
            }
            if (cards.length === 0) break;
            for (var i = 0; i < cards.length && results.length < wanted; i++) {
                var card = cards[i];
                if (seen[card.id] || !cardMatches(card, filters)) continue;
                seen[card.id] = true;
                results.push(card);
            }
            if (cards.length < LISTING_PAGE_SIZE) break;
        }
    }
    return results.slice(offset, wanted);
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var trimmed = (request.query || "").trim();
        var filtered = hasSiteFilters(request.filters);
        if (trimmed.length === 0) {
            if (filtered) return filteredInternal(request);
            return latestInternal(request.offset || 0, request.limit || 20, sortEnumFor(request));
        }
        // Keep full-text results in the same order selected by the catalog controls.
        getHtml("/", { method: "POST", form: sortForm(sortEnumFor(request)) });
        var results = parseCards(getHtml("/xfsearch/" + encodeURIComponent(trimmed) + "/"));
        // Text search cannot be restricted to a category page, so filters narrow its results instead.
        if (filtered) results = results.filter(function (card) { return cardMatches(card, request.filters); });
        var start = Math.max(request.offset || 0, 0);
        var end = start + Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        return results.slice(start, end);
    },

    latest: function (limit) {
        return latestInternal(0, limit || 20, "RELEVANCE");
    },

    getSettings: function () {
        return {
            sortOptions: [
                { id: "relevance", title: "По дате" },
                { id: "rating", title: "По популярности" },
                { id: "title", title: "По алфавиту" }
            ],
            filters: siteFilters()
        };
    },

    getById: function (id) {
        var path = String(id).trim();
        if (!TITLE_PATH.test(path)) throw new Error("AnimeVost title id is invalid: " + id);
        var html = getHtml("/" + path);
        var cards = parseCards(html);
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].id === path) return cards[i];
        }
        var details = parseDetails(path, html);
        if (details === null) throw new Error("AnimeVost title was not found: " + id);
        return details;
    },

    getPlaybackGroups: function (titleId) {
        var items = playlist(titleId);
        var episodes = [];
        for (var i = 0; i < items.length; i++) {
            var numberMatch = EPISODE_NUMBER.exec(items[i].name);
            episodes.push({
                id: titleId + ":" + i,
                number: numberMatch !== null ? parseFloat(numberMatch[1].replace(",", ".")) : i + 1,
                title: items[i].name,
            });
        }
        if (episodes.length === 0) return [];
        return [{ id: titleId, title: "AnimeVost", episodes: episodes, qualityLabel: null }];
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var parts = episodeId.split(":");
        var index = parseInt(parts[parts.length - 1], 10);
        var episodeTitleId = parts.slice(0, parts.length - 1).join(":");
        var items = playlist(episodeTitleId);
        var item = items[index];
        if (!item) throw new Error("AnimeVost episode is unavailable: " + episodeId);
        var referer = { "Referer": BASE_URL.replace(/\/$/, "") + "/" };
        var links = [];
        var seen = {};
        if (item.hd) {
            links.push({ url: item.hd, type: "DIRECT_MP4", quality: "720p", headers: referer, playerName: "AnimeVost", translation: null, segments: [], videoId: null });
            seen[item.hd] = true;
        }
        if (item.standard && !seen[item.standard]) {
            links.push({ url: item.standard, type: "DIRECT_MP4", quality: "480p", headers: referer, playerName: "AnimeVost", translation: null, segments: [], videoId: null });
        }
        return links;
    },
};
