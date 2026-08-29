# hibiki-sources

Extension repository for [Hibiki](https://github.com/akkirrai1337/hibiki)'s anime sources.

Extensions are **scripted**, not compiled: each one is a manifest (id, name, version,
capabilities, ...) plus a JavaScript payload implementing a `Provider` object. Hibiki runs that JS
in a sandboxed embedded interpreter (Rhino) at runtime — there is no APK to build, sign, or install
for a source extension anymore.

## Layout

- `extensions/<id>.manifest.json` + `extensions/<id>.js` — one extension is **two files**, not one.
  The manifest carries metadata only; the payload is plain, readable, indented JavaScript. They're
  kept apart deliberately — embedding the JS as an inline JSON string means either escaping every
  newline (unreadable, undiffable) or physically flattening the whole file onto one line. Hibiki
  fetches both when installing and merges them into a single manifest+payload file on-device; that
  merge point is the only place a "full" single-file manifest exists.
- `repository/index.json` — the marketplace catalog Hibiki fetches to list what's installable.
  **Generated file — do not hand-edit.** CI regenerates it from `extensions/*.manifest.json` on
  every push that touches that directory (see [.github/workflows/update-index.yml](.github/workflows/update-index.yml)).
- `scripts/build_index.py` — the generator; also runnable locally (`python scripts/build_index.py`)
  to preview the index before pushing. `--check` validates every manifest+payload pair without
  writing the index (used by CI on pull requests).

## Extension manifest format

`extensions/example-source.manifest.json`:

```json
{
  "id": "example-source",
  "name": "Example Source",
  "version": "1.0.0",
  "author": "Your name",
  "website": "https://example.com",
  "iconUrl": null,
  "lang": "en",
  "capabilities": ["LATEST_RELEASES", "PLAYBACK"],
  "cleartextPlaybackHosts": []
}
```

`extensions/example-source.js` (sibling file, same id, `.js` instead of `.manifest.json`):

```js
var Provider = {
    search: function (requestJson) { /* ... */ },
    latest: function (limit) { /* ... */ },
    getById: function (id) { /* ... */ },
    getSettings: function () { /* ... */ },
    getPlaybackGroups: function (titleId) { /* ... */ },
    getPlayerLinks: function (titleId, groupId, episodeId) { /* ... */ },
};
```

Field notes:
- `id` — lowercase slug, must be unique, doubles as the filename stem for both files
  (`extensions/<id>.manifest.json` and `extensions/<id>.js`).
- `version` — basic semver (`x.y.z`).
- `lang` — ISO 639-1 tag (`en`, `ru`, ...).
- `capabilities` — today the host requires **both** `LATEST_RELEASES` and `PLAYBACK` on every
  scripted extension (see `ScriptedAnimeSource` in the `hibiki` repo); this is a current
  limitation of the runtime, not a per-extension choice.
- `cleartextPlaybackHosts` — hostnames this extension is explicitly allowed to return plain
  `http://` playback URLs for (some source sites still serve direct video over HTTP).
- The `.js` payload is plain JavaScript (no TypeScript/bundler support yet). The `Provider`
  object's methods are called synchronously from Kotlin; `search(requestJson)` receives one
  JSON-encoded `AnimeSearchRequest` string (`JSON.parse` it first). A `fetch(url, options)`
  global, a curated `Jsoup.parse(html[, baseUrl])`/`Jsoup.parseBodyFragment(html)` global, a
  `challenge(url, cookieNames, forceRefresh)` global (Cloudflare-style browser sessions, see
  `animepahe.js`), `console`, and `preferredLanguage` are the only ways to reach the
  network/parse HTML/read host state. See `extensions/animevost.js` for a complete, real example,
  and the `hibiki` repo's `RhinoExtensionRuntime`/`ScriptedAnimeSource` for exactly how each
  method is invoked.

**Gotcha when writing a payload:** any string returned from a `Jsoup`/Java call (`.text()`,
`.attr()`, `.absUrl()`) comes back as a boxed Java object inside Rhino, not a JS string primitive —
`===`, `.charAt()`, and regex behave wrong on it until you wrap it with `String(x)`. Every `.js`
payload here goes through a small `S(x)` helper for exactly this reason.

## Publishing a new or updated extension

1. Add or edit the `extensions/<id>.manifest.json` + `extensions/<id>.js` pair and push to `main`.
   The manifest must **not** carry a `payload` field — that's what the `.js` file is for; CI
   rejects a manifest that inlines one.
2. CI validates every manifest+payload pair and regenerates `repository/index.json`
   automatically — nothing else to do. There is no manual seed step: every index entry is derived
   entirely from its manifest file, so a brand-new extension needs no special first-time handling.

## What used to be here

This repo previously hosted Mihon-style per-source Android application modules (built, signed,
and distributed as APKs via `PackageManager`). That entire pipeline — Gradle modules, keystore
signing, `artifacts/*.apk`, the old APK-centric `repository/index.json` schema — was deleted
wholesale when Hibiki moved to scripted (Rhino/JS) extensions; see git history before this point
if that old approach is ever needed for reference. The very first scripted-extension format also
briefly inlined the JS payload as one escaped JSON string per extension before switching to the
current two-file split.
