// Alloha still owns the short-lived Borth signature, so let its browser context create one.
// Unlike the legacy extractor, this reads the HLS URLs directly from the API response already
// held in the player config - every audio track and mirror it lists. It does not toggle quality,
// play video, or wait for segment requests.
var ALLOHA_DIRECT_SCRIPT = [
    "(function () {",
    "    function findPlayer() {",
    "        var names = ['player', 'Player', 'playerjs', 'pl'];",
    "        for (var i = 0; i < names.length; i++) {",
    "            try { if (window[names[i]] && window[names[i]].config) return window[names[i]]; } catch (e) {}",
    "        }",
    "        for (var key in window) {",
    "            try { if (window[key] && window[key].config && window[key].config.hlsSource) return window[key]; } catch (e) {}",
    "        }",
    "        return null;",
    "    }",
    "    var player = findPlayer();",
    "    var sources = player && player.config && player.config.hlsSource;",
    "    if (!sources || !sources.length) return 'no-player';",
    // Some episodes carry several entries here: the same video with different sound (Alloha's
    // audio tracks). Each becomes its own set of streams, labelled through HibikiResolver.track;
    // an app without that call gets only the default one, as before.
    "    var canLabel = typeof HibikiResolver.track === 'function';",
    "    var ordered = [];",
    "    for (var i = 0; i < sources.length; i++) { if (sources[i] && sources[i].default === true) { ordered.push(sources[i]); break; } }",
    "    for (var j = 0; j < sources.length; j++) { if (sources[j] && ordered.indexOf(sources[j]) < 0) ordered.push(sources[j]); }",
    "    if (!canLabel) ordered = ordered.slice(0, 1);",
    "    var labelled = canLabel && ordered.length > 1;",
    "    var usedLabels = {};",
    "    var emitted = 0;",
    "    ordered.forEach(function (source, index) {",
    "        var qualities = source.quality;",
    "        if (!qualities || typeof qualities !== 'object') return;",
    "        if (labelled) {",
    "            var label = String(source.label || '').trim() || ('Audio ' + (index + 1));",
    "            if (usedLabels[label]) label = label + ' (' + (index + 1) + ')';",
    "            usedLabels[label] = true;",
    "            HibikiResolver.track(label);",
    "        }",
    "        Object.keys(qualities).sort(function (a, b) { return Number(b) - Number(a); }).forEach(function (quality) {",
    // A quality may list a mirror as "<url> or <url>": the first is the stream, the rest stand by.
    "            String(qualities[quality] || '').split(/\\s+or\\s+/).forEach(function (part) {",
    "                var url = part.trim();",
    "                if (!/^https?:\\/\\//i.test(url) || !/\\.m3u8(?:[?#]|$)/i.test(url)) return;",
    "                HibikiResolver.quality(String(quality) + 'p');",
    "                HibikiResolver.master(url);",
    "                emitted++;",
    "            });",
    "        });",
    "    });",
    "    if (!emitted) return 'no-player';",
    "    HibikiResolver.done();",
    "    return 'captured';",
    "})();",
].join("\n");

// Third-party ads and trackers the player page pulls in (Google's IMA SDK and ad servers, analytics,
// its own play logger). The links come from Alloha's own API call, which none of these take part
// in; blocked, they are neither downloaded nor run in the hidden browser. The player's own scripts
// (alloha.yani.tv) and the video CDN are not on the list.
var BLOCK_HOSTS = [
    "imasdk.googleapis.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "google-analytics.com",
    "googletagmanager.com",
    "mc.yandex.ru",
    "ipchanger.live"
];

var Provider = {
    browserScript: function (linkJson) {
        // This player needs its embed to be a real child frame of an origin-local page.
        // Supplying that context here keeps provider-specific navigation policy in the resolver,
        // while the app only implements the reusable parentUrl/browserScript contract.
        try {
            var link = JSON.parse(linkJson || "{}");
            var origin = String(link.url || "").match(/^https?:\/\/[^/]+/i);
            if (!origin) return ALLOHA_DIRECT_SCRIPT;
            return "hibiki-browser-resolver:v1:" + JSON.stringify({
                script: ALLOHA_DIRECT_SCRIPT,
                parentUrl: origin[0] + "/",
                blockHosts: BLOCK_HOSTS
            });
        } catch (e) {
            return ALLOHA_DIRECT_SCRIPT;
        }
    }
};
