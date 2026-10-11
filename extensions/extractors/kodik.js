// Kodik player resolver for Hibiki. Ported from the compiled-in KodikExtractor (HTTP runtime -
// Kodik's embed page and /ftor endpoint are plain HTTP, no browser needed). Shipped as an external
// resolver, installed alongside any source that declares "kodik" in resolverDependencies, so a
// protocol change (Kodik rotates its urlParams/endpoint scheme periodically) can ship without an
// APK release.

function S(value) { return value === null || value === undefined ? null : String(value); }

var REQUIRED_URL_PARAM_KEYS = ["d", "d_sign", "pd", "pd_sign", "ref", "ref_sign"];

function decodeUrlParamIfNeeded(value) {
    if (value.indexOf("%") < 0 && value.indexOf("+") < 0) return value;
    try { return decodeURIComponent(value.replace(/\+/g, " ")); } catch (e) { return value; }
}

function mergeHeaders(base, extra) {
    var result = {};
    for (var key in base) result[key] = base[key];
    for (var key2 in extra) result[key2] = extra[key2];
    return result;
}

function parsePageInfo(html) {
    var urlParamsMatch = /\burlParams\s*=\s*'([^']+)'/.exec(html);
    var videoIdMatch = /\b(?:var\s+videoId|(?:videoInfo|vInfo)\.id)\s*=\s*["']([^"']+)["']/.exec(html);
    var typeMatch = /\b(?:var\s+type|(?:videoInfo|vInfo)\.type)\s*=\s*["']([^"']+)["']/.exec(html);
    var hashMatch = /\b(?:vInfo|videoInfo)\.hash\s*=\s*["']([^"']+)["']/.exec(html);
    if (urlParamsMatch === null) throw new Error("Kodik could not read urlParams from the embed page");
    if (videoIdMatch === null) throw new Error("Kodik could not read videoId from the embed page");
    if (typeMatch === null) throw new Error("Kodik could not read type from the embed page");
    if (hashMatch === null) throw new Error("Kodik could not read hash from the embed page");

    var rawParams = JSON.parse(urlParamsMatch[1]);
    var urlParams = {};
    for (var key in rawParams) {
        var value = S(rawParams[key]);
        urlParams[key] = key === "ref" ? decodeUrlParamIfNeeded(value) : value;
    }

    return { videoId: videoIdMatch[1], type: typeMatch[1], hash: hashMatch[1], urlParams: urlParams };
}

function normalizeScriptUrl(scriptUrl, pageOrigin) {
    if (scriptUrl.indexOf("//") === 0) return "https:" + scriptUrl;
    if (scriptUrl.charAt(0) === "/") return pageOrigin + scriptUrl;
    if (/^https?:/i.test(scriptUrl)) return scriptUrl;
    return pageOrigin + "/" + scriptUrl;
}

// Kodik moves its /ftor endpoint behind an obfuscated alias every so often; the alias is inlined
// as an atob(...) call inside the page's player script when present.
//
// Called only after a POST to /ftor has already failed, never up front. The player script is 144KB
// and is currently downloaded on every single resolve just to decode one atob() literal - which, as
// of this writing, spells "/ftor": the exact value already used as the fallback. Paying ~110ms and
// 144KB per episode to confirm a constant is a bad trade when finding out the other way round costs
// one cheap failed POST on the rare day Kodik actually rotates the endpoint.
function resolveEndpointUrl(html, pageUrl, pageOrigin, headers) {
    var scriptMatch = /src=["']((?:\/\/[^"']+)?\/assets\/js\/app\.player_single[^"']+)["']/i.exec(html);
    if (scriptMatch === null) return pageOrigin + "/ftor";

    var scriptUrl = normalizeScriptUrl(scriptMatch[1], pageOrigin);
    var scriptResponse;
    try {
        scriptResponse = fetch(scriptUrl, { headers: mergeHeaders(headers, { "Referer": pageUrl, "Accept": "*/*" }) });
    } catch (e) {
        return pageOrigin + "/ftor";
    }
    if (!scriptResponse.ok) return pageOrigin + "/ftor";

    var script = S(scriptResponse.body);
    var atobRegex = /atob\("([A-Za-z0-9+/=]+)"\)/g;
    var match;
    while ((match = atobRegex.exec(script)) !== null) {
        var decoded;
        try { decoded = Base64.decode(match[1]); } catch (e2) { continue; }
        if (decoded.charAt(0) === "/" && decoded.charAt(1) !== "/" && decoded.length <= 12) {
            return pageOrigin + decoded;
        }
    }
    return pageOrigin + "/ftor";
}

function parseTimecodeMs(text) {
    var parts = text.trim().split(":");
    if (parts.length === 0 || parts.length > 3) return null;
    var multiplier = 1000, totalMs = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
        var value = parseInt(parts[i], 10);
        if (isNaN(value)) return null;
        totalMs += value * multiplier;
        multiplier *= 60;
    }
    return totalMs;
}

function toVideoSegmentType(kind) {
    switch (String(kind || "").trim().toLowerCase()) {
        case "opening": case "op": case "intro": case "anime": return "OPENING";
        case "ending": case "ed": case "outro": return "ENDING";
        default: return "UNKNOWN";
    }
}

function parseSkipSegments(html) {
    var regex = /parseSkipButton\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*\)/g;
    var segments = [];
    var seen = {};
    var match;
    while ((match = regex.exec(html)) !== null) {
        var parts = match[1].split("-");
        if (parts.length !== 2) continue;
        var startMs = parseTimecodeMs(parts[0]);
        var endMs = parseTimecodeMs(parts[1]);
        if (startMs === null || endMs === null || endMs <= startMs) continue;
        var type = toVideoSegmentType(match[2]);
        var key = type + ":" + startMs + ":" + endMs;
        if (seen[key]) continue;
        seen[key] = true;
        segments.push({ type: type, startMs: startMs, endMs: endMs });
    }
    return segments;
}

function qualityValue(quality) {
    var digits = String(quality).replace(/[^0-9]/g, "");
    return digits.length > 0 ? parseInt(digits, 10) : null;
}

// Kodik's /ftor response is a map of quality -> sources, and the two do not always agree: a title
// with no real 720p rendition is still listed under "720", pointing at the same /480.mp4 manifest
// its 480 entry points at. This used to rewrite that path to match the key it arrived under, which
// invents a URL for a file the CDN does not have - Kodik's edge answers it with a 500, the player
// spends its whole retry budget on it, and only then falls back. The URL is the fact here and the
// key is the claim, so the rendition is labelled by what it actually points at; the duplicate then
// collapses into the real 480p entry through the dedup below.
function manifestQuality(url) {
    var match = /\/(\d+)\.mp4:hls:manifest\.m3u8(?=$|[?#])/.exec(url);
    if (match === null) return null;
    var quality = parseInt(match[1], 10);
    return isNaN(quality) ? null : quality;
}

function streamTypeFor(itemType, url) {
    var lowerType = String(itemType || "").toLowerCase();
    var cleanUrl = url.split("?")[0].split("#")[0].toLowerCase();
    if (lowerType.indexOf("mpegurl") >= 0 || lowerType.indexOf("m3u8") >= 0 || cleanUrl.lastIndexOf(".m3u8") === cleanUrl.length - 5) return "HLS";
    if (lowerType.indexOf("mpd") >= 0 || cleanUrl.lastIndexOf(".mpd") === cleanUrl.length - 4) return "DASH";
    return "MP4";
}

function buildPlaybackHeaders(inputHeaders, pageUrl) {
    var headers = {};
    for (var key in inputHeaders) {
        if (key && inputHeaders[key]) headers[key] = inputHeaders[key];
    }
    delete headers["Referer"];
    delete headers["Referrer"];
    headers["Referer"] = pageUrl;
    return headers;
}

function formEncode(params) {
    var parts = [];
    for (var key in params) {
        parts.push(
            encodeURIComponent(key).replace(/%20/g, "+") + "=" +
            encodeURIComponent(String(params[key])).replace(/%20/g, "+"),
        );
    }
    return parts.join("&");
}

// POSTs one episode's form to /ftor and turns the answer into streams. `html` is the player page
// the form came from, for finding a moved /ftor alias; null when there was none (data saver).
function requestStreams(pageOrigin, pageUrl, pageHeaders, formParams, cookieHeader, html, segments) {
    var postHeaders = mergeHeaders(pageHeaders, {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Origin": pageOrigin,
        "Referer": pageUrl,
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded",
    });
    if (cookieHeader) postHeaders.Cookie = cookieHeader;

    var requestBody = formEncode(formParams);
    function postTo(endpointUrl) {
        var response = fetch(endpointUrl, { method: "POST", headers: postHeaders, body: requestBody });
        if (!response.ok) return null;
        // A 200 that isn't the payload counts as a miss too, not as success: if Kodik ever
        // leaves /ftor answering with something else after moving the real endpoint, that has
        // to send us looking for the alias rather than throwing out of the whole resolve.
        var parsed;
        try { parsed = JSON.parse(S(response.body)); } catch (e) { return null; }
        return parsed && parsed.links ? parsed : null;
    }

    var defaultEndpoint = pageOrigin + "/ftor";
    var ftor = postTo(defaultEndpoint);
    if (ftor === null) {
        // Only now is the player script worth its download - see resolveEndpointUrl above. With no
        // player page at hand (the data-saver path) there is nothing to find it in: the caller
        // falls back to the full resolve, which has one.
        if (html === null) throw new Error("Kodik rejected " + defaultEndpoint);
        var aliasEndpoint = resolveEndpointUrl(html, pageUrl, pageOrigin, pageHeaders);
        if (aliasEndpoint === defaultEndpoint) throw new Error("Kodik rejected " + defaultEndpoint);
        ftor = postTo(aliasEndpoint);
        if (ftor === null) throw new Error("Kodik rejected both " + defaultEndpoint + " and " + aliasEndpoint);
    }
    var links = ftor.links || {};
    var candidates = [];
    var seen = {};
    for (var quality in links) {
        var numericQuality = qualityValue(quality);
        if (numericQuality === null) continue;
        var items = links[quality] || [];
        for (var idx = 0; idx < items.length; idx++) {
            var item = items[idx];
            if (!item.src) continue;
            var url = Url.decodeShifted(item.src);
            var actualQuality = manifestQuality(url);
            var qualityLabel = (actualQuality === null ? numericQuality : actualQuality) + "p";
            var key = qualityLabel + "|" + url;
            if (seen[key]) continue;
            seen[key] = true;
            candidates.push({
                url: url, type: streamTypeFor(item.type, url), quality: qualityLabel,
                headers: buildPlaybackHeaders(pageHeaders, pageUrl), segments: segments,
            });
        }
    }
    candidates.sort(function (a, b) { return (qualityValue(b.quality) || 0) - (qualityValue(a.quality) || 0); });
    if (candidates.length === 0) throw new Error("Kodik returned no playable qualities");
    return candidates;
}

// Data saver: Kodik without its per-episode player page.
//
// /ftor only needs two things the page holds: the referrer's signed urlParams (d_sign and the rest,
// valid for about two days - the ":YYMMDDhhmm" at their end) and the episode's own id/hash. The
// season page (the same URL without only_episode/episode) lists the id/hash of every episode at
// once, so it is read once per season and kept; every episode after that costs one POST (~7KB)
// instead of a page (~18KB) and a POST. What is lost is the skip-opening timecodes, which only the
// per-episode page carries - a source's own (YummyAnime's) still come through on the link.
var SEASON_CACHE_PREFIX = "season:";
var SEASON_CACHE_MAX_MS = 24 * 60 * 60 * 1000;
// The signatures' expiry is read without knowing Kodik's time zone; stop trusting them well before.
var SIGN_EXPIRY_MARGIN_MS = 4 * 60 * 60 * 1000;

function hasStorage() {
    return typeof storage === "object" && storage !== null && typeof storage.get === "function";
}

function signExpiry(sign) {
    var match = /:(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(sign || ""));
    if (match === null) return null;
    return Date.UTC(2000 + Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

function parseSeasonEpisodes(html) {
    var episodes = {};
    var pattern = /<option[^>]*?value="([^"]+)"[^>]*?data-id="(\d+)"[^>]*?data-hash="([0-9a-f]+)"/g;
    var match;
    while ((match = pattern.exec(html)) !== null) episodes[match[1]] = { id: match[2], hash: match[3] };
    return episodes;
}

function readSeason(key) {
    if (!hasStorage()) return null;
    var raw = storage.get(key);
    if (!raw) return null;
    var entry;
    try { entry = JSON.parse(raw); } catch (e) { return null; }
    return entry && entry.expiresAt > Date.now() ? entry : null;
}

function loadSeason(seasonUrl, pageHeaders, key) {
    var response = fetch(seasonUrl, {
        headers: mergeHeaders(pageHeaders, { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }),
    });
    if (!response.ok) return null;
    var html = S(response.body);
    var paramsMatch = /\burlParams\s*=\s*'([^']+)'/.exec(html);
    if (paramsMatch === null) return null;
    var rawParams = JSON.parse(paramsMatch[1]);
    var urlParams = {};
    for (var i = 0; i < REQUIRED_URL_PARAM_KEYS.length; i++) {
        var name = REQUIRED_URL_PARAM_KEYS[i];
        if (!(name in rawParams)) return null;
        var value = S(rawParams[name]);
        urlParams[name] = name === "ref" ? decodeUrlParamIfNeeded(value) : value;
    }
    var expiry = signExpiry(urlParams.d_sign);
    var expiresAt = Math.min(
        Date.now() + SEASON_CACHE_MAX_MS,
        expiry === null ? Date.now() + 60 * 60 * 1000 : expiry - SIGN_EXPIRY_MARGIN_MS
    );
    var entry = { urlParams: urlParams, episodes: parseSeasonEpisodes(html), expiresAt: expiresAt };
    if (hasStorage() && expiresAt > Date.now()) storage.set(key, JSON.stringify(entry));
    return entry;
}

// Streams for a /season/... link, or null when this link can't take the light path (the caller
// then resolves it the full way).
function resolveLite(pageUrl, pageOrigin, pageHeaders) {
    var match = /\/season\/(\d+)\/([0-9a-f]+)(\/[^?#]*)?(?:\?([^#]*))?/.exec(pageUrl);
    if (match === null) return null;
    var query = match[4] || "";
    var episodeMatch = /(?:^|&)episode=([^&]+)/.exec(query);
    if (episodeMatch === null) return null;
    var episode = decodeURIComponent(episodeMatch[1]);
    var seasonQuery = query.split("&").filter(function (part) {
        return part.length > 0 && !/^(episode|only_episode)=/.test(part);
    }).join("&");
    var seasonUrl = pageOrigin + "/season/" + match[1] + "/" + match[2] + (match[3] || "") + (seasonQuery ? "?" + seasonQuery : "");
    // The signatures belong to the site embedding the player, so one season is kept per referrer.
    var key = SEASON_CACHE_PREFIX + match[1] + ":" + match[2] + ":" + (pageHeaders["Referer"] || "");

    var season = readSeason(key);
    // Not cached yet, or cached before this episode came out.
    if (season === null || !season.episodes[episode]) season = loadSeason(seasonUrl, pageHeaders, key);
    if (season === null || !season.episodes[episode]) return null;

    var target = season.episodes[episode];
    var formParams = {};
    for (var i = 0; i < REQUIRED_URL_PARAM_KEYS.length; i++) {
        formParams[REQUIRED_URL_PARAM_KEYS[i]] = season.urlParams[REQUIRED_URL_PARAM_KEYS[i]];
    }
    formParams.bad_user = "false";
    formParams.cdn_is_working = "false";
    formParams.type = "seria";
    formParams.hash = target.hash;
    formParams.id = target.id;
    formParams.info = "{}";
    try {
        return requestStreams(pageOrigin, pageUrl, pageHeaders, formParams, null, null, []);
    } catch (error) {
        // Signatures Kodik no longer takes: forget them, so the next episode reads them anew.
        if (hasStorage()) storage.remove(key);
        throw error;
    }
}

var Provider = {
    resolve: function (linkJson) {
        var link = JSON.parse(linkJson);
        var pageUrl = Url.normalize(link.url);
        var pageOrigin = Url.origin(pageUrl);
        var pageHeaders = link.headers || {};

        if (link.dataSaver) {
            try {
                var lite = resolveLite(pageUrl, pageOrigin, pageHeaders);
                if (lite !== null) return lite;
            } catch (ignored) {
                // The full resolve below still works whenever the light one doesn't.
            }
        }

        var pageResponse = fetch(pageUrl, {
            headers: mergeHeaders(pageHeaders, { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }),
        });
        if (!pageResponse.ok) throw new Error("Kodik returned HTTP " + pageResponse.status);
        var html = S(pageResponse.body);
        var setCookie = pageResponse.headers ? pageResponse.headers["set-cookie"] : null;
        var cookieHeader = setCookie ? S(setCookie).split(";")[0] : null;

        var pageInfo = parsePageInfo(html);
        var segments = parseSkipSegments(html);

        var missing = [];
        for (var i = 0; i < REQUIRED_URL_PARAM_KEYS.length; i++) {
            if (!(REQUIRED_URL_PARAM_KEYS[i] in pageInfo.urlParams)) missing.push(REQUIRED_URL_PARAM_KEYS[i]);
        }
        if (missing.length > 0) {
            throw new Error("Kodik did not expose required urlParams: " + missing.join(", "));
        }

        var formParams = {};
        for (var j = 0; j < REQUIRED_URL_PARAM_KEYS.length; j++) {
            formParams[REQUIRED_URL_PARAM_KEYS[j]] = pageInfo.urlParams[REQUIRED_URL_PARAM_KEYS[j]];
        }
        formParams.bad_user = "false";
        formParams.cdn_is_working = "false";
        formParams.type = pageInfo.type;
        formParams.hash = pageInfo.hash;
        formParams.id = pageInfo.videoId;
        formParams.info = "{}";

        return requestStreams(pageOrigin, pageUrl, pageHeaders, formParams, cookieHeader, html, segments);
    },
};
