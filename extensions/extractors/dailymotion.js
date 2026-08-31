// Dailymotion player resolver for Hibiki (HTTP runtime - Dailymotion's public player metadata
// endpoint is plain JSON over HTTP, no browser needed). Shipped as an external resolver, installed
// alongside any source that declares "dailymotion" in resolverDependencies.
//
// The metadata endpoint (used by Dailymotion's own embed player and widely relied on by other
// tools) returns a signed HLS manifest URL directly - no cookies, no Referer, no browser challenge -
// so this is a generic, source-agnostic resolver rather than something any one source needs to
// special-case.

function S(value) { return value === null || value === undefined ? null : String(value); }

var METADATA_URL = "https://www.dailymotion.com/player/metadata/video/";
// Preferred key order: an adaptive "auto" HLS manifest already carries every bitrate as internal
// variants, so it's tried first; the rest are numeric-resolution fallbacks some videos expose
// instead of (or alongside) "auto".
var QUALITY_ORDER = ["auto", "1080", "720", "480", "380", "240", "144"];

function extractVideoId(url) {
    var match = /dailymotion\.com\/(?:embed\/video|video)\/([a-zA-Z0-9]+)/.exec(url);
    if (match !== null) return match[1];
    match = /dai\.ly\/([a-zA-Z0-9]+)/.exec(url);
    return match !== null ? match[1] : null;
}

var Provider = {
    resolve: function (linkJson) {
        var link = JSON.parse(linkJson);
        var videoId = extractVideoId(S(link.url));
        if (videoId === null) throw new Error("Unsupported Dailymotion link: " + link.url);

        var response = fetch(METADATA_URL + encodeURIComponent(videoId), {
            headers: { "Accept": "application/json" },
        });
        if (!response.ok) throw new Error("Dailymotion metadata returned HTTP " + response.status);

        var data = JSON.parse(S(response.body));
        if (data.error) {
            var message = data.error.title || data.error.type || "unknown error";
            throw new Error("Dailymotion returned an error: " + S(message));
        }

        var qualities = data.qualities || {};
        var streams = [];
        var seen = {};
        for (var i = 0; i < QUALITY_ORDER.length; i++) {
            var key = QUALITY_ORDER[i];
            var entries = qualities[key];
            if (!entries) continue;
            for (var j = 0; j < entries.length; j++) {
                var url = S(entries[j].url);
                if (!url || seen[url]) continue;
                seen[url] = true;
                var mimeType = S(entries[j].type) || "";
                var type = mimeType.indexOf("mpegURL") >= 0 ? "HLS" : "MP4";
                streams.push({
                    url: url,
                    type: type,
                    quality: key === "auto" ? null : key + "p",
                    headers: {},
                    segments: [],
                });
            }
        }
        if (streams.length === 0) throw new Error("Dailymotion returned no stream links");
        return streams;
    },
};
