// Alloha still owns the short-lived Borth signature, so let its browser context create one.
// Unlike the legacy extractor, this reads the HLS URLs directly from the API response already
// held in the player config. It does not toggle quality, play video, or wait for segment requests.
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
    "    var selected = null;",
    "    for (var i = 0; i < sources.length; i++) { if (sources[i] && sources[i].default === true) { selected = sources[i]; break; } }",
    "    if (!selected) selected = sources[0];",
    "    var qualities = selected && selected.quality;",
    "    if (!qualities || typeof qualities !== 'object') return 'no-player';",
    "    var emitted = 0;",
    "    Object.keys(qualities).sort(function (a, b) { return Number(b) - Number(a); }).forEach(function (quality) {",
    "        var url = String(qualities[quality] || '').trim();",
    "        if (!/^https?:\\/\\//i.test(url) || !/\\.m3u8(?:[?#]|$)/i.test(url)) return;",
    "        HibikiResolver.quality(String(quality) + 'p');",
    "        HibikiResolver.master(url);",
    "        emitted++;",
    "    });",
    "    if (!emitted) return 'no-player';",
    "    HibikiResolver.done();",
    "    return 'captured';",
    "})();",
].join("\n");

var Provider = {
    browserScript: function () { return ALLOHA_DIRECT_SCRIPT; }
};
