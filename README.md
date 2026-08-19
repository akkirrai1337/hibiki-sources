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
extensions/<name>/   one Gradle module per source extension (e.g. extensions/aniliberty)
repository/          hand-authored repository/index.json served to the app
artifacts/           built, CI-published release APKs referenced by the index
```

Adding a new source: create `extensions/<name>/` with its own
`build.gradle.kts` (copy an existing module as a template), add
`include(":extensions:<name>")` to `settings.gradle.kts`, and add its entry
to `repository/index.json`. CI discovers changed modules by walking each
changed file's path up to its nearest `build.gradle.kts` -- no workflow
changes needed per source.
