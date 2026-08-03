# Kotlin/Wasm BeakoKit reference

This project is a Kotlin/Wasm/WASI reference for the BeakoKit guest ABI. It
implements the same AniLiberty `SEARCH`, `DETAILS`, and playback operations as
the first Rust source step, while demonstrating the `host.call` import and
the exported `beakokit_reset`, `beakokit_alloc`, and `beakokit_call` functions.

Build it with:

```powershell
..\..\hibiki\gradlew wasmWasiJar
```

To create the same two-file source package used by the Rust reference:

```powershell
.\build-package.ps1
```

The Kotlin/Wasm toolchain is evolving, so this reference is kept separate from
the Rust production package. Both implementations use the same host protocol.

The host bridge must provision at least one WASM memory page before calling the
guest allocator because Kotlin/Wasm may export memory with zero initial pages.
With that bridge behavior, the Node interop smoke test passes SEARCH, DETAILS,
PLAYBACK_GROUPS, and PLAYER_LINKS. The package is still a reference rather
than a published source: its manifest intentionally has placeholder URL and
checksum values until a real repository publication is prepared.
