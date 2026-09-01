// AniKappa is a DLE catalog. Its own player endpoint returns the selected source, translation
// team and episode as HTML; preserving those selectors gives the app proper voice/subtitle groups.
function S(value) { return value === null || value === undefined ? "" : String(value); }

var BASE_URL = "https://anikappa.in.ua";
var MAX_RESULTS = 50;
var TITLE_PATH = /^(?:[^?#]+\/)?\d+-[^?#/]+\.html$/;
var EPISODE_NUMBER = /(\d+(?:[.,]\d+)?)/;

function title(fields) { return AnimeTitle(fields); }

function absolute(path) {
    path = S(path);
    return /^https?:\/\//i.test(path) ? path : BASE_URL + (path.charAt(0) === "/" ? path : "/" + path);
}

function request(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (!headers["User-Agent"]) headers["User-Agent"] = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";
    if (!headers["Referer"]) headers["Referer"] = BASE_URL + "/";
    var response = fetch(absolute(path), { method: options.method || "GET", headers: headers, form: options.form });
    if (!response.ok) throw new Error("AniKappa returned HTTP " + response.status);
    return S(response.body);
}

function normalizedId(id) {
    var path = S(id).replace(/^https?:\/\/[^/]+\//i, "").replace(/^\//, "").split("?")[0];
    if (!TITLE_PATH.test(path)) throw new Error("AniKappa title id is invalid: " + id);
    return path;
}

function typeOf(text) {
    text = S(text).toLowerCase();
    if (text.indexOf("tv") >= 0 || text.indexOf("серіал") >= 0) return "tv";
    if (text.indexOf("фільм") >= 0) return "movie";
    if (text.indexOf("ova") >= 0) return "ova";
    if (text.indexOf("ona") >= 0) return "ona";
    if (text.indexOf("спешл") >= 0) return "special";
    return null;
}

function parseCards(html, selector) {
    var document = Jsoup.parse(html, BASE_URL);
    var cards = document.select(selector || ".shortstory__body");
    var result = [], seen = {};
    for (var i = 0; i < cards.size(); i++) {
        var card = cards.get(i);
        var link = card.selectFirst("a[href*='.html']");
        if (link === null) continue;
        var href = S(link.absUrl("href"));
        var id = href.replace(/^https?:\/\/[^/]+\//i, "").split("?")[0];
        if (!TITLE_PATH.test(id) || seen[id]) continue;
        var nameNode = card.selectFirst(".shortstory__title, .card-update__title, img[alt]");
        var name = nameNode === null ? "" : S(nameNode.text()).trim();
        if (!name) continue;
        var image = card.selectFirst("img");
        var poster = image === null ? null : S(image.absUrl("src")) || null;
        var info = card.select(".shortstory__info span");
        var type = info.size() > 0 ? typeOf(info.get(0).text()) : typeOf(link.attr("class"));
        var year = null;
        var infoText = S(card.selectFirst(".shortstory__info") === null ? "" : card.selectFirst(".shortstory__info").text());
        var yearMatch = /(19|20)\d{2}/.exec(infoText);
        if (yearMatch) year = parseInt(yearMatch[0], 10);
        var episodeNode = card.selectFirst(".shortstory__last-episode, .card-update__last-episode");
        var episodeMatch = episodeNode === null ? null : EPISODE_NUMBER.exec(S(episodeNode.text()));
        var episodes = episodeMatch === null ? null : parseFloat(episodeMatch[1].replace(",", "."));
        seen[id] = true;
        result.push(title({
            id: id, russianName: name, englishName: null, originalName: name,
            year: year, type: type, episodeCount: episodes, availableEpisodeCount: episodes,
            posterUrl: poster, status: null, description: null, genres: []
        }));
    }
    return result;
}

function field(document, label) {
    var fields = document.select(".info-card__list-item");
    for (var i = 0; i < fields.size(); i++) {
        var item = fields.get(i);
        var key = item.selectFirst("span");
        if (key !== null && S(key.text()).replace(/:\s*$/, "") === label) {
            return S(item.text()).substring(S(key.text()).length).trim();
        }
    }
    return null;
}

function details(id) {
    id = normalizedId(id);
    var document = Jsoup.parse(request("/" + id), BASE_URL);
    var heading = document.selectFirst(".fullstory__title, h1");
    if (heading === null) throw new Error("AniKappa title was not found: " + id);
    var name = S(heading.text()).trim();
    var poster = document.selectFirst(".poster-card img, meta[property='og:image']");
    var posterUrl = null;
    if (poster !== null) posterUrl = S(poster.absUrl("src")) || S(poster.attr("content")) || null;
    var description = document.selectFirst(".fullstory__about-text");
    var episodeCount = field(document, "Серій");
    var yearMatch = /(19|20)\d{2}/.exec(S(field(document, "Дата виходу")));
    var genres = [];
    var genreLabel = document.select(".info-card__list-item span");
    for (var i = 0; i < genreLabel.size(); i++) {
        if (S(genreLabel.get(i).text()).replace(/:\s*$/, "") !== "Жанр") continue;
        var links = genreLabel.get(i).parent().select("a");
        for (var j = 0; j < links.size(); j++) genres.push(S(links.get(j).text()).trim());
        break;
    }
    var status = S(field(document, "Статус")).toLowerCase();
    return title({
        id: id, russianName: name, englishName: field(document, "Назва англійською"),
        originalName: field(document, "Назва японською") || name,
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        type: typeOf(field(document, "Тип")), episodeCount: episodeCount ? parseInt(episodeCount, 10) : null,
        posterUrl: posterUrl, status: status.indexOf("вийш") >= 0 ? "released" : status.indexOf("онго") >= 0 ? "ongoing" : null,
        description: description === null ? null : S(description.text()).trim(), genres: genres
    });
}

function playerHtml(postId, select) {
    var path = "/engine/ajax/controller.php?mod=iframe_player&post_id=" + encodeURIComponent(postId);
    if (select) path += "&select=" + encodeURIComponent(select);
    var body = JSON.parse(request(path, { headers: { "X-Requested-With": "XMLHttpRequest" } }));
    if (!body.success || !body.player) throw new Error("AniKappa player is unavailable");
    return S(body.player);
}

function options(document, name) {
    var select = document.selectFirst(".select[data-name='" + name + "']");
    if (select === null) return [];
    var nodes = select.select(".option[data-value]");
    var result = [];
    for (var i = 0; i < nodes.size(); i++) result.push({ id: S(nodes.get(i).attr("data-value")), title: S(nodes.get(i).text()).trim() });
    return result;
}

function postId(titleId) { return /^.*?(\d+)-/.exec(normalizedId(titleId))[1]; }

function buildSelect(source, dubbing, series) {
    var values = [];
    if (source) values.push("source=" + encodeURIComponent(source));
    if (dubbing) values.push("dubbing=" + encodeURIComponent(dubbing));
    if (series) values.push("series=" + encodeURIComponent(series));
    return values.join("&");
}

function collectGroups(titleId) {
    var first = Jsoup.parseBodyFragment(playerHtml(postId(titleId)), BASE_URL);
    var sources = options(first, "source");
    var groups = [];
    for (var s = 0; s < sources.length; s++) {
        var source = sources[s];
        var sourceDocument = Jsoup.parseBodyFragment(playerHtml(postId(titleId), buildSelect(source.id)), BASE_URL);
        var dubbings = options(sourceDocument, "dubbing");
        for (var d = 0; d < dubbings.length; d++) {
            var dubbing = dubbings[d];
            var episodesDocument = Jsoup.parseBodyFragment(playerHtml(postId(titleId), buildSelect(source.id, dubbing.id)), BASE_URL);
            var series = options(episodesDocument, "series");
            if (!series.length) continue;
            var groupId = source.id + ":" + dubbing.id;
            groups.push({
                id: groupId,
                title: dubbing.title + " · " + source.title,
                episodes: series.map(function (episode) {
                    var numberMatch = EPISODE_NUMBER.exec(episode.title);
                    return { id: groupId + ":" + episode.id, number: numberMatch ? parseFloat(numberMatch[1].replace(",", ".")) : parseFloat(episode.id), title: episode.title };
                }),
                qualityLabel: source.title.toLowerCase().indexOf("суб") >= 0 ? "SUB" : null
            });
        }
    }
    return groups;
}

function listingPath(request, page) {
    var type = (request.typeAliases || [])[0];
    var genre = (request.includedGenreAliases || [])[0];
    var root = genre ? "/zhanri/" + encodeURIComponent(genre) + "/" :
        type === "movie" ? "/filmi/" : type === "ova" ? "/ova/" : type === "ona" ? "/ona/" : type === "special" ? "/special/" : "/seriali/";
    return page > 1 ? root + "page/" + page + "/" : root;
}

var Provider = {
    search: function (requestJson) {
        var requestObject = JSON.parse(requestJson);
        var offset = Math.max(requestObject.offset || 0, 0), limit = Math.min(Math.max(requestObject.limit || 20, 1), MAX_RESULTS);
        var query = S(requestObject.query).trim();
        if (query) {
            var page = Math.floor(offset / 10) + 1;
            var items = parseCards(request("/index.php?do=search", { method: "POST", form: { do: "search", subaction: "search", story: query, search_start: page, result_from: (page - 1) * 10 + 1, full_search: 0 } }));
            return items.slice(offset % 10, (offset % 10) + limit);
        }
        var firstPage = Math.floor(offset / 25) + 1;
        var items = [];
        while (items.length < (offset % 25) + limit) {
            var pageItems = parseCards(request(listingPath(requestObject, firstPage)));
            items = items.concat(pageItems);
            if (pageItems.length < 25) break;
            firstPage += 1;
        }
        return items.slice(offset % 25, (offset % 25) + limit);
    },

    latest: function (limit) { return parseCards(request("/"), ".card-update").slice(0, Math.min(limit || 20, MAX_RESULTS)); },
    getById: function (id) { return details(id); },
    getSettings: function () {
        var document = Jsoup.parse(request("/"), BASE_URL), genres = document.select("a[href*='/zhanri/']"), options = [], seen = {};
        for (var i = 0; i < genres.size(); i++) {
            var href = S(genres.get(i).attr("href")), match = /\/zhanri\/([^/]+)\/?$/.exec(href), label = S(genres.get(i).text()).trim();
            if (match && label && !seen[match[1]]) { seen[match[1]] = true; options.push({ id: match[1], title: label }); }
        }
        return { typeOptions: [{ id: "tv", title: "ТБ-серіал" }, { id: "movie", title: "Фільм" }, { id: "ova", title: "OVA" }, { id: "ona", title: "ONA" }, { id: "special", title: "Спешл" }], genreOptions: options };
    },
    getPlaybackGroups: function (titleId) { return collectGroups(titleId); },
    getPlayerLinks: function (titleId, groupId, episodeId) {
        var parts = S(episodeId).split(":"), source = parts[0], dubbing = parts[1], series = parts[2];
        var document = Jsoup.parseBodyFragment(playerHtml(postId(titleId), buildSelect(source, dubbing, series)), BASE_URL);
        var frame = document.selectFirst(".iframeContainer iframe[src]");
        if (frame === null) throw new Error("AniKappa episode is unavailable: " + episodeId);
        return [{ url: S(frame.absUrl("src")), type: "EMBED", quality: null, headers: { "Referer": BASE_URL + "/" }, playerName: null, translation: null, segments: [], videoId: null }];
    }
};
