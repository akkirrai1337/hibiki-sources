// Portable HTTP resolver for Sibnet embeds.
var Provider = {
    resolve: function (linkJson) {
        var link = JSON.parse(String(linkJson));
        var pageUrl = Url.normalize(link.url);
        var pageOrigin = Url.origin(pageUrl);
        var requestHeaders = copy(link.headers || {});
        requestHeaders.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        var response = fetch(pageUrl, { headers: requestHeaders });
        if (!response.ok) throw new Error("Sibnet returned HTTP " + response.status);

        var html = String(response.body);
        var referer = extractReferer(html) || pageUrl;
        var source = /src:\s*"([^"]+)"\s*,\s*type:\s*"([^"]+)/g;
        var streams = [], seen = {}, match;
        while ((match = source.exec(html)) !== null) {
            var url = absoluteUrl(pageOrigin, match[1]);
            var type = streamType(match[2], url);
            var key = url + "|" + type;
            if (seen[key]) continue;
            seen[key] = true;
            streams.push({
                url: url, type: type, quality: link.quality,
                headers: playbackHeaders(link.headers || {}, referer, pageOrigin), segments: []
            });
        }
        if (!streams.length) throw new Error("Sibnet embed does not contain stream URLs");
        return streams;
    }
};

function absoluteUrl(origin, url) { return url.indexOf("//") === 0 ? "https:" + url : url.charAt(0) === "/" ? origin + url : url; }
function streamType(contentType, url) {
    var lower = String(contentType).toLowerCase(), path = String(url).split("?")[0].toLowerCase();
    if (lower.indexOf("mpegurl") >= 0 || lower.indexOf("m3u8") >= 0 || /\.m3u8$/.test(path)) return "HLS";
    if (lower.indexOf("dash") >= 0 || lower.indexOf("mpd") >= 0 || /\.mpd$/.test(path)) return "DASH";
    return "MP4";
}
function extractReferer(html) {
    var patterns = [ /<link\s+rel="canonical"\s+href="([^"]+)/i, /<meta\s+property="og:url"\s+content="([^"]+)/i, /sharesibnet\(\{\s*"url":"([^"]+)/i ];
    for (var i = 0; i < patterns.length; i++) { var match = patterns[i].exec(html); if (match) return Url.normalize(match[1]); }
    return null;
}
function copy(map) { var result = {}; for (var key in map) if (Object.prototype.hasOwnProperty.call(map, key)) result[key] = map[key]; return result; }
function remove(headers, name) { for (var key in headers) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]; }
function has(headers, name) { for (var key in headers) if (key.toLowerCase() === name.toLowerCase()) return true; return false; }
function playbackHeaders(base, referer, origin) {
    var headers = copy(base); remove(headers, "Referer"); remove(headers, "Referrer"); remove(headers, "Origin");
    headers.Referer = referer; headers.Origin = origin; if (!has(headers, "User-Agent")) headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    headers.Accept = "*/*"; return headers;
}
