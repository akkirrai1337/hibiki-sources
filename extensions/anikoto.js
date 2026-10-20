// AniKoto scripted source.
// The site uses normal HTML for catalog/details and an XHR endpoint for episodes. Server links
// are opaque per-episode tokens; they are intentionally passed to /ajax/server unchanged.

// Posters on this site run to 530KB (PNGs); images.weserv.nl serves the same picture resized to the
// 400px the app shows at most, as WebP - a few times smaller. The app falls back to the original
// when the proxy fails, and opens the original when the poster is shown full screen.
var POSTER_RESIZE_URL = "https://images.weserv.nl/";

function resizedPoster(url) {
    if (!url || url.indexOf("http") !== 0) return url || null;
    return POSTER_RESIZE_URL + "?url=" + encodeURIComponent(url) + "&w=400&h=600&fit=inside&we&output=webp&q=75";
}

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

// The site's own filter form (GET /filter) is the whole filter surface, so it is read off the live
// page instead of being hard-coded: a genre, source or sort the site adds later shows up without an
// extension update. One fetch per session; a failed read just means no filters, never a broken search.
var FILTER_FIELDS = [
    { id: "genres", param: "genre[]", title: "Genres" },
    { id: "season", param: "season[]", title: "Season" },
    { id: "year", param: "year[]", title: "Year" },
    { id: "type", param: "term_type[]", title: "Type" },
    { id: "status", param: "status[]", title: "Status" },
    { id: "language", param: "language[]", title: "Language" },
    { id: "rating", param: "rating[]", title: "Rating" },
    { id: "source", param: "source[]", title: "Source" },
];
var cachedFilterDefs = null;
var cachedSorts = null;

function formOptions(document, param) {
    var inputs = document.select("form.filters input[name='" + param + "']");
    var options = [];
    for (var i = 0; i < inputs.size(); i++) {
        var input = inputs.get(i);
        var value = S(input.attr("value")).trim();
        if (!value) continue;
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
        var document = Jsoup.parse(request("/filter"), BASE_URL);
        var sorts = formOptions(document, "sort");
        if (sorts.length > 0) cachedSorts = sorts;
        FILTER_FIELDS.forEach(function (field) {
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

/** "&genre[]=1&sort=score" for the picked filters, or "" when none is set. */
function siteFilterQuery(filters, sort) {
    filters = filters || {};
    var parts = [];
    FILTER_FIELDS.forEach(function (field) {
        var values = filters[field.id];
        if (!values) return;
        (Array.isArray(values) ? values : [values]).forEach(function (value) {
            parts.push(encodeURIComponent(field.param) + "=" + encodeURIComponent(value));
        });
    });
    // The site's own sort values; its "default" needs no parameter.
    if (sort && sort !== "default") parts.push("sort=" + encodeURIComponent(sort));
    return parts.length > 0 ? "&" + parts.join("&") : "";
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
        posterUrl: poster === null ? null : resizedPoster(S(poster.absUrl("src"))),
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

function loadCatalog(path) {
    // AniKoto currently ignores `page` on both its home and filter routes: every
    // requested page repeats the first result set. Do not keep requesting those
    // duplicates, otherwise the site eventually answers with HTTP 500.
    return parseCards(request(path));
}

// A short card (the "Recommended" sidebar and the watch order share it): the title's slug, name, poster,
// and the type / year the meta dots carry.
function relatedStub(el) {
    // The recommended cards are the link themselves; the watch-order ones contain it.
    var link = S(el.attr("href")).indexOf("/watch/") >= 0 ? el : el.selectFirst("a[href*='/watch/']");
    if (link === null) return null;
    var id = slugFromHref(S(link.absUrl("href")));
    if (!id) return null;
    var img = el.selectFirst("img");
    var nameEl = el.selectFirst(".name");
    var name = S(nameEl !== null ? nameEl.text() : (img !== null ? img.attr("alt") : "")).trim();
    if (!name) return null;
    var type = null;
    var year = null;
    var dots = el.select(".meta .dot");
    for (var k = 0; k < dots.size(); k++) {
        var text = S(dots.get(k).text()).trim();
        var yearMatch = /^(19\d{2}|20\d{2})$/.exec(text);
        if (yearMatch !== null) year = parseInt(yearMatch[1], 10);
        else if (type === null && /^(tv|movie|ova|ona|special)$/i.test(text)) type = normalizeType(text);
    }
    return { id: id, title: name, posterUrl: img === null ? null : resizedPoster(S(img.absUrl("src"))), type: type, year: year, episodeCount: null, status: null };
}

function stubsFrom(elements) {
    var result = [];
    var seen = {};
    for (var i = 0; i < elements.size(); i++) {
        var stub = relatedStub(elements.get(i));
        if (stub === null || seen[stub.id]) continue;
        seen[stub.id] = true;
        result.push(stub);
    }
    return result;
}

function parseRecommended(document) {
    var sections = document.select(".w-side-section");
    for (var i = 0; i < sections.size(); i++) {
        var head = sections.get(i).selectFirst(".head .title");
        if (head !== null && S(head.text()).trim().toLowerCase() === "recommended") return stubsFrom(sections.get(i).select(".body a.item"));
    }
    return [];
}

// The site's own watch order (seasons, films, side stories), a separate request keyed by the numeric id.
// Best effort: a title page must not fail for want of its franchise.
function fetchWatchOrder(id, numericId) {
    if (!numericId) return [];
    try {
        var payload = JSON.parse(request("/api/watch-order/" + numericId, BASE_URL + "/watch/" + id));
        if (!payload || payload.status !== 200 || !payload.result) return [];
        return stubsFrom(Jsoup.parseBodyFragment(S(payload.result), BASE_URL).select(".item.flexserieslist"));
    } catch (error) {
        return [];
    }
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
    var franchise = fetchWatchOrder(id, titleIds[id]);
    return title({
        id: id,
        englishName: name,
        originalName: S(heading.attr("data-jp")) || name,
        japaneseName: S(heading.attr("data-jp")) || null,
        year: yearMatch === null ? null : parseInt(yearMatch[1], 10),
        type: type,
        status: statusText.indexOf("airing") >= 0 ? "ongoing" : (statusText ? "released" : null),
        episodeCount: isNaN(episodeCount) ? null : episodeCount,
        posterUrl: poster === null ? null : resizedPoster(S(poster.absUrl("src"))),
        description: synopsis === null ? null : S(synopsis.text()).trim(),
        genres: genres,
        franchiseAnime: franchise,
        relatedAnime: franchise,
        similarAnime: parseRecommended(document),
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

// MegaPlay, the host behind most of this site's servers, lists an episode's subtitle tracks in its own
// /stream/getSources answer. The hidden browser that resolves the stream only reports the <track>
// elements it finds on the page, and this player does not put them there - so asking MegaPlay for
// the list is what gets the subtitles (the Aniyomi extension does the same). One list serves every
// server of an episode, so it is read once per episode and sound, not once per link.
var MEGAPLAY_EMBED = /^(https?:\/\/(?:megaplay|vidwish)\.[a-z]+)\/(?:videojs\/)?stream\/([^?#]+)/i;

// MegaPlay names a track by whatever the release said, which ends up as "English (CR English)",
// "Spanish (Spanish (Spain))" or a bare "baq". The picker should say the language, and what sets one
// track of it apart from another (Forced, SDH, a region), once. Codes are the 3-letter ones in the
// track's file name (..._eng.vtt): [language name, 2-letter code].
var SUBTITLE_LANGUAGES = {
    ara: ["Arabic", "ar"], baq: ["Basque", "eu"], ben: ["Bengali", "bn"], bul: ["Bulgarian", "bg"], cat: ["Catalan", "ca"],
    chi: ["Chinese", "zh"], zho: ["Chinese", "zh"], cze: ["Czech", "cs"], ces: ["Czech", "cs"], dan: ["Danish", "da"],
    dut: ["Dutch", "nl"], nld: ["Dutch", "nl"], eng: ["English", "en"], fil: ["Filipino", "fil"], fin: ["Finnish", "fi"],
    fre: ["French", "fr"], fra: ["French", "fr"], ger: ["German", "de"], deu: ["German", "de"], glg: ["Galician", "gl"],
    gre: ["Greek", "el"], ell: ["Greek", "el"], heb: ["Hebrew", "he"], hin: ["Hindi", "hi"], hrv: ["Croatian", "hr"],
    hun: ["Hungarian", "hu"], ind: ["Indonesian", "id"], ita: ["Italian", "it"], jpn: ["Japanese", "ja"], kor: ["Korean", "ko"],
    may: ["Malay", "ms"], msa: ["Malay", "ms"], nob: ["Norwegian", "nb"], nor: ["Norwegian", "no"], pol: ["Polish", "pl"],
    por: ["Portuguese", "pt"], rum: ["Romanian", "ro"], ron: ["Romanian", "ro"], rus: ["Russian", "ru"], slo: ["Slovak", "sk"],
    slk: ["Slovak", "sk"], spa: ["Spanish", "es"], swe: ["Swedish", "sv"], tam: ["Tamil", "ta"], tel: ["Telugu", "te"],
    tha: ["Thai", "th"], tur: ["Turkish", "tr"], ukr: ["Ukrainian", "uk"], vie: ["Vietnamese", "vi"],
};

function subtitleCode(file) {
    var match = /_([a-z]{3})\.vtt(?:[?#]|$)/i.exec(file);
    return match === null ? null : match[1].toLowerCase();
}

function cleanSubtitleLabel(label, code) {
    var known = code !== null ? SUBTITLE_LANGUAGES[code] : undefined;
    // A bare code ("baq") is the language's name written the way the file was named.
    if (known && label.toLowerCase() === code) return known[0];
    var match = /^([^()]+?)\s*\((.*)\)$/.exec(label);
    if (match === null) return label;
    var base = match[1].trim();
    // "CR" marks the release group's own copy; it says nothing to the person choosing.
    var inner = match[2].trim().replace(/^CR\s+/i, "");
    if (inner.toLowerCase().indexOf(base.toLowerCase()) !== 0) return base + " (" + inner + ")";
    // The detail repeats the language ("English", "Spanish (Spain)", "Portuguese(Brazil)"): keep only what is added.
    var rest = inner.substring(base.length).trim().replace(/^\((.*)\)$/, "$1").trim();
    return rest ? base + " (" + rest + ")" : base;
}

function megaPlaySubtitles(embedUrl, cache) {
    var match = MEGAPLAY_EMBED.exec(embedUrl);
    if (match === null) return [];
    var key = match[1] + "/" + match[2];
    if (cache[key] !== undefined) return cache[key];
    cache[key] = [];
    try {
        var origin = match[1];
        var page = S(fetch(embedUrl, { headers: { "User-Agent": USER_AGENT, "Referer": BASE_URL + "/", "X-Requested-With": "XMLHttpRequest" } }).body);
        var id = /data-id=["']([^"']+)["']/i.exec(page) || /File\s+(\d+)/i.exec(page);
        if (id === null) return cache[key];
        var server = /[?&]s=([^&#]+)/.exec(embedUrl);
        var response = fetch(origin + "/stream/getSources?id=" + encodeURIComponent(id[1]) + (server === null ? "" : "&s=" + server[1]), {
            headers: { "User-Agent": USER_AGENT, "Accept": "application/json,*/*", "Referer": embedUrl, "X-Requested-With": "XMLHttpRequest" }
        });
        if (!response.ok) return cache[key];
        var tracks = JSON.parse(S(response.body)).tracks || [];
        var files = {};
        var labels = {};
        for (var i = 0; i < tracks.length; i++) {
            var file = S(tracks[i] && tracks[i].file).trim();
            var rawLabel = S(tracks[i] && tracks[i].label).trim();
            // The seek-bar preview sprites come in the same list; they have no label and are not text.
            if (!file || !rawLabel || files[file] || /thumbnail/i.test(S(tracks[i].kind)) || /thumbnails?\.vtt/i.test(file)) continue;
            files[file] = true;
            var code = subtitleCode(file);
            var label = cleanSubtitleLabel(rawLabel, code);
            // Two tracks that clean down to the same words stay tellable apart.
            labels[label] = (labels[label] || 0) + 1;
            if (labels[label] > 1) label = label + " " + labels[label];
            // The subtitle CDN answers 403 to a Referer that is the embed page itself; the host root is what it takes.
            cache[key].push({ url: file, label: label, language: code !== null && SUBTITLE_LANGUAGES[code] ? SUBTITLE_LANGUAGES[code][1] : null, headers: { "Referer": origin + "/", "Origin": origin } });
        }
    } catch (error) {
        // No subtitles is a worse answer than none-yet, never a reason to lose the episode's links.
    }
    return cache[key];
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
    var subtitleCache = {};
    for (var i = 0; i < items.size(); i++) {
        var item = items.get(i);
        var token = S(item.attr("data-link-id"));
        if (!token || seen[token]) continue;
        seen[token] = true;
        var response = JSON.parse(request("/ajax/server?get=" + encodeURIComponent(token), referer));
        if (!response || response.status !== 200 || !response.result || !response.result.url) continue;
        var embedUrl = S(response.result.url);
        links.push({
            url: embedUrl, type: "EMBED", quality: null,
            headers: { "Referer": referer },
            playerName: S(item.text()).trim(),
            translation: type === "dub" ? "English dub" : "English sub",
            segments: [], videoId: null,
            subtitles: megaPlaySubtitles(embedUrl, subtitleCache),
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
        var filterQuery = siteFilterQuery(requestData.filters, requestData.sort);
        var path = query || filterQuery ? "/filter?keyword=" + encodeURIComponent(query) + filterQuery : "/home";
        return loadCatalog(path).slice(offset, offset + limit);
    },

    latest: function (limit) {
        var safeLimit = Math.min(Math.max(limit || 20, 1), MAX_RESULTS);
        return loadCatalog("/home").slice(0, safeLimit);
    },

    getById: function (id) {
        var slug = S(id).trim();
        return parseDetails(slug, request("/watch/" + slug));
    },

    getSettings: function () {
        var filters = siteFilters();
        return { sortOptions: cachedSorts || [{ id: "default", title: "Default" }], filters: filters };
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
