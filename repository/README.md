# BeakoKit source repository

This directory is reserved for the published repository index.

The AniLiberty package is built into `../artifacts/ani-liberty-0.1.0.zip`. The
index must be generated only after the archive has been uploaded to a stable
HTTPS URL, because `packageUrl`, `sha256`, and `artifactSizeBytes` are verified
by the client before installation.

From `aniliberty-wasm`, use the build script with the final package URL:

```powershell
.\build.ps1 `
  -PackageUrl "https://your-host.example/ani-liberty-0.1.0.zip" `
  -RepositoryIndexPath "..\repository\index.json"
```

Without `-PackageUrl`, the script builds only the local artifact and does not
generate an installable repository index.
