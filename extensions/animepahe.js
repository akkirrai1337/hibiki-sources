// AnimePahe scripted extension for Hibiki. Every request needs to survive a Cloudflare browser
// challenge, so every fetch goes through `fetchChallenged`, mirroring
// org.akkirrai.beakokit.http.ChallengeRequestExecutor exactly: try once with no session; if the
// response is 403 or carries a `cf-mitigated: challenge` header, ask the host for a session via
// the `challenge()` global and retry with its cookies/User-Agent; if still challenged, force a
// fresh session and retry once more. Ported from the compiled-in AnimePaheClient/AnimePaheHttpClient.

function S(value) { return value === null || value === undefined ? null : String(value); }

var BASE_URL = "https://animepahetv.to";
var MAX_RESULTS = 50;
var SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
var CLOUDFLARE_COOKIE = "cf_clearance";
var BROWSER_USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

var summaries = {};
var dubPlayerIds = {};

function isBrowserChallenge(response) {
    return response.status === 403 || String((response.headers && response.headers["cf-mitigated"]) || "").toLowerCase() === "challenge";
}

function sendChallenged(url, options, session) {
    var merged = { method: options.method, headers: {}, form: options.form, body: options.body };
    for (var key in options.headers) merged.headers[key] = options.headers[key];
    if (session) {
        merged.headers["Cookie"] = session.cookieHeader;
        merged.headers["User-Agent"] = session.userAgent;
    }
    return fetch(url, merged);
}

function fetchChallenged(url, options) {
    var first = sendChallenged(url, options, null);
    if (!isBrowserChallenge(first)) return first;

    var session = challenge(url, [CLOUDFLARE_COOKIE], false);
    var second = sendChallenged(url, options, session);
    if (!isBrowserChallenge(second)) return second;

    var refreshed = challenge(url, [CLOUDFLARE_COOKIE], true);
    return sendChallenged(url, options, refreshed);
}

function get(path, extraHeaders) {
    var headers = {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    };
    for (var key in extraHeaders) headers[key] = extraHeaders[key];
    var response = fetchChallenged(BASE_URL + path, { headers: headers });
    if (response.status < 200 || response.status >= 300) {
        throw new Error("AnimePahe returned HTTP " + response.status + " for " + path);
    }
    return S(response.body);
}

function sessionId(id) {
    var trimmed = String(id).trim().replace(/^\/+|\/+$/g, "").split("/")[0];
    if (!SESSION_ID.test(trimmed)) throw new Error("AnimePahe title id is invalid: " + id);
    return trimmed;
}

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

function merge(summary, details) {
    if (!summary) return details;
    var merged = title(details);
    merged.englishName = details.englishName || summary.englishName;
    merged.year = details.year !== null ? details.year : summary.year;
    merged.type = details.type || summary.type;
    merged.episodeCount = details.episodeCount !== null ? details.episodeCount : summary.episodeCount;
    merged.posterUrl = details.posterUrl || summary.posterUrl;
    merged.status = details.status || summary.status;
    merged.description = details.description || summary.description;
    merged.ratings = (details.ratings && details.ratings.length > 0) ? details.ratings : (summary.ratings || []);
    return merged;
}

function imageUrl(el) {
    if (el === null) return null;
    return S(el.attr("src")) || S(el.attr("data-src")) || null;
}

function fieldValue(info, label) {
    if (info === null) return null;
    var paragraphs = info.select("p");
    for (var i = 0; i < paragraphs.size(); i++) {
        var p = paragraphs.get(i);
        var strong = p.selectFirst("strong");
        if (strong === null) continue;
        var strongText = S(strong.text()).trim();
        if (strongText.toLowerCase().indexOf(label.toLowerCase()) !== 0) continue;
        var full = S(p.text());
        var colonIndex = full.indexOf(":");
        var value = (colonIndex >= 0 ? full.substring(colonIndex + 1) : full).trim();
        if (value.length > 0) return value;
    }
    return null;
}

function parseCards(html) {
    var document = Jsoup.parse(html, BASE_URL);
    var items = document.select(".anime-item");
    var results = [];
    var seen = {};
    for (var i = 0; i < items.size(); i++) {
        var item = items.get(i);
        if (item.selectFirst(".lang-dub") === null) continue;
        var link = item.selectFirst(".anime-name a[href], a.anime-poster[href]");
        if (link === null) continue;
        var href = S(link.absUrl("href"));
        var id = href.substring(href.lastIndexOf("/") + 1).split("?")[0];
        if (!SESSION_ID.test(id) || seen[id]) continue;

        var nameEl = item.selectFirst(".anime-name a");
        var name = nameEl !== null ? S(nameEl.text()).trim() : null;
        if (!name) {
            var imgAlt = item.selectFirst("img[alt]");
            name = imgAlt !== null ? S(imgAlt.attr("alt")).trim() : null;
        }
        if (!name) continue;

        var scoreEl = item.selectFirst(".anime-score");
        var score = scoreEl !== null ? parseFloat(S(scoreEl.text()).trim()) : NaN;

        var yearEl = item.selectFirst(".anime-year");
        var year = yearEl !== null ? parseInt(S(yearEl.text()).trim(), 10) : NaN;

        var episodesEl = item.selectFirst(".anime-episodes");
        var episodeMatch = episodesEl !== null ? /\d+/.exec(S(episodesEl.text())) : null;

        var typeEl = item.selectFirst(".anime-type");
        var statusEl = item.selectFirst(".anime-status");

        seen[id] = true;
        results.push(title({
            id: id,
            englishName: name,
            originalName: name,
            year: isNaN(year) ? null : year,
            type: typeEl !== null ? S(typeEl.text()).trim() : null,
            episodeCount: episodeMatch !== null ? parseInt(episodeMatch[0], 10) : null,
            posterUrl: imageUrl(item.selectFirst(".anime-poster img")),
            status: statusEl !== null ? S(statusEl.text()).trim() : null,
            ratings: isNaN(score) ? [] : [{ source: "AnimePahe", value: score, votes: null }],
        }));
    }
    return results;
}

function parseDetails(id, html) {
    var document = Jsoup.parse(html, BASE_URL);
    var name = null;
    var spanTitle = document.selectFirst(".page-detail h1 > span:not(.sr-only)");
    if (spanTitle !== null) name = S(spanTitle.text()).trim();
    if (!name) {
        var heading = document.selectFirst(".page-detail h1");
        if (heading !== null) {
            var clone = heading.clone();
            var srOnly = clone.select(".sr-only");
            for (var i = 0; i < srOnly.size(); i++) srOnly.get(i).remove();
            name = S(clone.text()).trim();
        }
    }
    if (!name) {
        var ogTitle = document.selectFirst("meta[property=og:title]");
        if (ogTitle !== null) name = S(ogTitle.attr("content")).trim();
    }
    if (!name) name = summaries[id] ? summaries[id].originalName : null;
    if (!name) throw new Error("AnimePahe title is missing for " + id);

    var info = document.selectFirst(".anime-info");
    var aired = fieldValue(info, "Aired");
    var yearMatch = aired ? /(?:19|20)\d{2}/.exec(aired) : null;
    var synonymsField = fieldValue(info, "Synonyms");
    var synonyms = synonymsField ? synonymsField.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; }) : [];

    var posterEl = document.selectFirst(".anime-poster img");
    var posterUrl = imageUrl(posterEl);
    if (!posterUrl) {
        var ogImage = document.selectFirst("meta[property=og:image]");
        posterUrl = ogImage !== null ? S(ogImage.attr("content")).trim() : null;
    }

    var episodeField = fieldValue(info, "Episode");
    var episodeMatch = episodeField ? /\d+/.exec(episodeField) : null;

    var japaneseHeading = document.selectFirst("h2.japanese");
    var genreLinks = document.select(".anime-genre a");
    var genres = [];
    for (var g = 0; g < genreLinks.size(); g++) {
        var genreText = S(genreLinks.get(g).text()).trim();
        if (genreText.length > 0) genres.push(genreText);
    }

    var studioLinks = info !== null ? info.select("a[href*=/studio/]") : null;
    var studios = [];
    if (studioLinks !== null) {
        for (var s = 0; s < studioLinks.size(); s++) {
            var studioText = S(studioLinks.get(s).text()).trim();
            if (studioText.length > 0) studios.push(studioText);
        }
    }

    var synopsisEl = document.selectFirst(".anime-synopsis");
    var description = synopsisEl !== null ? S(synopsisEl.text()).trim() : null;
    if (description !== null && description.length === 0) description = null;

    return title({
        id: id,
        englishName: name,
        originalName: name,
        japaneseName: fieldValue(info, "Japanese") || (japaneseHeading !== null ? S(japaneseHeading.text()).trim() : null),
        synonyms: synonyms,
        year: yearMatch !== null ? parseInt(yearMatch[0], 10) : null,
        type: fieldValue(info, "Type"),
        episodeCount: episodeMatch !== null ? parseInt(episodeMatch[0], 10) : null,
        posterUrl: posterUrl,
        status: fieldValue(info, "Status"),
        description: description,
        genres: genres,
        studios: studios,
    });
}

function parseDubEpisodes(html, titleSession) {
    var match = /allEpisodes:\s*(\[[\s\S]*?\])\s*,\s*episodesPerDropdown/.exec(html);
    if (match === null) return [];
    var array;
    try { array = JSON.parse(match[1]); } catch (ignored) { return []; }
    var episodes = [];
    var seen = {};
    for (var i = 0; i < array.length; i++) {
        var item = array[i];
        var hasDubMain = false;
        if (item.main_servers) {
            try {
                var mainServers = JSON.parse(item.main_servers);
                hasDubMain = Array.isArray(mainServers.dub) && mainServers.dub.length > 0;
            } catch (ignored2) { hasDubMain = false; }
        }
        if (item.is_dub !== true && !hasDubMain) continue;
        var session = item.md5_id;
        if (!session) continue;
        var number = typeof item.chapter_number === "string" ? parseFloat(item.chapter_number) : item.chapter_number;
        if (number === undefined || number === null || isNaN(number)) continue;
        if (item.s_id !== undefined && item.s_id !== null) dubPlayerIds[session] = String(item.s_id);
        var id = titleSession + "/" + session;
        if (seen[id]) continue;
        seen[id] = true;
        episodes.push({ id: id, number: number, title: item.title || null });
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
}

function releasePage(session, page) {
    var response = fetchChallenged(BASE_URL + "/viewApi?m=release&id=" + session + "&sort=episode_asc&page=" + page, {
        headers: {
            "User-Agent": BROWSER_USER_AGENT, "Accept": "application/json",
            "Referer": BASE_URL + "/anime/" + session, "X-Requested-With": "XMLHttpRequest",
        },
    });
    if (response.status < 200 || response.status >= 300) throw new Error("AnimePahe returned HTTP " + response.status);
    var json = JSON.parse(S(response.body));
    if (!json || typeof json !== "object") throw new Error("AnimePahe returned invalid JSON");
    return json;
}

function episodeFromRelease(item, titleSession) {
    if (!item.session || item.episode === undefined || item.episode === null) return null;
    return { id: titleSession + "/" + item.session, number: item.episode, title: item.title || null };
}

function getEpisodesInternal(titleSession) {
    var firstPage = releasePage(titleSession, 1);
    var firstEpisodeSession = null;
    var firstData = firstPage.data || [];
    for (var i = 0; i < firstData.length; i++) {
        if (firstData[i].session) { firstEpisodeSession = firstData[i].session; break; }
    }
    if (firstEpisodeSession !== null) {
        var playHtml = get("/play/" + titleSession + "/" + firstEpisodeSession, { "Referer": BASE_URL + "/anime/" + titleSession });
        var dubEpisodes = parseDubEpisodes(playHtml, titleSession);
        if (dubEpisodes.length > 0) return dubEpisodes;
    }

    var episodes = [];
    var page = 1;
    var root = firstPage;
    do {
        var data = root.data || [];
        for (var d = 0; d < data.length; d++) {
            var episode = episodeFromRelease(data[d], titleSession);
            if (episode !== null) episodes.push(episode);
        }
        page += 1;
        var lastPage = root.last_page || 1;
        if (page <= lastPage) root = releasePage(titleSession, page);
    } while (page <= (root.last_page || 1));

    var seen = {};
    var distinctEpisodes = [];
    for (var e = 0; e < episodes.length; e++) {
        if (seen[episodes[e].id]) continue;
        seen[episodes[e].id] = true;
        distinctEpisodes.push(episodes[e]);
    }
    distinctEpisodes.sort(function (a, b) { return a.number - b.number; });
    return distinctEpisodes;
}

function loadDubPlayerId(titleSession, episodeSession) {
    var playHtml = get("/play/" + titleSession + "/" + episodeSession, { "Referer": BASE_URL + "/anime/" + titleSession });
    parseDubEpisodes(playHtml, titleSession);
    return dubPlayerIds[episodeSession] || null;
}

function synthesizeDubLinks(playerId, endpoint) {
    return [
        { name: "Megaplay", url: "https://megaplay.buzz/stream/s-2/" + playerId + "/dub" },
        { name: "Vidplay", url: "https://vidwish.live/stream/s-2/" + playerId + "/dub" },
    ].map(function (entry) {
        return {
            url: entry.url, type: "EMBED", quality: null,
            headers: { "Referer": endpoint }, playerName: entry.name, translation: "English dub",
            segments: [], videoId: null,
        };
    });
}

function loadHtmlPages(path, queryPrefix, wanted) {
    var results = {};
    var order = [];
    var page = 1;
    var hasNext = true;
    while (order.length < wanted && hasNext) {
        var query = queryPrefix + (page > 1 ? "&page=" + page : "");
        var pageHtml = get(path + (query ? "?" + query : ""), null);
        var cards = parseCards(pageHtml);
        for (var i = 0; i < cards.length; i++) {
            var merged = merge(results[cards[i].id] || summaries[cards[i].id], cards[i]);
            if (!results[cards[i].id]) order.push(cards[i].id);
            results[cards[i].id] = merged;
            summaries[cards[i].id] = merged;
        }
        var document = Jsoup.parse(pageHtml, BASE_URL);
        var links = document.select("a[href]");
        hasNext = false;
        for (var l = 0; l < links.size(); l++) {
            var href = S(links.get(l).absUrl("href"));
            if (href.indexOf(path) >= 0 && href.indexOf("page=" + (page + 1)) >= 0) { hasNext = true; break; }
        }
        page += 1;
    }
    var list = [];
    for (var o = 0; o < order.length; o++) list.push(results[order[o]]);
    return list;
}

var Provider = {
    search: function (requestJson) {
        var request = JSON.parse(requestJson);
        var offset = Math.max(request.offset || 0, 0);
        var limit = Math.min(Math.max(request.limit || 20, 1), MAX_RESULTS);
        var query = (request.query || "").trim();
        var path = query.length === 0 ? "/latest-updated" : "/search";
        var queryPrefix = query.length === 0 ? "" : ("q=" + encodeURIComponent(query));
        var titles = loadHtmlPages(path, queryPrefix, offset + limit);
        return titles.slice(offset, offset + limit);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        return loadHtmlPages("/latest-updated", "", safeLimit).slice(0, safeLimit);
    },

    getById: function (id) {
        var session = sessionId(id);
        var parsed = parseDetails(session, get("/anime/" + session, null));
        var mergedTitle = merge(summaries[session], parsed);
        summaries[session] = mergedTitle;
        return mergedTitle;
    },

    getSettings: function () {
        return { sortOptions: [{ id: "relevance", title: "Relevance" }] };
    },

    getPlaybackGroups: function (titleId) {
        var session = sessionId(titleId);
        var episodes = getEpisodesInternal(session);
        if (episodes.length === 0) return [];
        return [{ id: session, title: "English dub", episodes: episodes, qualityLabel: null }];
    },

    getPlayerLinks: function (titleId, groupId, episodeId) {
        var slashIndex = episodeId.indexOf("/");
        var episodeSession = slashIndex >= 0 ? episodeId.substring(slashIndex + 1) : "";
        if (!SESSION_ID.test(episodeSession)) return [];
        var titleSession = slashIndex >= 0 ? episodeId.substring(0, slashIndex) : "";
        var endpoint = BASE_URL + "/anime/get-servers/" + episodeSession;
        var response = fetchChallenged(endpoint, {
            headers: {
                "User-Agent": BROWSER_USER_AGENT, "Accept": "application/json",
                "Referer": BASE_URL + "/play/" + episodeId, "X-Requested-With": "XMLHttpRequest",
            },
        });
        if (response.status < 200 || response.status >= 300) throw new Error("AnimePahe returned HTTP " + response.status);
        var root = JSON.parse(S(response.body));
        var servers = root.servers || [];
        var links = [];
        var seen = {};
        for (var i = 0; i < servers.length; i++) {
            var server = servers[i];
            if (!server.name || String(server.name).toLowerCase().indexOf("dub-") !== 0) continue;
            if (!server.url || seen[server.url]) continue;
            seen[server.url] = true;
            var resolution = server.resolution && String(server.resolution).toLowerCase() !== "multi" ? server.resolution : null;
            links.push({
                url: server.url, type: "EMBED", quality: resolution,
                headers: { "Referer": endpoint },
                playerName: server.name.indexOf("-") >= 0 ? server.name.substring(server.name.indexOf("-") + 1) : server.name,
                translation: "English dub", segments: [], videoId: null,
            });
        }
        if (links.length > 0) return links;

        var playerId = dubPlayerIds[episodeSession] || loadDubPlayerId(titleSession, episodeSession);
        return playerId ? synthesizeDubLinks(playerId, endpoint) : [];
    },
};
