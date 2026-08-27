# hibiki-sources

Extension repository for [Hibiki](https://github.com/akkirrai1337/hibiki)'s anime sources.

Extensions are **scripted**, not compiled: each one is a single JSON file combining a manifest
(id, name, version, capabilities, ...) with an inline JavaScript `payload` implementing a
`Provider` object. Hibiki runs that JS in a sandboxed embedded interpreter (Rhino) at runtime —
there is no APK to build, sign, or install for a source extension anymore.

## Layout

- `extensions/<id>.json` — one extension per file. This is the actual installable artifact: the
  exact JSON a user's Hibiki installs is fetched straight from this file's raw GitHub URL.
- `repository/index.json` — the marketplace catalog Hibiki fetches to list what's installable.
  **Generated file — do not hand-edit.** CI regenerates it from `extensions/*.json` on every push
  that touches that directory (see [.github/workflows/update-index.yml](.github/workflows/update-index.yml)).
- `scripts/build_index.py` — the generator; also runnable locally (`python scripts/build_index.py`)
  to preview the index before pushing.

## Extension manifest format

```json
{
  "id": "example-source",
  "name": "Example Source",
  "version": "1.0.0",
  "description": "One-line description of the site this scrapes.",
  "author": "Your name",
  "website": "https://example.com",
  "iconUrl": null,
  "lang": "en",
  "capabilities": ["LATEST_RELEASES", "PLAYBACK"],
  "cleartextPlaybackHosts": [],
  "payload": "var Provider = { search: function(query, limit, offset) { ... }, latest: function(limit) { ... }, getById: function(id) { ... }, getPlaybackGroups: function(titleId) { ... }, getPlayerLinks: function(titleId, groupId, episodeId) { ... } };"
}
```

Field notes:
- `id` — lowercase slug, must be unique, doubles as the filename (`extensions/<id>.json`).
- `version` — basic semver (`x.y.z`).
- `lang` — ISO 639-1 tag (`en`, `ru`, ...).
- `capabilities` — today the host requires **both** `LATEST_RELEASES` and `PLAYBACK` on every
  scripted extension (see `ScriptedAnimeSource` in the `hibiki` repo); this is a current
  limitation of the runtime, not a per-extension choice.
- `cleartextPlaybackHosts` — hostnames this extension is explicitly allowed to return plain
  `http://` playback URLs for (some source sites still serve direct video over HTTP).
- `payload` — plain JavaScript (no TypeScript/bundler support yet). The `Provider` object's
  methods are called synchronously from Kotlin; a `fetch(url, options)` global and a curated
  `Jsoup.parse(html[, baseUrl])` global are the only ways to reach the network/parse HTML. See
  `extensions/animevost.json` for a complete, real example, and the `hibiki` repo's
  `RhinoExtensionRuntime`/`ScriptedAnimeSource` for exactly how each method is invoked.

**Gotcha when writing a payload:** any string returned from a `Jsoup`/Java call (`.text()`,
`.attr()`, `.absUrl()`) comes back as a boxed Java object inside Rhino, not a JS string primitive —
`===`, `.charAt()`, and regex behave wrong on it until you wrap it with `String(x)`. Every such
call in `animevost.json`'s payload goes through a small `S(x)` helper for exactly this reason.

## Publishing a new or updated extension

1. Add or edit `extensions/<id>.json` by hand (or via your own tooling) and push to `main`.
2. CI validates every manifest and regenerates `repository/index.json` automatically — nothing
   else to do. There is no manual seed step: every index entry is derived entirely from its
   `extensions/<id>.json` file, so a brand-new extension needs no special first-time handling.

## What used to be here

This repo previously hosted Mihon-style per-source Android application modules (built, signed,
and distributed as APKs via `PackageManager`). That entire pipeline — Gradle modules, keystore
signing, `artifacts/*.apk`, the old APK-centric `repository/index.json` schema — was deleted
wholesale when Hibiki moved to scripted (Rhino/JS) extensions; see git history before this point
if that old approach is ever needed for reference.
