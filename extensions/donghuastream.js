// DonghuaStream scripted extension for Hibiki. Same WP theme family as animekhor.js (`.bsx`,
// `.eplister`, `.spe`, base64-encoded `<select class="mirror">` options) - see that file's header
// for the shared markup notes. The one real difference here: poster images are lazy-loaded behind
// a placeholder SVG `src`, with the actual URL in `data-src`, so posters read that first.

function S(value) { return value === null || value === undefined ? null : String(value); }

var BASE_URL = "https://donghuastream.org";
var MAX_RESULTS = 50;
var LISTING_PAGE_SIZE = 20;

var ANIME_PATH = /^anime\/([^/]+)\/?$/;
var YEAR_IN_TEXT = /(\d{4})/;

/** Fills in every AnimeTitle field so the Kotlin-side JSON decode always sees a complete object. */
function title(fields) { return AnimeTitle(fields); }

function getHtml(path) {
    var response = fetch(BASE_URL + path, {
        headers: { "Accept": "text/html,application/xhtml+xml", "Referer": BASE_URL + "/" },
    });
    if (!response.ok) throw new Error("DonghuaStream returned HTTP " + response.status + " for " + path);
    return S(response.body);
}

function idFromHref(href) {
    if (href.indexOf(BASE_URL) === 0) href = href.substring(BASE_URL.length);
    if (href.charAt(0) === "/") href = href.substring(1);
    var match = ANIME_PATH.exec(href);
    return match !== null ? match[1] : null;
}

/** Lazy-loaded cards/poster images serve a placeholder SVG as `src` and the real URL in
 * `data-src` - prefer the latter whenever it's present. */
function imageUrl(img) {
    if (img === null) return null;
    var lazy = S(img.attr("data-src")).trim();
    if (lazy.length > 0) return S(img.absUrl("data-src"));
    return S(img.absUrl("src"));
}

function toType(raw) {
    return raw ? raw.trim().toLowerCase() : null;
}

function toStatus(raw) {
    if (!raw) return null;
    var normalized = raw.trim().toLowerCase();
    if (normalized.indexOf("ongoing") >= 0) return "ongoing";
    if (normalized.indexOf("completed") >= 0) return "released";
    return normalized;
}

/** Mirrors a `<span><b>Label:</b> value</span>` row inside `.spe` (this theme's info-table format). */
function speField(document, label) {
    var spans = document.select(".spe span");
    for (var i = 0; i < spans.size(); i++) {
        var span = spans.get(i);
        var bold = span.selectFirst("b");
        if (bold === null) continue;
        var boldText = S(bold.text());
        var normalized = boldText.replace(/:\s*$/, "").trim().toLowerCase();
        if (normalized !== label.toLowerCase()) continue;
        var full = S(span.text());
        var rest = full.indexOf(boldText) === 0 ? full.substring(boldText.length) : full;
        var trimmed = rest.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

function parseCard(article) {
    var link = article.selectFirst(".bsx > a, a");
    if (link === null) return null;
    var href = S(link.absUrl("href"));
    var id = idFromHref(href);
    if (id === null) return null;

    var heading = article.selectFirst(".tt h2");
    var name = heading !== null ? S(heading.text()).trim() : S(link.attr("oldtitle") || link.attr("title")).trim();
    if (name.length === 0) return null;

    var posterUrl = imageUrl(article.selectFirst("img"));

    var type = toType(article.selectFirst(".limit .typez") !== null ? S(article.selectFirst(".limit .typez").text()) : null);
    var statusBadge = article.selectFirst(".bt .epx");
    var status = statusBadge !== null ? toStatus(S(statusBadge.text())) : null;

    return title({
        id: id,
        englishName: name,
        originalName: name,
        posterUrl: posterUrl,
        type: type,
        status: status,
    });
}

function parseCardList(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var articles = document.select("article.bs, article.status");
    var results = [];
    var seen = {};
    for (var i = 0; i < articles.size(); i++) {
        var parsed = parseCard(articles.get(i));
        if (parsed === null || seen[parsed.id]) continue;
        seen[parsed.id] = true;
        results.push(parsed);
    }
    return results;
}

// The "Recommended Series" box under a title: the same `article.bs` cards the catalog uses.
function parseRecommended(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var boxes = document.select(".bixbox");
    var result = [];
    var seen = {};
    for (var b = 0; b < boxes.size(); b++) {
        var head = boxes.get(b).selectFirst(".releases h3 span");
        if (head === null || S(head.text()).trim().toLowerCase() !== "recommended series") continue;
        var cards = boxes.get(b).select("article.bs a[href*='/anime/']");
        for (var i = 0; i < cards.size(); i++) {
            var link = cards.get(i);
            var match = /\/anime\/([^/]+)\/?$/.exec(S(link.absUrl("href")));
            var name = S(link.attr("title")).trim();
            if (match === null || !name || seen[match[1]]) continue;
            seen[match[1]] = true;
            var img = link.selectFirst("img");
            var poster = img === null ? "" : S(img.attr("data-src") || img.attr("src")).trim();
            var typeEl = link.selectFirst(".typez");
            result.push({ id: match[1], title: name, posterUrl: poster.indexOf("http") === 0 ? poster : null, type: typeEl === null ? null : S(typeEl.text()).trim().toLowerCase(), year: null, episodeCount: null, status: null });
        }
    }
    return result;
}

function parseDetails(id, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var heading = document.selectFirst(".infox h1.entry-title");
    if (heading === null) return null;
    var name = S(heading.text()).trim();
    if (name.length === 0) return null;

    var synonyms = [];
    var alter = document.selectFirst(".infox .alter");
    if (alter !== null) {
        var names = S(alter.text()).split(",").map(function (part) { return part.trim(); })
            .filter(function (part) { return part.length > 0 && part.toLowerCase() !== name.toLowerCase(); });
        synonyms = names;
    }

    var posterUrl = imageUrl(document.selectFirst(".bigcontent .thumb img"));

    var description = document.selectFirst(".entry-content[itemprop=description]");
    var descriptionText = description !== null ? S(description.text()).trim() : null;

    var genreLinks = document.select(".genxed a");
    var genres = [];
    for (var g = 0; g < genreLinks.size(); g++) genres.push(S(genreLinks.get(g).text()).trim());

    var ratingMeta = document.selectFirst(".rating-prc meta[itemprop=ratingValue]");
    var ratings = [];
    if (ratingMeta !== null) {
        var ratingValue = parseFloat(S(ratingMeta.attr("content")));
        if (!isNaN(ratingValue)) ratings.push({ source: "DonghuaStream", value: ratingValue, votes: null });
    }

    var episodeCountField = speField(document, "Episodes");
    var episodeCount = episodeCountField !== null ? parseInt(episodeCountField, 10) : null;
    if (episodeCount !== null && isNaN(episodeCount)) episodeCount = null;

    var yearField = speField(document, "Released");
    var year = null;
    if (yearField !== null) {
        var yearMatch = YEAR_IN_TEXT.exec(yearField);
        if (yearMatch !== null) year = parseInt(yearMatch[1], 10);
    }

    var studio = speField(document, "Studio");

    return title({
        id: id,
        englishName: name,
        originalName: name,
        synonyms: synonyms,
        posterUrl: posterUrl,
        description: descriptionText,
        genres: genres,
        ratings: ratings,
        type: toType(speField(document, "Type")),
        status: toStatus(speField(document, "Status")),
        episodeCount: episodeCount,
        year: year,
        studios: studio !== null ? [studio] : [],
    });
}

function fetchCatalogPage(page, filters, sortEnum) {
    return parseCardList(getHtml("/anime/page/" + page + "/?" + catalogQuery(filters, sortEnum)));
}

function fetchSearchPage(query, page) {
    var suffix = "?s=" + encodeURIComponent(query);
    return parseCardList(getHtml(page === 1 ? "/" + suffix : "/page/" + page + "/" + suffix));
}

function collectResults(fetchPage, wanted) {
    return collectPaginated(fetchPage, wanted, LISTING_PAGE_SIZE);
}

function parsePlayerLinks(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var options = document.select("select.mirror option");
    var referer = { "Referer": BASE_URL + "/" };
    var links = [];
    for (var i = 0; i < options.size(); i++) {
        var option = options.get(i);
        var value = S(option.attr("value")).trim();
        if (value.length === 0) continue;
        var label = S(option.text()).trim();
        if (label.length === 0) continue;

        var decoded;
        try { decoded = Base64.decode(value); } catch (e) { continue; }
        var fragment = Jsoup.parseBodyFragment(decoded, BASE_URL);
        var iframe = fragment.selectFirst("iframe");
        if (iframe === null) continue;
        var src = S(iframe.attr("src")).trim();
        if (src.length === 0) continue;
        var absoluteSrc = src.indexOf("//") === 0 ? "https:" + src
            : (src.indexOf("http") === 0 ? src : S(Jsoup.resolve(BASE_URL, src)));

        links.push({
            url: absoluteSrc, type: "EMBED", quality: null, headers: referer,
            playerName: label, translation: null, segments: [], videoId: null,
        });
    }
    return links;
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

// The catalog page (GET /anime) has a filter form: checkbox groups (genre[], season[], studio[]) and
// radio groups (status, type, sub, order). It is read off the live page, so a new genre or studio
// shows up without an update; one fetch per session, and a failed read only means no filters.
var CHECK_FIELDS = [
    { id: "genres", param: "genre[]", title: "Genres" },
    { id: "season", param: "season[]", title: "Year" },
    { id: "studios", param: "studio[]", title: "Studios" },
];
var RADIO_FIELDS = [
    { id: "status", param: "status", title: "Status" },
    { id: "type", param: "type", title: "Type" },
    { id: "sub", param: "sub", title: "Language" },
];
var cachedFilterDefs = null;
var cachedSorts = null;

function formOptions(document, param) {
    var inputs = document.select("form.filters input[name='" + param + "']");
    var options = [];
    for (var i = 0; i < inputs.size(); i++) {
        var input = inputs.get(i);
        var value = S(input.attr("value")).trim();
        if (!value) continue; // the radio groups' "All"/"Default" row: unset is expressed by absence
        var label = input.parent() === null ? null : input.parent().selectFirst("label");
        var text = label === null ? "" : S(label.text()).trim();
        options.push({ id: value, title: text || value });
    }
    return options;
}

function siteFilters() {
    if (cachedFilterDefs !== null) return cachedFilterDefs;
    var defs = [];
    try {
        var document = Jsoup.parse(getHtml("/anime/"), BASE_URL);
        // The order radios are the catalog's sort orders, not filters; "update" (latest update) is
        // the default and goes first.
        cachedSorts = formOptions(document, "order").sort(function (a, b) { return (b.id === "update") - (a.id === "update"); });
        RADIO_FIELDS.forEach(function (field) {
            var options = formOptions(document, field.param);
            if (options.length > 0) defs.push({ id: field.id, title: field.title, type: "select", options: options });
        });
        CHECK_FIELDS.forEach(function (field) {
            var options = formOptions(document, field.param);
            if (options.length > 0) defs.push({ id: field.id, title: field.title, type: "multi", options: options });
        });
    } catch (e) {
        console.warn("Filters unavailable: " + e);
        return [];
    }
    cachedFilterDefs = defs;
    return defs;
}

/** The catalog query string for the picked filters; the default keeps the previous "latest update" order. */
function catalogQuery(filters, sort) {
    var parts = [];
    CHECK_FIELDS.forEach(function (field) {
        picked(filters, field.id).forEach(function (value) {
            parts.push(encodeURIComponent(field.param) + "=" + encodeURIComponent(value));
        });
    });
    var radios = {};
    RADIO_FIELDS.forEach(function (field) { radios[field.param] = picked(filters, field.id)[0] || ""; });
    radios.order = sort || "update";
    for (var key in radios) parts.push(key + "=" + encodeURIComponent(radios[key]));
    return parts.join("&");
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var offset = Math.max(request.offset || 0, 0);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var query = (request.query || "").trim();

        var results = query.length > 0
            ? collectResults(function (page) { return fetchSearchPage(query, page); }, offset + limit)
            : collectResults(function (page) { return fetchCatalogPage(page, request.filters, request.sort); }, offset + limit);
        return results.slice(offset, offset + limit);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        return collectResults(fetchCatalogPage, safeLimit).slice(0, safeLimit);
    },

    getSettings: function () {
        var filters = siteFilters();
        return { sortOptions: cachedSorts || [{ id: "update", title: "Latest update" }], filters: filters };
    },

    getById: function (id) {
        var path = String(id).trim();
        var html = getHtml("/anime/" + path + "/");
        var details = parseDetails(path, html);
        if (details === null) throw new Error("DonghuaStream title was not found: " + id);
        details.similarAnime = parseRecommended(html);
        return details;
    },

    getPlaybackGroups: function (titleId) {
        var document = Jsoup.parse(getHtml("/anime/" + titleId + "/"), BASE_URL);
        var items = document.select(".eplister li a");
        var episodes = [];
        for (var i = 0; i < items.size(); i++) {
            var item = items.get(i);
            var href = S(item.absUrl("href"));
            if (href.indexOf(BASE_URL) === 0) href = href.substring(BASE_URL.length);
            var episodeId = href.replace(/^\/+/, "").replace(/\/+$/, "");
            if (episodeId.length === 0) continue;

            var numberField = item.selectFirst(".epl-num");
            var numberText = numberField !== null ? S(numberField.text()).trim() : "";
            var numberMatch = /(\d+(?:\.\d+)?)/.exec(numberText);
            var number = numberMatch !== null ? parseFloat(numberMatch[1]) : (i + 1);

            var titleField = item.selectFirst(".epl-title");
            var episodeTitle = titleField !== null ? S(titleField.text()).trim() : null;

            episodes.push({ id: episodeId, number: number, title: episodeTitle });
        }
        if (episodes.length === 0) return [];
        episodes.sort(function (a, b) { return a.number - b.number; });
        return [{ id: titleId, title: "Episodes", episodes: episodes, qualityLabel: null }];
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        return parsePlayerLinks(getHtml("/" + episodeId + "/"));
    },
};
