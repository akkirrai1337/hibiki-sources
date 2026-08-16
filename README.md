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
