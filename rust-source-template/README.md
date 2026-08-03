# Rust source template

Copy this directory when starting a new Rust BeakoKit source. The template
already contains the guest ABI, protocol envelopes, host HTTP bridge, and
package manifest. Implement the four operation branches in `src/lib.rs`, add
the source's allowed hosts to the manifest, and then compile for
`wasm32-wasip1`.

`aniliberty-wasm` is the complete working example; this directory intentionally
contains no source-specific API logic.

Build a local package with:

```powershell
.\build-package.ps1
```
