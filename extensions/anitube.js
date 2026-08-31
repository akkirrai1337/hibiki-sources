// AniTube (DLE) source. Its episode menu is intentionally fetched only after loading the title
// page: the AJAX response is tied to that fresh page session and contains all player alternatives.
function S(value) { return value === null || value === undefined ? "" : String(value); }

var BASE_URL = "https://anitube.in.ua";
var USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";
var DESKTOP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
var MAX_RESULTS = 50;
var LISTING_PAGE_SIZE = 8;
var SEARCH_PAGE_SIZE = 10;
var TITLE_ID = /^(\d+)-[^/]+\.html$/;
var EPISODE_NUMBER = /^\s*(\d+(?:[.,]\d+)?)/;

function title(fields) { return AnimeTitle(fields); }

function absolute(path) {
    path = S(path);
    if (/^https?:\/\//i.test(path)) return path;
    return BASE_URL + (path.charAt(0) === "/" ? path : "/" + path);
}

function request(url, options) {
    options = options || {};
    var headers = options.headers || {};
    if (!headers["User-Agent"]) headers["User-Agent"] = USER_AGENT;
    if (!headers["Referer"]) headers["Referer"] = BASE_URL + "/";
    var response = fetch(url, { method: options.method || "GET", headers: headers, form: options.form });
    if (!response.ok) throw new Error("AniTube returned HTTP " + response.status);
    return S(response.body);
}

function normalizedTitleId(id) {
    id = S(id).replace(/^https?:\/\/[^/]+\//i, "").replace(/^\//, "").split("?")[0];
    if (!TITLE_ID.test(id)) throw new Error("AniTube title id is invalid: " + id);
    return id;
}

function parseYear(card) {
    var links = card.select("a[href*='/xfsearch/year/']");
    for (var i = 0; i < links.size(); i++) {
        var match = /(19|20)\d{2}/.exec(S(links.get(i).text()));
        if (match) return parseInt(match[0], 10);
    }
    return null;
}

function parseType(card) {
    var lines = card.select(".sd-line");
    for (var i = 0; i < lines.size(); i++) {
        var text = S(lines.get(i).text());
        var label = lines.get(i).selectFirst("span");
        if (label === null || S(label.text()).replace(/:\s*$/, "") !== "Тип") continue;
        var value = text.substring(S(label.text()).length).trim().toLowerCase();
        if (value === "тв") return "tv";
        if (value.indexOf("фільм") >= 0 || value.indexOf("повнометраж") >= 0) return "movie";
        return value || null;
    }
    return null;
}

function parseEpisodeInfo(card) {
    var progress = card.selectFirst(".up-series");
    var text = progress === null ? S(card.text()) : S(progress.text());
    var match = /(\d+(?:[.,]\d+)?)\s*з\s*(\d+(?:[.,]\d+)?)/i.exec(text);
    if (match === null) return { available: null, total: null, status: null };
    var available = parseFloat(match[1].replace(",", "."));
    var total = parseFloat(match[2].replace(",", "."));
    if (isNaN(available) || isNaN(total) || total <= 0) return { available: null, total: null, status: null };
    return { available: available, total: total, status: available < total ? "ongoing" : "released" };
}

function parseGenres(card) {
    var genres = [];
    var category = card.selectFirst(".short-cat");
    if (category === null) return genres;
    var parts = S(category.text()).split(",");
    for (var i = 0; i < parts.length; i++) {
        var genre = parts[i].trim();
        if (genre) genres.push(genre);
    }
    return genres;
}

function parseDescription(card) {
    var description = card.selectFirst(".short-desc .sd-text, .news_2_c_text");
    if (description === null) return null;
    var text = S(description.text()).replace(/^Опис:\s*/i, "").trim();
    return text || null;
}

function parseCards(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var cards = document.select("article.short, .news_2");
    var result = [];
    var seen = {};
    for (var i = 0; i < cards.size(); i++) {
        var card = cards.get(i);
        // The first .short-title wraps a poster and contains labels such as "Озв+Суб 6 з 10".
        // Only the nested h2 is the actual release name.
        var heading = card.selectFirst("h2, .title2 a[href$='.html']");
        if (heading === null) continue;
        // In the mobile template h2 is inside the link; in the desktop template the matched
        // .title2 element is the link itself.
        var titleLink = S(heading.tagName()).toLowerCase() === "a" ? heading : heading.parent();
        var href = S(titleLink.absUrl("href"));
        var id = href.replace(/^https?:\/\/[^/]+\//i, "").split("?")[0];
        if (!TITLE_ID.test(id) || seen[id]) continue;
        var name = S(heading.text()).trim();
        if (!name) continue;
        var poster = card.selectFirst("img.poster, .news_post img, img[alt]");
        var posterUrl = null;
        if (poster !== null) {
            posterUrl = S(poster.absUrl("src"));
            if (!posterUrl) posterUrl = S(poster.absUrl("data-src"));
        }
        var episodes = parseEpisodeInfo(card);
        seen[id] = true;
        result.push(title({
            id: id,
            russianName: name,
            englishName: null,
            originalName: name,
            year: parseYear(card),
            type: parseType(card),
            episodeCount: episodes.total,
            posterUrl: posterUrl || null,
            status: episodes.status,
            description: parseDescription(card),
            genres: parseGenres(card),
            availableEpisodeCount: episodes.available
        }));
    }
    return result;
}

function titlePage(id) { return absolute(normalizedTitleId(id)); }

function getTitle(id) {
    id = normalizedTitleId(id);
    var html = request(titlePage(id));
    var cards = parseCards(html);
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i];
    var document = Jsoup.parse(html, BASE_URL);
    var heading = document.selectFirst("article.story h1, h1");
    if (heading === null) throw new Error("AniTube title was not found: " + id);
    var name = S(heading.text()).replace(/\s+аніме українською онлайн$/i, "").trim();
    var poster = document.selectFirst("meta[property='og:image']");
    var description = document.selectFirst("meta[property='og:description'], meta[name='description']");
    return title({ id: id, russianName: name, englishName: null, originalName: name,
        posterUrl: poster === null ? null : S(poster.attr("content")),
        description: description === null ? null : S(description.attr("content")), genres: [] });
}

function browserPlaylist(pageUrl, targetUrl, headers) {
    var response = browserFetch(pageUrl, targetUrl, { method: "GET", headers: headers });
    if (!response.ok) throw new Error("AniTube playlist returned HTTP " + response.status);
    return S(response.body);
}

function playlist(titleId) {
    var id = normalizedTitleId(titleId);
    var pageUrl = titlePage(id);
    var page = request(pageUrl);
    var newsId = TITLE_ID.exec(id)[1];
    var fieldMatch = /class=["']playlists-ajax["'][^>]*data-xfname=["']([^"']+)/i.exec(page);
    var hashMatch = /var\s+dle_login_hash\s*=\s*'([^']+)'/.exec(page);
    if (!fieldMatch || !hashMatch) throw new Error("AniTube did not expose its playlist token");
    var target = BASE_URL + "/engine/ajax/playlists.php?news_id=" + encodeURIComponent(newsId) +
        "&xfield=" + encodeURIComponent(fieldMatch[1]) + "&user_hash=" + encodeURIComponent(hashMatch[1]);
    var headers = { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest", "Referer": pageUrl };
    var body;
    try { body = request(target, { headers: headers }); }
    catch (error) { body = browserPlaylist(pageUrl, target, headers); }
    var json = JSON.parse(body);
    if (!json.success || !json.response) throw new Error("AniTube playlist is unavailable");
    return parsePlaylist(S(json.response));
}

function parsePlaylist(html) {
    var document = Jsoup.parseBodyFragment(html, BASE_URL);
    var lists = document.select(".playlists-lists .playlists-items");
    var labels = {};
    for (var listIndex = 0; listIndex < lists.size(); listIndex++) {
        var options = lists.get(listIndex).select("li[data-id]");
        for (var i = 0; i < options.size(); i++) labels[S(options.get(i).attr("data-id"))] = S(options.get(i).text()).trim();
    }
    var items = [];
    var videos = document.select(".playlists-videos li[data-file][data-id]");
    for (var v = 0; v < videos.size(); v++) {
        var video = videos.get(v);
        var playerId = S(video.attr("data-id"));
        var groupId = playerId.replace(/_[^_]+$/, "");
        var numberText = S(video.text()).trim();
        var numberMatch = EPISODE_NUMBER.exec(numberText);
        if (!numberMatch) continue;
        items.push({ groupId: groupId, player: labels[playerId] || "Плеєр", category: labels[groupId.replace(/_[^_]+$/, "")] || "AniTube",
            studio: labels[groupId] || "AniTube", number: parseFloat(numberMatch[1].replace(",", ".")), title: numberText,
            url: S(video.attr("data-file")) });
    }
    return items;
}

function groupLabel(item) { return item.category + " · " + item.studio; }

// AniTube renders different metadata on its responsive templates. The mobile response provides
// type and a compact episode badge; the desktop response provides the year. They describe the
// same IDs, so merge them instead of opening every title page merely to fill catalog cards.
function mergeListingCards(primary, supplementary) {
    var byId = {};
    for (var i = 0; i < supplementary.length; i++) byId[supplementary[i].id] = supplementary[i];
    for (var j = 0; j < primary.length; j++) {
        var extra = byId[primary[j].id];
        if (!extra) continue;
        if (primary[j].year === null || primary[j].year === undefined) primary[j].year = extra.year;
        if (primary[j].type === null || primary[j].type === undefined) primary[j].type = extra.type;
        if (primary[j].episodeCount === null || primary[j].episodeCount === undefined) primary[j].episodeCount = extra.episodeCount;
        if (primary[j].availableEpisodeCount === null || primary[j].availableEpisodeCount === undefined) primary[j].availableEpisodeCount = extra.availableEpisodeCount;
        if (primary[j].status === null || primary[j].status === undefined) primary[j].status = extra.status;
    }
    return primary;
}

function listing(path, form) {
    var options = form ? { method: "POST", form: form } : {};
    var mobile = parseCards(request(BASE_URL + path, options));
    var desktopHeaders = { "User-Agent": DESKTOP_USER_AGENT };
    var desktopOptions = form ? { method: "POST", form: form, headers: desktopHeaders } : { headers: desktopHeaders };
    return mergeListingCards(mobile, parseCards(request(BASE_URL + path, desktopOptions)));
}

// AniTube's regular feed is eight cards per page and its search results are ten cards per page.
// The host passes an arbitrary offset/limit window, so resolve just the site pages intersecting
// that window instead of always returning the first eight cards.
function collectListingWindow(pageSize, offset, limit, fetchPage) {
    offset = Math.max(offset || 0, 0);
    limit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
    var firstPage = Math.floor(offset / pageSize) + 1;
    var lastPage = Math.floor((offset + limit - 1) / pageSize) + 1;
    var result = [];
    for (var page = firstPage; page <= lastPage; page++) {
        var cards = fetchPage(page);
        result = result.concat(cards);
        // No subsequent page can contain items when AniTube has reached the end.
        if (cards.length < pageSize) break;
    }
    var localOffset = offset - (firstPage - 1) * pageSize;
    return result.slice(localOffset, localOffset + limit);
}

function latestWindow(offset, limit) {
    return collectListingWindow(LISTING_PAGE_SIZE, offset, limit, function (page) {
        return listing(page === 1 ? "/" : "/page/" + page + "/");
    });
}

function searchWindow(query, offset, limit) {
    return collectListingWindow(SEARCH_PAGE_SIZE, offset, limit, function (page) {
        return listing("/index.php?do=search", {
            do: "search",
            subaction: "search",
            story: query,
            search_start: page,
            result_from: (page - 1) * SEARCH_PAGE_SIZE + 1,
            full_search: 0
        });
    });
}

var Provider = {
    search: function (requestJson) {
        var requestJsonObject = JSON.parse(requestJson);
        var query = S(requestJsonObject.query).trim();
        var offset = Math.max(requestJsonObject.offset || 0, 0);
        var limit = requestJsonObject.limit || 20;
        if (!query) return latestWindow(offset, limit);
        return searchWindow(query, offset, limit);
    },
    latest: function (limit) { return latestWindow(0, limit); },
    getSettings: function () { return { sortOptions: [{ id: "relevance", title: "Relevance" }] }; },
    getById: function (id) { return getTitle(id); },
    getPlaybackGroups: function (titleId) {
        var entries = playlist(titleId), groups = {}, order = [];
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i], group = groups[entry.groupId];
            if (!group) { group = { id: entry.groupId, title: groupLabel(entry), episodes: [], qualityLabel: null, seen: {} }; groups[entry.groupId] = group; order.push(group); }
            var episodeId = entry.groupId + ":" + entry.number;
            if (!group.seen[episodeId]) { group.seen[episodeId] = true; group.episodes.push({ id: episodeId, number: entry.number, title: entry.title }); }
        }
        for (var g = 0; g < order.length; g++) delete order[g].seen;
        return order;
    },
    getPlayerLinks: function (titleId, groupId, episodeId) {
        var number = parseFloat(S(episodeId).substring(S(episodeId).lastIndexOf(":") + 1));
        var entries = playlist(titleId), links = [], seen = {};
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.groupId !== groupId || entry.number !== number || seen[entry.url]) continue;
            seen[entry.url] = true;
            links.push({ url: entry.url, type: "EMBED", quality: null, headers: { "Referer": BASE_URL + "/" },
                playerName: entry.player, translation: entry.studio, segments: [], videoId: null });
        }
        if (!links.length) throw new Error("AniTube episode is unavailable: " + episodeId);
        return links;
    }
};
