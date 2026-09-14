// Portable AniBoom resolver. It has no Android APIs and can run in every Hibiki host.

// AniBoom's data-config attribute carries its JSON HTML-entity-escaped (quotes become &quot; so
// the JSON string can sit inside a double-quoted HTML attribute) - a real browser's attribute
// getter unescapes this for free, but fetching raw HTML text does not, so the regexes below would
// silently miss "qualityVideo" (and any URL that itself contains an escaped quote) without this.
function unescapeHtmlEntities(text) {
    return text
        .replace(/&quot;/g, "\"")
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

var Provider = {
    resolve: function (linkJson) {
        var link = JSON.parse(String(linkJson));
        var response = fetch(link.url, { headers: link.headers || {} });
        if (!response.ok) throw new Error("AniBoom returned HTTP " + response.status);

        var html = unescapeHtmlEntities(String(response.body));
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
