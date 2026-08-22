# Hibiki sources

Hibiki external sources, rebuilt for the Mihon-style JVM/APK-extension model
(replacing the previous WASM/Wasmtime runtime).

Each source is a plain Kotlin/Android module implementing the
`AnimeSource`/`ConfigurableSource` contract from the main
[hibiki](https://github.com/akkirrai1337/hibiki) repo's `:parsers` module,
packaged as its own installable APK and discovered on-device via
`PackageManager`.

This repository is being rebuilt from scratch. The previous WASM-era content
(Rust source crates, `beakokit-html-sdk`, the WASM package/repository-index
tooling) has been removed.

## Layout

```text
extensions/<lang>/<name>/   one Gradle module per source extension, grouped by the
                             source's primary language (e.g. extensions/ru/aniliberty,
                             extensions/en/kickassanime)
repository/                 hand-authored repository/index.json served to the app
artifacts/                  built, CI-published release APKs referenced by the index
tools/                      dev-only scripts, e.g. tools/probe.py for scouting a source's API
```

Adding a new source: create `extensions/<lang>/<name>/` with its own
`build.gradle.kts` (copy an existing module as a template), add
`include(":extensions:<lang>:<name>")` to `settings.gradle.kts`, and add its
entry to `repository/index.json`. CI discovers changed modules by walking
each changed file's path up to its nearest `build.gradle.kts` regardless of
nesting depth -- no workflow changes needed per source or per language
group.

Reusable JSON-parsing helpers (`asObject`/`asArray`/`string`/`int`/`double`/
`bool`/`obj`/`array`/`strings` on `JsonElement`/`JsonObject`) live in the main
[hibiki](https://github.com/akkirrai1337/hibiki) repo's
`org.akkirrai.beakokit.json` package (`:parsers` module) -- import them
instead of re-declaring private copies in a new source's client. Before
writing that client, `tools/probe.py` (see `tools/README.md`) is a quick way
to see the shape of the upstream API you're targeting.
