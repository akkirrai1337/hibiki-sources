// Moon puts a short-lived HLS URL in its iframe HTML. The value is obfuscated, rather than
// protected by a browser-only session, so decode it in the resolver WebView and hand the HLS
// URL to ExoPlayer. This keeps the iframe invisible and avoids waiting for Moon's hls.js player
// to begin a network request.
var Provider = {
    browserScript: function (linkJson) {
        return "" +
            "(function(){" +
            "try{" +
            "if(window.__hibikiMoonUrl)return 'captured';" +
            "var scripts=document.scripts,xorKey='j9AXLAnTDkiJ',video='',i;" +
            "for(i=0;i<scripts.length&&!video;i++){var text=scripts[i].text||scripts[i].textContent||'',encoded=/atob\\s*\\(\\s*[\\\"']([^\\\"']+)[\\\"']\\s*\\)/.exec(text);if(!encoded||text.indexOf('Uint8Array')<0)continue;try{" +
            "var bytes=Uint8Array.from(atob(encoded[1]),function(c){return c.charCodeAt(0);}),key=bytes.slice(1,33),out=new Uint8Array(bytes.length-33),previous=bytes[0],j;" +
            "for(j=0;j<out.length;j++){var k=key[j%32];out[j]=bytes[j+33]^k^previous;previous=(bytes[j+33]+k)&255;}" +
            "var decoded=new TextDecoder().decode(out),payloads=/[_$a-zA-Z][_$\\w]*\\(\\s*[\\\"']([A-Za-z0-9+\\/=]{32,})[\\\"']\\s*\\)/g,payload;" +
            "while((payload=payloads.exec(decoded))!==null){var value=atob(payload[1]),candidate='';for(j=0;j<value.length;j++)candidate+=String.fromCharCode(value.charCodeAt(j)^xorKey.charCodeAt(j%xorKey.length));if(/\\.m3u8(?:[?#]|$)/i.test(candidate)){video=candidate;break;}}" +
            "}catch(ignore){}}" +
            "if(!video)return 'moon-no-video-payload';" +
            "var found=/\\[[^\\]]+\\](https?:\\/\\/[^,\\[\\s]+)/g,match,best='';" +
            "while((match=found.exec(video))!==null){if(/\\.m3u8(?:[?#]|$)/i.test(match[1]))best=match[1];}" +
            "if(!best){var direct=/(https?:\\/\\/[^\\\"'\\s,]+\\.m3u8[^\\\"'\\s,]*)/i.exec(video);best=direct&&direct[1]||'';}" +
            "if(!best)return 'moon-no-hls';window.__hibikiMoonUrl=best;HibikiResolver.master(best);return 'captured';" +
            "}catch(error){return 'moon-decode-error';}" +
            "})();";
    }
};
