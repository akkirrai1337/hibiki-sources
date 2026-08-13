# BeakoKit external sources

The external source packages are AniLiberty, YummyAnime, and AnimeGo.

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

The shared `beakokit-html-sdk` crate provides bounded HTML/JSON parsing,
selector errors, required-field helpers, and URL normalization for HTML/AJAX
sources. AnimeGo uses it for both ordinary pages and JSON `data.content`
responses; AniLiberty and YummyAnime use its bounded JSON parser for API
responses.

YummyAnime is built from `yummyanime-wasm` with:

```powershell
.\build.ps1 -PackageUrl "https://raw.githubusercontent.com/akkirrai1337/hibiki-sources/main/artifacts/yummyanime-0.1.0.zip"
```

It follows the old YummyAnime source behavior: catalog search and filters,
details, latest releases, dubbing groups, and embedded player links from the
YummyAnime API.

AnimeGo is built from `animego-wasm` with:

```powershell
.\animego-wasm\build.ps1 -PackageUrl "https://raw.githubusercontent.com/akkirrai1337/hibiki-sources/main/artifacts/animego-0.1.0.zip" -RepositoryIndexPath "..\repository\index.json"
```

It follows the old AnimeGo source behavior: catalog search and pagination,
sorts, type/status/genre/year filters, details with poster fallback, latest
releases, episode groups, and embedded player links from AnimeGo's HTML and
AJAX endpoints.

The generated archive is placed in `artifacts/` and may be committed when the
repository itself is used as the package host. Do not publish a repository
index with placeholder URLs or checksums: the client validates all three
artifact fields before installation.

`interop-smoke.mjs` runs the mocked host protocol against AniLiberty,
YummyAnime, and the Kotlin reference. `animego-wasm/interop-smoke.mjs` runs the packaged AnimeGo WASM
module through the same host bridge and checks SEARCH, FILTER_CATALOG,
DETAILS, PLAYBACK_GROUPS, and PLAYER_LINKS against captured HTML/AJAX fixtures.
`animego-wasm/package-smoke.ps1` additionally builds and unpacks the ZIP first,
so the same checks run against the exact `source.wasm` shipped to the client.
`package-smoke.ps1` performs the same package-level check for AniLiberty,
YummyAnime, and AnimeGo together.
The AnimeGo-specific interop suite is also run against the unpacked AnimeGo
artifact, so the release gate exercises the exact WASM file being published.
AnimePahe is included in the archive and manifest gate, and its Rust parser
tests run as part of the same local check.
Run it locally before publishing; it fails the release check when a catalog
item or details response has no usable poster, episode count, or human-readable
genres. No CI workflow is required for this release gate.
It also verifies that every production artifact referenced by
`repository/index.json` exists locally with the exact recorded size and SHA-256.
Each referenced ZIP is unpacked and checked for the exact two-file layout and
manifest-to-index consistency before the temporary build checks begin.
The embedded capabilities, source information, runtime and network policy are
also compared, so the archive cannot carry a stale declaration.
The index additionally enforces unique artifact names following the source ID
and package version convention (`source-version.zip`).
The production host bridge provisions guest memory when a module starts with
zero pages, which is required by the current Kotlin/Wasm reference as well as
supported Rust packages.
