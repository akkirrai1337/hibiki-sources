// HentaiMama scripted extension for Hibiki.
//
// Ported from yuzono/anime-extensions' HentaiMama source, but updated for the
// site's current DooPlay markup. Player mirrors are loaded lazily through the
// WordPress AJAX endpoint; their embed pages contain JW Player's direct MP4 URL.

function S(value) { return value === null || value === undefined ? null : String(value); }

var BASE_URL = "https://hentaimama.io";
var USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
var MAX_RESULTS = 50;
var summaries = {};

function title(fields) { return AnimeTitle(fields); }

function request(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers["User-Agent"] = USER_AGENT;
    options.headers["Referer"] = BASE_URL + "/";
    var response = fetch(url, options);
    if (!response.ok) throw new Error("HentaiMama returned HTTP " + response.status + " for " + url);
    return S(response.body);
}

function pathFromUrl(url) {
    var value = S(url) || "";
    if (value.indexOf(BASE_URL) === 0) value = value.substring(BASE_URL.length);
    value = value.split("?")[0];
    return value.replace(/^\/+|\/+$/g, "");
}

function absolute(path) { return BASE_URL + "/" + String(path).replace(/^\/+/, ""); }

function imageUrl(element) {
    if (element === null) return null;
    var url = S(element.absUrl("src"));
    if (!url) url = S(element.absUrl("data-src"));
    return url || null;
}

function parseCard(element) {
    var link = element.selectFirst(".poster a[href], .data h3 a[href], a[href*='/tvshows/']");
    if (link === null) return null;
    var id = pathFromUrl(S(link.absUrl("href")));
    if (id.indexOf("tvshows/") !== 0) return null;
    var name = S(link.attr("aria-label")) || S(link.text());
    if (!name || name.trim().length === 0) {
        var heading = element.selectFirst(".data h3 a, h3 a");
        name = heading === null ? null : S(heading.text());
    }
    if (!name || name.trim().length === 0) return null;
    var yearElement = element.selectFirst(".card-tags .tag, .data .tag");
    var year = yearElement === null ? NaN : parseInt(S(yearElement.text()), 10);
    var parsed = title({
        id: id,
        englishName: name.trim(),
        originalName: name.trim(),
        year: isNaN(year) ? null : year,
        type: "tv",
        episodeCount: null,
        availableEpisodeCount: null,
        posterUrl: imageUrl(element.selectFirst(".poster img, img")),
        status: null,
        description: null,
        genres: [],
        studios: [],
        ratings: [],
    });
    summaries[id] = parsed;
    return parsed;
}

function parseCards(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var elements = document.select("article.item.tvshows, article.tvshows, article");
    var result = [];
    var seen = {};
    for (var i = 0; i < elements.size(); i++) {
        var parsed = parseCard(elements.get(i));
        if (parsed === null || seen[parsed.id]) continue;
        seen[parsed.id] = true;
        result.push(parsed);
    }
    return result;
}

function pageUrl(page) {
    return page <= 1 ? BASE_URL + "/tvshows/" : BASE_URL + "/tvshows/page/" + page + "/";
}

function latestInternal(offset, limit) {
    var wanted = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
    var page = Math.floor(Math.max(offset || 0, 0) / 18) + 1;
    var skip = Math.max(offset || 0, 0) % 18;
    var result = [];
    while (result.length < wanted) {
        var cards = parseCards(request(pageUrl(page)));
        if (cards.length === 0) break;
        for (var i = skip; i < cards.length && result.length < wanted; i++) result.push(cards[i]);
        if (cards.length < 18) break;
        page += 1;
        skip = 0;
    }
    return result;
}

function meta(document, property) {
    var element = document.selectFirst("meta[property='" + property + "'], meta[name='" + property + "']");
    if (element === null) return null;
    var value = S(element.attr("content"));
    return value && value.trim().length > 0 ? value.trim() : null;
}

function parseDetails(id, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var heading = document.selectFirst(".dtsingle h1, h1");
    var name = heading === null ? null : S(heading.text());
    if (!name || name.trim().length === 0) name = summaries[id] ? summaries[id].originalName : null;
    if (!name) throw new Error("HentaiMama title is missing: " + id);

    var description = meta(document, "og:description");
    var posterUrl = meta(document, "og:image");
    var genreElements = document.select(".dsc-chips a[rel=tag], .sgeneros a, a[href*='/genre/']");
    var genres = [];
    var seenGenres = {};
    for (var i = 0; i < genreElements.size(); i++) {
        var genre = S(genreElements.get(i).text());
        if (genre && genre.trim().length > 0 && !seenGenres[genre]) {
            seenGenres[genre] = true;
            genres.push(genre.trim());
        }
    }
    var episodeCount = null;
    var jsonLd = document.selectFirst("script[type='application/ld+json']");
    if (jsonLd !== null) {
        var countMatch = /"numberOfEpisodes"\s*:\s*(\d+)/.exec(S(jsonLd.data()));
        if (countMatch !== null) episodeCount = parseInt(countMatch[1], 10);
    }
    var status = description && /\bongoing\b/i.test(description) ? "ongoing" : null;
    return title({
        id: id,
        englishName: name.trim(),
        originalName: name.trim(),
        year: summaries[id] ? summaries[id].year : null,
        type: "tv",
        episodeCount: episodeCount,
        availableEpisodeCount: episodeCount,
        posterUrl: posterUrl,
        status: status,
        description: description,
        genres: genres,
        studios: [],
        ratings: [],
    });
}

function episodes(titleId) {
    var document = Jsoup.parse(request(absolute(titleId)), BASE_URL);
    var links = document.select("a.dt-se-item[href*='/episodes/'], #episodes a[href*='/episodes/']");
    var result = [];
    var seen = {};
    for (var i = 0; i < links.size(); i++) {
        var link = links.get(i);
        var id = pathFromUrl(S(link.absUrl("href")));
        if (!id || seen[id]) continue;
        var rawName = S(link.selectFirst(".dt-se-title") !== null ? link.selectFirst(".dt-se-title").text() : link.text());
        var numberMatch = /(?:episode|ep)\s*(\d+(?:\.\d+)?)/i.exec(rawName || "");
        seen[id] = true;
        result.push({ id: id, number: numberMatch !== null ? parseFloat(numberMatch[1]) : result.length + 1, title: rawName || null });
    }
    result.sort(function (a, b) { return a.number - b.number; });
    return result;
}

function playerLinks(episodeId) {
    var html = request(absolute(episodeId));
    var postMatch = /action:\s*'get_player_contents',\s*a:\s*'?(\d+)'?/i.exec(html);
    if (postMatch === null) throw new Error("HentaiMama player id is missing: " + episodeId);
    var postId = postMatch[1];
    var links = [];
    var seen = {};
    for (var mirror = 1; mirror <= 4; mirror++) {
        var response = request(BASE_URL + "/wp-admin/admin-ajax.php", {
            method: "POST",
            form: { action: "get_player_contents", a: postId, i: String(mirror) },
        });
        // DooPlay returns a JSON array of iframe fragments. Matching the raw response fails
        // because its HTML quotes are still escaped (`src=\"…\"`). Decode it first, just like
        // the site's own player script does, then inspect the selected mirror fragment.
        var iframeHtml;
        try {
            iframeHtml = JSON.parse(response)[mirror - 1] || "";
        } catch (error) {
            continue;
        }
        var iframeMatch = /<iframe[^>]+src=["']([^"']+)/i.exec(iframeHtml);
        if (iframeMatch === null) continue;
        var embedUrl = S(Jsoup.resolve(BASE_URL, iframeMatch[1].replace(/&#038;/g, "&")));
        var embedHtml = request(embedUrl, { headers: { "Referer": absolute(episodeId) } });
        var videoMatch = /(?:file|src)\s*:\s*["'](https?:\\?\/\\?\/[^"']+\.(?:mp4|m3u8)[^"']*)/i.exec(embedHtml);
        if (videoMatch === null) continue;
        var videoUrl = videoMatch[1].replace(/\\\//g, "/");
        if (seen[videoUrl]) continue;
        seen[videoUrl] = true;
        links.push({
            url: videoUrl,
            type: /\.m3u8(?:[?#]|$)/i.test(videoUrl) ? "DIRECT_HLS" : "DIRECT_MP4",
            quality: "Mirror " + mirror,
            headers: { "Referer": embedUrl },
            playerName: "HentaiMama",
            translation: "English subtitles",
            segments: [],
            videoId: null,
        });
    }
    return links;
}

var Provider = {
    search: function (requestJson) {
        var query = (JSON.parse(requestJson).query || "").trim();
        var requestData = JSON.parse(requestJson);
        if (query.length === 0) return latestInternal(requestData.offset || 0, requestData.limit || 20);
        var cards = parseCards(request(BASE_URL + "/?s=" + encodeURIComponent(query)));
        var start = Math.max(requestData.offset || 0, 0);
        return cards.slice(start, start + Math.min(Math.max(requestData.limit || 20, 1), MAX_RESULTS));
    },

    latest: function (limit) { return latestInternal(0, limit || 20); },

    getById: function (id) {
        var cleanId = pathFromUrl(id);
        if (cleanId.indexOf("tvshows/") !== 0) throw new Error("HentaiMama title id is invalid: " + id);
        var parsed = parseDetails(cleanId, request(absolute(cleanId)));
        summaries[cleanId] = parsed;
        return parsed;
    },

    getSettings: function () { return { sortOptions: [{ id: "relevance", title: "Relevance" }] }; },

    getPlaybackGroups: function (titleId) {
        var cleanId = pathFromUrl(titleId);
        var list = episodes(cleanId);
        return list.length === 0 ? [] : [{ id: cleanId, title: "English subtitles", episodes: list, qualityLabel: null }];
    },

    getPlayerLinks: function (titleId, groupId, episodeId) { return playerLinks(pathFromUrl(episodeId)); },
};
