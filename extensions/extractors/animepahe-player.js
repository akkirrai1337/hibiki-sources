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
            "if(video){video.muted=true;video.play().catch(function(){});}" +
            "var button=doc.querySelector('.vjs-big-play-button, .plyr__control--overlaid, button[aria-label*=Play]');" +
            "if(button){button.click();}" +
            "var sent={};var emit=function(){var r=performance.getEntriesByType('resource');for(var i=0;i<r.length;i++){var u=r[i].name;if(/\\.m3u8(?:[?#]|$)/i.test(u)&&!sent[u]){HibikiResolver.video(u);sent[u]=1;}}};emit();setInterval(emit,250);" +
            "return video?'starting':'no-player';" +
            "}catch(e){return 'no-player';}" +
            "})();";
    }
};
