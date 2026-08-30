// Portable browser-side start action for KickAssAnime's krussdomi.com player. It reports video
// and audio HLS requests separately so the host can merge them in ExoPlayer. The host wraps the
// embed page in its own iframe and runs this inside a real WebView (same Chromium engine a browser
// uses, unlike the app's own plain HTTP client) - the host itself captures the resulting .m3u8
// request and supplies playback headers, so this payload only needs to get the page's own player
// to actually start.
//
// Audio detection reads the HLS spec directly instead of guessing from URL naming: a multivariant
// (master) playlist's #EXT-X-MEDIA:TYPE=AUDIO lines name the real demuxed audio rendition URI, so
// any site serving standard HLS gets correct audio without a site-specific heuristic.
var Provider = {
    browserScript: function (linkJson) {
        return "" +
            "(function(){" +
            "try {" +
            "if(window.__hibikiKaaResolverStarted)return 'waiting';window.__hibikiKaaResolverStarted=true;" +
            "var frame=document.querySelector('iframe');" +
            "var doc=(frame&&frame.contentWindow)?frame.contentWindow.document:document;" +
            "var video=doc.querySelector('video');" +
            "if(video){video.muted=true;video.play().catch(function(){});}" +
            "var button=doc.querySelector('.vjs-big-play-button, .plyr__control--overlaid, button[aria-label*=Play], [class*=play-button], [class*=playButton]');" +
            "if(button){button.click();}" +
            "var sent={};var audioSent={};" +
            "var reportAudio=function(uri){if(audioSent[uri])return;audioSent[uri]=1;HibikiResolver.audio(uri);};" +
            "var parseAudioUris=function(playlistText,baseUrl){" +
            "var re=/#EXT-X-MEDIA:[^\\n]*TYPE=AUDIO[^\\n]*URI=\"([^\"]+)\"/gi;var m;" +
            "while((m=re.exec(playlistText))){try{reportAudio(new URL(m[1],baseUrl).href);}catch(e){}}" +
            "};" +
            "var inspect=function(u){if(sent[u])return;sent[u]=1;fetch(u,{credentials:'include'}).then(function(r){return r.text();}).then(function(m){if(/#EXT-X-(?:STREAM-INF|MEDIA:TYPE=AUDIO)/i.test(m)){parseAudioUris(m,u);HibikiResolver.master(u);return;}if(/(?:audio|aac|opus)/i.test(u)){reportAudio(u);}else{HibikiResolver.video(u);}}).catch(function(){if(/(?:audio|aac|opus)/i.test(u)){reportAudio(u);}else{HibikiResolver.video(u);}});};var emit=function(){var r=performance.getEntriesByType('resource');for(var i=0;i<r.length;i++){var u=r[i].name;if(/\\.m3u8(?:[?#]|$)/i.test(u))inspect(u);}};emit();setInterval(emit,250);" +
            "return video?'starting':'no-player';" +
            "}catch(e){return 'no-player';}" +
            "})();";
    }
};
