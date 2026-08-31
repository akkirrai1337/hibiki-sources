// ASHDI exposes the HLS master directly in its Playerjs configuration. Resolving it through HTTP
// avoids waiting for the ad-enabled iframe to start and gives AniTube a deterministic fast path.
var Provider = {
    resolve: function (linkJson) {
        var link = JSON.parse(String(linkJson));
        var url = String(link.url);
        var headers = {};
        var key;
        for (key in (link.headers || {})) headers[key] = link.headers[key];
        headers["Referer"] = url;
        headers["User-Agent"] = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/137.0.0.0 Mobile Safari/537.36";
        var response = fetch(url, { headers: headers });
        if (!response.ok) throw new Error("ASHDI returned HTTP " + response.status);
        var page = String(response.body);
        var match = /\bfile\s*:\s*['\"]([^'\"]+\.m3u8[^'\"]*)/i.exec(page);
        if (!match) throw new Error("ASHDI did not expose an HLS stream");
        var streamUrl = match[1].replace(/\\\//g, "/");
        return [{ url: streamUrl, type: "HLS", quality: null, headers: headers, segments: [] }];
    }
};
