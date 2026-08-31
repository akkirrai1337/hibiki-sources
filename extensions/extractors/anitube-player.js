// AniTube uses ASHDI and MOON as iframe players. Both create their actual media request after
// the user presses play, so this portable browser resolver starts the player and reports its HLS
// request to the host. The host owns WebView lifecycle, cookies, request headers, and playback.
var Provider = {
    browserScript: function (linkJson) {
        return "" +
            "(function(){" +
            "try {" +
            "if(window.__hibikiAniTubeResolver)return 'waiting';window.__hibikiAniTubeResolver=true;" +
            "var sent={};" +
            "var report=function(url){if(!url||sent[url])return;sent[url]=true;HibikiResolver.video(url);};" +
            "var start=function(){" +
              "var video=document.querySelector('video');" +
              "if(video){video.muted=true;video.play().catch(function(){});if(video.currentSrc&&/^https?:/i.test(video.currentSrc))report(video.currentSrc);}" +
              "var button=document.querySelector('.vjs-big-play-button, .plyr__control--overlaid, button[aria-label*=Play], [class*=play-button], [class*=playButton], [class*=play]');" +
              "if(button)button.click();" +
            "};" +
            "var scan=function(){" +
              "start();" +
              "var resources=performance.getEntriesByType('resource');" +
              "for(var i=0;i<resources.length;i++){var url=resources[i].name;if(/\\.m3u8(?:[?#]|$)/i.test(url))report(url);}" +
            "};" +
            "scan();setInterval(scan,250);return 'starting';" +
            "} catch(error) { return 'no-player'; }" +
            "})();";
    }
};
