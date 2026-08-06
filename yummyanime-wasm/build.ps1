param(
    [string]$OutputName = "yummyanime-0.1.1.zip",
    [string]$PackageUrl = "",
    [string]$RepositoryIndexPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path $PSScriptRoot).Path
$artifactDirectory = Join-Path $projectRoot "..\artifacts"
$stagingDirectory = Join-Path $projectRoot "..\.yummyanime-package-staging"
$wasmPath = Join-Path $projectRoot "target\wasm32-wasip1\release\yummyanime_wasm.wasm"
$archivePath = Join-Path $artifactDirectory $OutputName

New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
if ([System.IO.Directory]::Exists($stagingDirectory)) { [System.IO.Directory]::Delete($stagingDirectory, $true) }
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

cargo build --manifest-path (Join-Path $projectRoot "Cargo.toml") --target wasm32-wasip1 --release
Copy-Item (Join-Path $projectRoot "package\manifest.json") (Join-Path $stagingDirectory "manifest.json")
Copy-Item $wasmPath (Join-Path $stagingDirectory "source.wasm")

if ($PackageUrl) {
    $manifestPath = Join-Path $stagingDirectory "manifest.json"
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $manifest.packageUrl = $PackageUrl
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
}
$publishedManifest = Get-Content -Raw -LiteralPath (Join-Path $stagingDirectory "manifest.json")
if ([System.IO.File]::Exists($archivePath)) { [System.IO.File]::Delete($archivePath) }
Compress-Archive -Path (Join-Path $stagingDirectory "manifest.json"), (Join-Path $stagingDirectory "source.wasm") -DestinationPath $archivePath -CompressionLevel Optimal
[System.IO.Directory]::Delete($stagingDirectory, $true)

$artifact = Get-Item -LiteralPath $archivePath
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "artifact=$($artifact.FullName)"
Write-Output "artifactSizeBytes=$($artifact.Length)"
Write-Output "sha256=$hash"

if ($RepositoryIndexPath) {
    if (-not $PackageUrl) { throw "PackageUrl is required when RepositoryIndexPath is specified" }
    $manifest = $publishedManifest | ConvertFrom-Json
    $manifest.sha256 = $hash
    $manifest.artifactSizeBytes = $artifact.Length
    $indexPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $RepositoryIndexPath))
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($indexPath)) | Out-Null
    $index = [ordered]@{ apiVersion = 1; sources = @($manifest) }
    [System.IO.File]::WriteAllText($indexPath, ($index | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
    Write-Output "repositoryIndex=$indexPath"
}
