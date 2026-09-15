// AniKoto scripted source.
// The site uses normal HTML for catalog/details and an XHR endpoint for episodes. Server links
// are opaque per-episode tokens; they are intentionally passed to /ajax/server unchanged.

function S(value) { return value === null || value === undefined ? "" : String(value); }

var BASE_URL = "https://anikototv.to";
var USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";
var MAX_RESULTS = 50;
var titleIds = {};

function request(path, referer) {
    var response = fetch(BASE_URL + path, {
        headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": referer || BASE_URL + "/",
            "X-Requested-With": "XMLHttpRequest"
        }
    });
    if (!response.ok) throw new Error("AniKoto returned HTTP " + response.status);
    return S(response.body);
}

function title(fields) { return AnimeTitle(fields); }

function normalizeType(raw) {
    var value = S(raw).trim().toLowerCase();
    if (value === "tv") return "tv";
    if (value === "movie") return "movie";
    if (value === "ova") return "ova";
    if (value === "ona") return "ona";
    if (value === "special") return "special";
    return value || null;
}

function slugFromHref(href) {
    var match = /\/watch\/([^/]+)/.exec(S(href));
    return match === null ? null : match[1].replace(/\/ep-\d+(?:[.\d]+)?$/, "");
}

function numberFromText(value) {
    var match = /\d+(?:[.,]\d+)?/.exec(S(value));
    return match === null ? NaN : parseFloat(match[0].replace(",", "."));
}

function cardEpisodeCount(card) {
    var statuses = card.select(".ep-status span");
    var max = 0;
    for (var i = 0; i < statuses.size(); i++) {
        var number = numberFromText(statuses.get(i).text());
        if (!isNaN(number)) max = Math.max(max, number);
    }
    return max > 0 ? max : null;
}

function parseCard(card) {
    var link = card.selectFirst("a.name.d-title[href*='/watch/']");
    if (link === null) return null;
    var href = S(link.absUrl("href"));
    var id = slugFromHref(href);
    if (!id) return null;

    var name = S(link.text()).trim();
    if (!name) return null;
    var poster = card.selectFirst(".poster img");
    var typeEl = card.selectFirst(".poster .meta .right");
    var type = typeEl === null ? null : normalizeType(typeEl.text());
    var year = null;
    var yearMatch = /(?:^|\D)(19\d{2}|20\d{2})(?:\D|$)/.exec(S(card.text()));
    if (yearMatch !== null) year = parseInt(yearMatch[1], 10);
    var genres = [];
    var genreLinks = card.select(".genre a");
    for (var g = 0; g < genreLinks.size(); g++) {
        var genre = S(genreLinks.get(g).text()).trim();
        if (genre && genres.indexOf(genre) < 0) genres.push(genre);
    }

    var animeId = card.selectFirst(".poster[data-tip]");
    if (animeId !== null) titleIds[id] = S(animeId.attr("data-tip"));
    return title({
        id: id,
        englishName: name,
        originalName: S(link.attr("data-jp")) || name,
        japaneseName: S(link.attr("data-jp")) || null,
        year: year,
        type: type,
        availableEpisodeCount: cardEpisodeCount(card),
        episodeCount: null,
        posterUrl: poster === null ? null : S(poster.absUrl("src")),
        genres: genres,
    });
}

function parseCards(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var cards = document.select(".film_list-wrap .item, .film_list .item");
    if (cards.size() === 0) cards = document.select("div.item");
    var result = [];
    var seen = {};
    for (var i = 0; i < cards.size(); i++) {
        var parsed = parseCard(cards.get(i));
        if (parsed === null || seen[parsed.id]) continue;
        seen[parsed.id] = true;
        result.push(parsed);
    }
    return result;
}

function loadCatalog(path, wanted) {
    var result = [];
    var seen = {};
    for (var page = 1; page <= 20 && result.length < wanted; page++) {
        var suffix = page === 1 ? "" : "&page=" + page;
        var html = request(path + (path.indexOf("?") >= 0 ? suffix : (page === 1 ? "" : "?page=" + page)));
        var cards = parseCards(html);
        if (cards.length === 0) break;
        for (var i = 0; i < cards.length; i++) {
            if (!seen[cards[i].id]) { seen[cards[i].id] = true; result.push(cards[i]); }
        }
        if (cards.length < 10) break;
    }
    return result;
}

function parseDetails(id, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var heading = document.selectFirst("h1.title.d-title, h1[itemprop=name]");
    if (heading === null) throw new Error("AniKoto title page has no title");
    var name = S(heading.text()).trim();
    var poster = document.selectFirst("img[itemprop=image], .binfo .poster img");
    var synopsis = document.selectFirst(".synopsis .content, .synopsis");
    var meta = document.selectFirst(".bmeta .meta");
    function metaValue(label) {
        if (meta === null) return "";
        var rows = meta.select("div");
        for (var i = 0; i < rows.size(); i++) {
            var text = S(rows.get(i).text()).trim();
            if (text.indexOf(label) === 0) return text.substring(label.length).replace(/^\s*:\s*/, "").trim();
        }
        return "";
    }
    var genres = [];
    var genreLinks = document.select(".bmeta a[href*='/genre/']");
    for (var g = 0; g < genreLinks.size(); g++) genres.push(S(genreLinks.get(g).text()).trim());
    var yearMatch = /(19\d{2}|20\d{2})/.exec(metaValue("Premiered"));
    var episodeCount = numberFromText(metaValue("Episodes"));
    var statusText = metaValue("Status").toLowerCase();
    var type = normalizeType(metaValue("Type"));
    var animeId = document.selectFirst("#watch-main[data-id]");
    if (animeId !== null) titleIds[id] = S(animeId.attr("data-id"));
    return title({
        id: id,
        englishName: name,
        originalName: S(heading.attr("data-jp")) || name,
        japaneseName: S(heading.attr("data-jp")) || null,
        year: yearMatch === null ? null : parseInt(yearMatch[1], 10),
        type: type,
        status: statusText.indexOf("airing") >= 0 ? "ongoing" : (statusText ? "released" : null),
        episodeCount: isNaN(episodeCount) ? null : episodeCount,
        posterUrl: poster === null ? null : S(poster.absUrl("src")),
        description: synopsis === null ? null : S(synopsis.text()).trim(),
        genres: genres,
    });
}

function episodeHtml(titleId) {
    var numericId = titleIds[titleId];
    if (!numericId) {
        var detail = request("/watch/" + titleId);
        parseDetails(titleId, detail);
        numericId = titleIds[titleId];
    }
    if (!numericId) return null;
    var root = JSON.parse(request("/ajax/episode/list/" + numericId + "?style=&vrf="));
    if (!root || root.status !== 200) throw new Error("AniKoto episode list failed");
    return Jsoup.parseBodyFragment(S(root.result));
}

function collectEpisodes(titleId) {
    var document = episodeHtml(titleId);
    if (document === null) return { sub: [], dub: [] };
    var groups = { sub: [], dub: [] };
    var seen = { sub: {}, dub: {} };
    // AniKoto puts the episode identity and opaque server-list token on the anchor, not its li.
    // The server-specific data-link-id is returned only by /ajax/server/list later.
    var items = document.select("a[data-id][data-ids]");
    for (var i = 0; i < items.size(); i++) {
        var item = items.get(i);
        var epId = S(item.attr("data-id"));
        var number = numberFromText(item.attr("data-num"));
        if (!epId || isNaN(number)) continue;
        var types = [];
        if (S(item.attr("data-sub")) === "1") types.push("sub");
        if (S(item.attr("data-dub")) === "1") types.push("dub");
        for (var t = 0; t < types.length; t++) {
            var type = types[t];
            if (seen[type][epId]) continue;
            seen[type][epId] = true;
            groups[type].push({ id: titleId + "|" + epId, number: number, title: S(item.attr("title")) || null });
        }
    }
    groups.sub.sort(function(a,b){ return a.number-b.number; });
    groups.dub.sort(function(a,b){ return a.number-b.number; });
    return groups;
}

function loadLinks(titleId, groupId, episodeId) {
    var type = groupId.indexOf("|dub") >= 0 ? "dub" : "sub";
    var epId = episodeId.substring(episodeId.lastIndexOf("|") + 1);
    var document = episodeHtml(titleId);
    if (document === null) return [];
    var episode = document.selectFirst("a[data-id='" + epId + "'][data-ids]");
    if (episode === null || S(episode.attr("data-" + type)) !== "1") return [];
    var serverToken = S(episode.attr("data-ids"));
    if (!serverToken) return [];
    var referer = BASE_URL + "/watch/" + titleId + "/ep-" + S(episode.attr("data-slug"));
    var serverList = JSON.parse(request("/ajax/server/list?servers=" + encodeURIComponent(serverToken), referer));
    if (!serverList || serverList.status !== 200 || !serverList.result) return [];
    var servers = Jsoup.parseBodyFragment(S(serverList.result));
    var items = servers.select(".type[data-type='" + type + "'] li[data-link-id]");
    var links = [];
    var seen = {};
    for (var i = 0; i < items.size(); i++) {
        var item = items.get(i);
        var token = S(item.attr("data-link-id"));
        if (!token || seen[token]) continue;
        seen[token] = true;
        var response = JSON.parse(request("/ajax/server?get=" + encodeURIComponent(token), referer));
        if (!response || response.status !== 200 || !response.result || !response.result.url) continue;
        links.push({
            url: S(response.result.url), type: "EMBED", quality: null,
            headers: { "Referer": referer },
            playerName: S(item.text()).trim(),
            translation: type === "dub" ? "English dub" : "English sub",
            segments: [], videoId: null,
        });
    }
    return links;
}

var Provider = {
    search: function (requestJson) {
        var requestData = JSON.parse(requestJson);
        var query = S(requestData.query).trim();
        var offset = Math.max(requestData.offset || 0, 0);
        var limit = Math.min(Math.max(requestData.limit || 20, 1), MAX_RESULTS);
        var path = query ? "/filter?keyword=" + encodeURIComponent(query) : "/home";
        return loadCatalog(path, offset + limit).slice(offset, offset + limit);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        return loadCatalog("/home", safeLimit).slice(0, safeLimit);
    },

    getById: function (id) {
        var slug = S(id).trim();
        return parseDetails(slug, request("/watch/" + slug));
    },

    getSettings: function () {
        return { sortOptions: [{ id: "relevance", title: "Relevance" }] };
    },

    getPlaybackGroups: function (titleId) {
        var groups = collectEpisodes(titleId);
        var result = [];
        if (groups.sub.length > 0) result.push({ id: titleId + "|sub", title: "English subtitles", episodes: groups.sub, qualityLabel: null });
        if (groups.dub.length > 0) result.push({ id: titleId + "|dub", title: "English dub", episodes: groups.dub, qualityLabel: null });
        return result;
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        return loadLinks(titleId, groupId, episodeId);
    },
};
