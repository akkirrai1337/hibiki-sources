// CVH (CDN Video Hub) player resolver.
//
// YummyAnime embeds this player as `//ru.yummyani.me/iframeCVH.html?anime_id=..&episode=..
// &dubbing_code=..&dubbing=..`. That page only mounts a <video-player> web component with
// `data-publisher-id: 745` and `data-aggregator: mali`, which is where the two constants below
// come from; the playlist call reproduces what the component does.
//
// Matching a track is a two-part problem: pick the requested episode, then the requested dubbing.
// `dubbing_code` is the studio's own code ("Jam Club") and `dubbing` is YummyAnime's display label,
// which always carries an "Озвучка " prefix ("Озвучка JAM") - the prefix has to come off before it
// can be compared to the playlist's bare `voiceStudio`/`voiceType` names.

var PLAYLIST_URL = "https://plapi.cdnvideohub.com/api/v1/player/sv/playlist";
var VIDEO_URL = "https://plapi.cdnvideohub.com/api/v1/player/sv/video/";
var PUBLISHER_ID = "745";
var AGGREGATOR = "mali";
var DEFAULT_REFERER = "https://ru.yummyani.me/";

// Ordered best-first: a DASH/HLS manifest carries every quality, so it outranks the fixed-size
// progressive files that follow.
var SOURCE_FIELDS = [
    ["dashUrl", "DASH", null],
    ["hlsUrl", "HLS", null],
    ["mpegFullHdUrl", "MP4", "1080p"],
    ["mpegHighUrl", "MP4", "720p"],
    ["mpegMediumUrl", "MP4", "480p"],
    ["mpegLowUrl", "MP4", "360p"],
    ["mpegLowestUrl", "MP4", "240p"],
];

function copyHeaders(headers) {
    var result = {};
    for (var key in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, key)) result[key] = headers[key];
    }
    return result;
}

// Query values here are form-encoded, so a space arrives as "+" and decodeURIComponent leaves it
// alone - "Jam+Club" has to become "Jam Club" before any comparison.
function parseQuery(url) {
    var result = {};
    var query = String(url).split("?")[1] || "";
    var parts = query.split("&");
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].length === 0) continue;
        var pair = parts[i].split("=");
        var key = decodeURIComponent(String(pair[0]).replace(/\+/g, " "));
        result[key] = decodeURIComponent(String(pair[1] || "").replace(/\+/g, " "));
    }
    return result;
}

// YummyAnime labels a track "Озвучка <studio>" (and a player "Плеер <name>"); the playlist knows
// the studio alone, so the prefix is dropped before matching. Everything is lowercased and its
// whitespace collapsed so that "AniLibria  TV" and "anilibria tv" still meet.
function normalize(value) {
    if (value === null || value === undefined) return null;
    var text = String(value).replace(/\+/g, " ").replace(/^\s*(?:Озвучка|Плеер)\s+/i, "");
    text = text.toLowerCase().replace(/\s+/g, " ").trim();
    return text.length > 0 ? text : null;
}

// The playlist reports episode numbers as JSON numbers on some titles and as strings on others, so
// comparing a parsed int against the raw field with `!==` would reject every track of a title that
// happens to use strings, and the whole resolve would fail with "no video".
function episodeNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    var parsed = parseFloat(String(value).replace(",", "."));
    return isNaN(parsed) ? null : parsed;
}

function requestJson(url, headers) {
    var response = fetch(url, { headers: headers });
    if (!response.ok) throw new Error("CVH HTTP " + response.status);
    return JSON.parse(String(response.body));
}

// Higher is better; -1 means the track is for a different episode and must never be used.
function scoreTrack(track, wantedEpisode, wantedCode, wantedLabel) {
    var trackEpisode = episodeNumber(track.episode);
    if (wantedEpisode !== null && trackEpisode !== null && trackEpisode !== wantedEpisode) return -1;
    var studio = normalize(track.voiceStudio);
    var voiceType = normalize(track.voiceType);
    if (wantedCode !== null && studio === wantedCode) return 4;
    if (wantedCode !== null && voiceType === wantedCode) return 3;
    if (wantedLabel !== null && studio === wantedLabel) return 2;
    if (wantedLabel !== null && voiceType === wantedLabel) return 1;
    return 0;
}

// A CDN node is handed out as a bare IP that is not in the certificate; `failoverHost` is the
// hostname that serves the same file.
function applyFailoverHost(url, failoverHost) {
    var match = /^https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})/.exec(String(url));
    return match !== null && failoverHost ? String(url).replace(match[1], failoverHost) : String(url);
}

var Provider = {
    resolve: function (linkJson) {
        var link = JSON.parse(String(linkJson));
        var query = parseQuery(link.url);
        var animeId = query.anime_id;
        if (!animeId) throw new Error("CVH anime_id missing");

        var headers = copyHeaders(link.headers || {});
        if (!headers.Referer) headers.Referer = DEFAULT_REFERER;

        var playlistUrl = PLAYLIST_URL + "?pub=" + PUBLISHER_ID
            + "&id=" + encodeURIComponent(animeId) + "&aggr=" + AGGREGATOR;
        var tracks = requestJson(playlistUrl, headers).items || [];

        var wantedEpisode = episodeNumber(query.episode);
        var wantedCode = normalize(query.dubbing_code);
        var wantedLabel = normalize(query.dubbing);

        var best = null;
        var bestScore = -1;
        for (var i = 0; i < tracks.length; i++) {
            var score = scoreTrack(tracks[i], wantedEpisode, wantedCode, wantedLabel);
            if (score > bestScore) {
                bestScore = score;
                best = tracks[i];
            }
        }
        if (best === null || !best.vkId) throw new Error("CVH video missing");

        var video = requestJson(VIDEO_URL + encodeURIComponent(best.vkId), headers);
        var sources = video.sources || {};
        var links = [];
        for (var s = 0; s < SOURCE_FIELDS.length; s++) {
            var field = SOURCE_FIELDS[s];
            if (!sources[field[0]]) continue;
            links.push({
                url: applyFailoverHost(sources[field[0]], video.failoverHost),
                type: field[1],
                quality: field[2],
                headers: headers,
                segments: [],
            });
        }
        if (links.length === 0) throw new Error("CVH streams missing");
        return links;
    },
};
