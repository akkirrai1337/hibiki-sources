// Portable browser-side start action. The host captures the resulting HLS request and supplies
// the playback headers; this payload only knows how to start the site's player.
var Provider = {
    browserScript: function (linkJson) {
        return "" +
            "(function(){" +
            "try {" +
            "var frame=document.querySelector('iframe');" +
            "var doc=(frame&&frame.contentWindow)?frame.contentWindow.document:document;" +
            "var video=doc.querySelector('video');" +
            "if(!video){return 'no-player';}" +
            "if(video){video.muted=true;video.play().catch(function(){});}" +
            "var button=doc.querySelector('.vjs-big-play-button, .plyr__control--overlaid, button[aria-label*=Play]');" +
            "if(button){button.click();}" +
            "HibikiResolver.done();return 'ready';" +
            "}catch(e){return 'no-player';}" +
            "})();";
    }
};
