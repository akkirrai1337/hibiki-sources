# BeakoKit external sources

The external source packages are AniLiberty and YummyAnime.

Build it from `aniliberty-wasm` with:

```powershell
.\build.ps1
```

The script rebuilds the WASM module, creates a clean package staging
directory, and prints the archive size and SHA-256 checksum.

The package layout is:

```text
manifest.json
source.wasm
```

`source.wasm` uses the BeakoKit guest ABI and requests AniLiberty data through
the host `HTTP_REQUEST` capability. It implements `SEARCH`, `DETAILS`,
`PLAYBACK_GROUPS`, and `PLAYER_LINKS`.

YummyAnime is built from `yummyanime-wasm` with:

```powershell
.\build.ps1 -PackageUrl "https://raw.githubusercontent.com/akkirrai1337/hibiki-sources/main/artifacts/yummyanime-0.1.0.zip"
```

It follows the old YummyAnime source behavior: catalog search and filters,
details, latest releases, dubbing groups, and embedded player links from the
YummyAnime API.

The generated archive is placed in `artifacts/` and may be committed when the
repository itself is used as the package host. Do not publish a repository
index with placeholder URLs or checksums: the client validates all three
artifact fields before installation.

`interop-smoke.mjs` runs the same mocked host protocol against both the Rust
and Kotlin references. Both references pass the complete operation set,
including playback groups and player links. The production host bridge
provisions guest memory when a module starts with zero pages, which is required
by the current Kotlin/Wasm reference as well as supported Rust packages.
