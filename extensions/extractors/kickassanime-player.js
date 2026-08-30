// Portable browser-side start action for KickAssAnime's krussdomi.com player. The host wraps the
// embed page in its own iframe and runs this inside a real WebView (same Chromium engine a browser
// uses, unlike the app's own plain HTTP client) - the host itself captures the resulting .m3u8
// request and supplies playback headers, so this payload only needs to get the page's own player
// to actually start.
var Provider = {
    browserScript: function (linkJson) {
        return "" +
            "(function(){" +
            "try {" +
            "var frame=document.querySelector('iframe');" +
            "var doc=(frame&&frame.contentWindow)?frame.contentWindow.document:document;" +
            "var video=doc.querySelector('video');" +
            "if(!video){return 'no-player';}" +
            "video.muted=true;video.play().catch(function(){});" +
            "var button=doc.querySelector('.vjs-big-play-button, .plyr__control--overlaid, button[aria-label*=Play], [class*=play-button], [class*=playButton]');" +
            "if(button){button.click();}" +
            "HibikiResolver.done();return 'ready';" +
            "}catch(e){return 'no-player';}" +
            "})();";
    }
};
