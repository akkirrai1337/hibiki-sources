// Portable AniBoom resolver. It has no Android APIs and can run in every Hibiki host.
var Provider = {
    resolve: function (linkJson) {
        var link = JSON.parse(String(linkJson));
        var response = fetch(link.url, { headers: link.headers || {} });
        if (!response.ok) throw new Error("AniBoom returned HTTP " + response.status);

        var html = String(response.body).replace(/&amp;/g, "&");
        var match = /https:[^"\s]+?\.m3u8(?:\?[^"\s\\]*)?/.exec(html);
        if (match === null) throw new Error("AniBoom embed does not contain an HLS URL");
        var qualityMatch = /"qualityVideo"\s*:\s*(\d+)/.exec(html);
        var headers = link.headers || {};
        headers.Referer = link.url;
        return [{
            url: match[0].replace(/\\/g, ""),
            type: "HLS",
            quality: qualityMatch === null ? link.quality : qualityMatch[1] + "p",
            headers: headers,
            segments: []
        }];
    }
};
