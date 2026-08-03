param(
    [string]$OutputName = "example-source-0.1.0.zip"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path $PSScriptRoot).Path
$artifactDirectory = Join-Path $projectRoot "artifacts"
$stagingDirectory = Join-Path $projectRoot ".package-staging"
$wasmPath = Join-Path $projectRoot "target\wasm32-wasip1\release\beakokit_rust_source_template.wasm"
$archivePath = Join-Path $artifactDirectory $OutputName

New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
if ([System.IO.Directory]::Exists($stagingDirectory)) {
    [System.IO.Directory]::Delete($stagingDirectory, $true)
}
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

cargo build --manifest-path (Join-Path $projectRoot "Cargo.toml") --target wasm32-wasip1 --release
Copy-Item (Join-Path $projectRoot "package\manifest.json") (Join-Path $stagingDirectory "manifest.json")
Copy-Item $wasmPath (Join-Path $stagingDirectory "source.wasm")

if ([System.IO.File]::Exists($archivePath)) {
    [System.IO.File]::Delete($archivePath)
}
Compress-Archive `
    -Path (Join-Path $stagingDirectory "manifest.json"), (Join-Path $stagingDirectory "source.wasm") `
    -DestinationPath $archivePath `
    -CompressionLevel Optimal
[System.IO.Directory]::Delete($stagingDirectory, $true)

$artifact = Get-Item -LiteralPath $archivePath
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "artifact=$($artifact.FullName)"
Write-Output "artifactSizeBytes=$($artifact.Length)"
Write-Output "sha256=$hash"
