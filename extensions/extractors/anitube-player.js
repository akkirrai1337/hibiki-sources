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
            "var scripts=document.scripts,encrypted='',i;" +
            "for(i=0;i<scripts.length;i++){var text=scripts[i].text||scripts[i].textContent||'';if(text.indexOf('atob(')>=0&&text.indexOf('Uint8Array')>=0){encrypted=text;break;}}" +
            "if(!encrypted)return 'moon-no-encrypted-script';" +
            "var encoded=/atob\\s*\\(\\s*[\\\"']([^\\\"']+)[\\\"']\\s*\\)/.exec(encrypted);if(!encoded)return 'moon-no-outer-payload';" +
            "var bytes=Uint8Array.from(atob(encoded[1]),function(c){return c.charCodeAt(0);}),key=bytes.slice(1,33),out=new Uint8Array(bytes.length-33),previous=bytes[0];" +
            "for(i=0;i<out.length;i++){var k=key[i%32];out[i]=bytes[i+33]^k^previous;previous=(bytes[i+33]+k)&255;}" +
            "var decoded=new TextDecoder().decode(out),payloads=/[_$a-zA-Z][_$\\w]*\\(\\s*[\\\"']([A-Za-z0-9+\\/=]{32,})[\\\"']\\s*\\)/g,payload,xorKey='j9AXLAnTDkiJ',video='';" +
            "while((payload=payloads.exec(decoded))!==null){var value=atob(payload[1]),candidate='';for(i=0;i<value.length;i++)candidate+=String.fromCharCode(value.charCodeAt(i)^xorKey.charCodeAt(i%xorKey.length));if(/\\.m3u8(?:[?#]|$)/i.test(candidate)){video=candidate;break;}}" +
            "if(!video)return 'moon-no-video-payload';" +
            "var found=/\\[[^\\]]+\\](https?:\\/\\/[^,\\[\\s]+)/g,match,best='';" +
            "while((match=found.exec(video))!==null){if(/\\.m3u8(?:[?#]|$)/i.test(match[1]))best=match[1];}" +
            "if(!best){var direct=/(https?:\\/\\/[^\\\"'\\s,]+\\.m3u8[^\\\"'\\s,]*)/i.exec(video);best=direct&&direct[1]||'';}" +
            "if(!best)return 'moon-no-hls';window.__hibikiMoonUrl=best;HibikiResolver.master(best);return 'captured';" +
            "}catch(error){return 'moon-decode-error';}" +
            "})();";
    }
};
