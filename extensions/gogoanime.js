// Gogoanime scripted extension for Hibiki (gogoanime.by mirror). Same WP "DooPlay"-family theme
// markup as donghuastream.js (`.bsx`, `.spe`, `.genxed`) - see that file's header for the shared
// notes. Two real differences here:
//   - The full episode list ships inline in the series page's own HTML as hidden `.episode-item`
//     divs (client-side JS just toggles which ones are visible per "page" for browsing) - no
//     separate episode-list request needed at all, unlike donghuastream's per-title fetch.
//   - Player links are this theme's own `/player/?source=embed&url=<token>` indirection page,
//     which itself iframes the real embed (megaplay.su here) - reusing the animepahe-player
//     resolver as-is (it's already host-agnostic: watches for a <video> element and reports the
//     .m3u8 URLs it requests, one iframe level deep).
//   - Dubbed episodes are entirely separate "series" entries on this site (e.g.
//     "one-piece-english-dubbed-online"), not a second playback group under the same title - so
//     they show up as their own distinct catalog entries here too, matching the site's own model.

function S(value) { return value === null || value === undefined ? null : String(value); }

var BASE_URL = "https://gogoanime.by";
var MAX_RESULTS = 50;
var LISTING_PAGE_SIZE = 20;

var SERIES_PATH = /^series\/([^/]+)\/?$/;
var YEAR_IN_TEXT = /(\d{4})/;

/** Fills in every AnimeTitle field so the Kotlin-side JSON decode always sees a complete object. */
function title(fields) { return AnimeTitle(fields); }

function getHtml(path) {
    var response = fetch(BASE_URL + path, {
        headers: { "Accept": "text/html,application/xhtml+xml", "Referer": BASE_URL + "/" },
    });
    if (!response.ok) throw new Error("Gogoanime returned HTTP " + response.status + " for " + path);
    return S(response.body);
}

function idFromHref(href) {
    if (href.indexOf(BASE_URL) === 0) href = href.substring(BASE_URL.length);
    if (href.charAt(0) === "/") href = href.substring(1);
    var match = SERIES_PATH.exec(href);
    return match !== null ? match[1] : null;
}

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

function parseDetails(id, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var heading = document.selectFirst(".infox h1.entry-title");
    if (heading === null) return null;
    var name = S(heading.text()).trim();
    if (name.length === 0) return null;

    var synonyms = [];
    var alter = document.selectFirst(".infox .alter");
    if (alter !== null) {
        var names = S(alter.text()).split("/").map(function (part) { return part.trim(); })
            .filter(function (part) { return part.length > 0 && part.toLowerCase() !== name.toLowerCase(); });
        synonyms = names;
    }

    var posterUrl = imageUrl(document.selectFirst(".bigcontent .thumb img, .thumb img"));

    var description = document.selectFirst(".infox .ninfo p, .entry-content[itemprop=description]");
    var descriptionText = description !== null ? S(description.text()).trim() : null;

    var genreLinks = document.select(".genxed a");
    var genres = [];
    for (var g = 0; g < genreLinks.size(); g++) genres.push(S(genreLinks.get(g).text()).trim());

    var ratingMeta = document.selectFirst("[itemprop=ratingValue]");
    var ratings = [];
    if (ratingMeta !== null) {
        var ratingValue = parseFloat(S(ratingMeta.attr("content") || ratingMeta.text()));
        if (!isNaN(ratingValue)) ratings.push({ source: "Gogoanime", value: ratingValue, votes: null });
    }

    var studio = speField(document, "Studio");
    var releasedField = speField(document, "Released");
    var year = null;
    if (releasedField !== null) {
        var yearMatch = YEAR_IN_TEXT.exec(releasedField);
        if (yearMatch !== null) year = parseInt(yearMatch[1], 10);
    }

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
        year: year,
        studios: studio !== null ? [studio] : [],
    });
}

function fetchCatalogPage(page) {
    return parseCardList(getHtml("/series/page/" + page + "/?status=&type=&order=update"));
}

function fetchSearchPage(query, page) {
    var suffix = "?s=" + encodeURIComponent(query);
    return parseCardList(getHtml(page === 1 ? "/" + suffix : "/page/" + page + "/" + suffix));
}

function collectResults(fetchPage, wanted) {
    return collectPaginated(fetchPage, wanted, LISTING_PAGE_SIZE);
}

function parsePlaybackGroups(titleId, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var items = document.select(".episode-item");
    var episodes = [];
    var seen = {};
    for (var i = 0; i < items.size(); i++) {
        var item = items.get(i);
        var numberText = S(item.attr("data-episode-number")).trim();
        var number = parseFloat(numberText);
        if (isNaN(number) || seen[numberText]) continue;
        var link = item.selectFirst("a");
        if (link === null) continue;
        var href = S(link.absUrl("href"));
        if (href.indexOf(BASE_URL) === 0) href = href.substring(BASE_URL.length);
        var episodeId = href.replace(/^\/+/, "").replace(/\/+$/, "");
        if (episodeId.length === 0) continue;
        seen[numberText] = true;
        episodes.push({ id: episodeId, number: number, title: null });
    }
    if (episodes.length === 0) return [];
    episodes.sort(function (a, b) { return a.number - b.number; });
    return [{ id: titleId, title: "Episodes", episodes: episodes, qualityLabel: null }];
}

/** `.player-type-link[data-src]` points at this theme's own `/player/?source=embed&url=<token>`
 * indirection page, which itself just iframes the real embed (megaplay.su) - resolving that here
 * keeps the PlayerLink pointed straight at megaplay.su, matching how animepahe.js hands it to the
 * same animepahe-player resolver (which expects to find <video> one iframe below the link's own
 * url, not two levels below it). */
function resolvePlayerPageUrl(playerPageUrl, headers) {
    var response = fetch(playerPageUrl, { headers: headers });
    if (!response.ok) return null;
    var document = Jsoup.parse(S(response.body), BASE_URL);
    var iframe = document.selectFirst("iframe");
    if (iframe === null) return null;
    var src = S(iframe.attr("src")).trim();
    if (src.length === 0) return null;
    return src.indexOf("//") === 0 ? "https:" + src : src;
}

function parsePlayerLinks(episodePath, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var options = document.select(".player-type-link[data-src]");
    var referer = { "Referer": BASE_URL + "/" + episodePath + "/" };
    var links = [];
    for (var i = 0; i < options.size(); i++) {
        var option = options.get(i);
        var src = S(option.attr("data-src")).trim();
        if (src.length === 0) continue;
        var playerPageUrl = S(Jsoup.resolve(BASE_URL, src));
        var resolvedUrl;
        try { resolvedUrl = resolvePlayerPageUrl(playerPageUrl, referer); } catch (e) { continue; }
        if (resolvedUrl === null) continue;
        var label = S(option.text()).trim();
        links.push({
            url: resolvedUrl, type: "EMBED", quality: null, headers: referer,
            playerName: label.length > 0 ? label : null, translation: null, segments: [], videoId: null,
        });
    }
    return links;
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var offset = Math.max(request.offset || 0, 0);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var query = (request.query || "").trim();

        var results = query.length > 0
            ? collectResults(function (page) { return fetchSearchPage(query, page); }, offset + limit)
            : collectResults(fetchCatalogPage, offset + limit);
        return results.slice(offset, offset + limit);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        return collectResults(fetchCatalogPage, safeLimit).slice(0, safeLimit);
    },

    getSettings: function () {
        return { sortOptions: [{ id: "relevance", title: "Relevance" }] };
    },

    getById: function (id) {
        var path = String(id).trim();
        var details = parseDetails(path, getHtml("/series/" + path + "/"));
        if (details === null) throw new Error("Gogoanime title was not found: " + id);
        return details;
    },

    getPlaybackGroups: function (titleId) {
        return parsePlaybackGroups(titleId, getHtml("/series/" + titleId + "/"));
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        return parsePlayerLinks(episodeId, getHtml("/" + episodeId + "/"));
    },
};
