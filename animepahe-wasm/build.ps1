param(
    [string]$OutputName = "animepahe-0.1.0.zip",
    [string]$PackageUrl = "",
    [string]$RepositoryIndexPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path $PSScriptRoot).Path
$artifactDirectory = Join-Path $projectRoot "..\artifacts"
$stagingDirectory = Join-Path $projectRoot ("..\.animepahe-package-staging-" + [Guid]::NewGuid().ToString("N"))
$wasmPath = Join-Path $projectRoot "target\wasm32-wasip1\release\animepahe_wasm.wasm"
$archivePath = Join-Path $artifactDirectory $OutputName
. (Join-Path $PSScriptRoot "..\scripts\validate-package-manifest.ps1")
. (Join-Path $PSScriptRoot "..\scripts\validate-repository-index.ps1")

try {
    New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null
cargo build --manifest-path (Join-Path $projectRoot "Cargo.toml") --target wasm32-wasip1 --release
if ($LASTEXITCODE -ne 0) { throw "AnimePahe WASM build failed with exit code $LASTEXITCODE" }
    Copy-Item $wasmPath (Join-Path $stagingDirectory "source.wasm")
    Copy-Item (Join-Path $projectRoot "package\manifest.json") (Join-Path $stagingDirectory "manifest.json")
    if ($PackageUrl) {
        $manifestPath = Join-Path $stagingDirectory "manifest.json"
        $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
        $manifest.packageUrl = $PackageUrl
        [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
    }
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $stagingDirectory "manifest.json") | ConvertFrom-Json
    Assert-PackageManifest $manifest
    if (Test-Path $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    Compress-Archive -Path (Join-Path $stagingDirectory "manifest.json"), (Join-Path $stagingDirectory "source.wasm") -DestinationPath $archivePath -CompressionLevel Optimal
    $artifact = Get-Item -LiteralPath $archivePath
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Output "artifact=$($artifact.FullName)"
    Write-Output "artifactSizeBytes=$($artifact.Length)"
    Write-Output "sha256=$hash"
    if ($RepositoryIndexPath) {
        $manifest.sha256 = $hash
        $manifest.artifactSizeBytes = $artifact.Length
        $indexPath = if ([System.IO.Path]::IsPathRooted($RepositoryIndexPath)) {
            [System.IO.Path]::GetFullPath($RepositoryIndexPath)
        } else {
            [System.IO.Path]::GetFullPath((Join-Path $projectRoot $RepositoryIndexPath))
        }
        $index = Get-Content -Raw -LiteralPath $indexPath | ConvertFrom-Json
        Assert-RepositoryIndex $index
        $index.sources = @($index.sources | Where-Object { $_.sourceId -ne $manifest.sourceId }) + $manifest
        [System.IO.File]::WriteAllText($indexPath, ($index | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
    }
} finally {
    if (Test-Path $stagingDirectory) { Remove-Item -LiteralPath $stagingDirectory -Recurse -Force }
}
