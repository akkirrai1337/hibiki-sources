// Portable browser-side start action. This resolver reports the HLS request selected by the
// page; the host supplies browser-session headers to ExoPlayer. MegaPlay can insert WebVTT
// tracks after playback starts, so keep observing the player until the host's settle window
// closes instead of completing immediately after the HLS manifest is discovered.
var Provider = {
    browserScript: function (linkJson) {
        return "" +
            "(function(){" +
            "try {" +
            "if(window.__hibikiMegaPlayResolverStarted)return 'waiting';window.__hibikiMegaPlayResolverStarted=true;" +
            "var frame=document.querySelector('iframe');" +
            "var doc=(frame&&frame.contentWindow)?frame.contentWindow.document:document;" +
            "var video=doc.querySelector('video');" +
            "if(video){video.muted=true;video.play().catch(function(){});}" +
            "var button=doc.querySelector('.vjs-big-play-button, .plyr__control--overlaid, button[aria-label*=Play]');" +
            "if(button){button.click();}" +
            "var sent={};var subtitleSent={};" +
            "var reportSubtitle=function(uri,label,language){if(!uri||subtitleSent[uri])return;subtitleSent[uri]=1;HibikiResolver.subtitle(uri,label||null,language||null);};" +
            "var reportSubtitles=function(){var tracks=doc.querySelectorAll('track[kind=subtitles],track[kind=captions]');for(var t=0;t<tracks.length;t++){var track=tracks[t];reportSubtitle(track.src||track.getAttribute('src'),track.label||track.getAttribute('label'),track.srclang||track.getAttribute('srclang'));}};" +
            "var emit=function(){reportSubtitles();var r=performance.getEntriesByType('resource');for(var i=0;i<r.length;i++){var u=r[i].name;if(/\\.(?:vtt)(?:[?#]|$)/i.test(u)){reportSubtitle(u,null,null);}else if(/\\.m3u8(?:[?#]|$)/i.test(u)&&!sent[u]){HibikiResolver.video(u);sent[u]=1;}}};emit();setInterval(emit,250);" +
            "return video?'starting':'no-player';" +
            "}catch(e){return 'no-player';}" +
            "})();";
    }
};
