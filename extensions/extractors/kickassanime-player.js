// Portable browser-side start action for KickAssAnime's krussdomi.com player. It reports video
// and audio HLS requests separately so the host can merge them in ExoPlayer. The host wraps the
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
            "if(video){video.muted=true;video.play().catch(function(){});}" +
            "var button=doc.querySelector('.vjs-big-play-button, .plyr__control--overlaid, button[aria-label*=Play], [class*=play-button], [class*=playButton]');" +
            "if(button){button.click();}" +
            "var sent={};var emit=function(){var r=performance.getEntriesByType('resource');var h=[];for(var i=0;i<r.length;i++){var u=r[i].name;if(/\\.m3u8(?:[?#]|$)/i.test(u)&&!sent[u])h.push(u);}var a=null,v=null;for(var j=0;j<h.length;j++){if(/(?:audio|aac|opus)/i.test(h[j]))a=h[j];else v=h[j];}if(v){HibikiResolver.video(v);sent[v]=1;}if(a){HibikiResolver.audio(a);sent[a]=1;}};emit();setInterval(emit,250);" +
            "return video?'starting':'no-player';" +
            "}catch(e){return 'no-player';}" +
            "})();";
    }
};
