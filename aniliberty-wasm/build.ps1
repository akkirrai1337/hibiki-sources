param(
    [string]$OutputName = "ani-liberty-0.1.0.zip",
    [string]$PackageUrl = "",
    [string]$RepositoryIndexPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".")).Path
$artifactDirectory = Join-Path $projectRoot "..\artifacts"
$stagingDirectory = Join-Path $projectRoot "..\.package-staging"
$wasmPath = Join-Path $projectRoot "target\wasm32-wasip1\release\aniliberty_wasm.wasm"
$archivePath = Join-Path $artifactDirectory $OutputName

trap {
    $errorRecord = $_
    if ([System.IO.Directory]::Exists($stagingDirectory)) { [System.IO.Directory]::Delete($stagingDirectory, $true) }
    throw $errorRecord.Exception
}

if ([System.IO.Path]::IsPathRooted($OutputName) -or
    [System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or
    [System.IO.Path]::GetExtension($OutputName) -ne ".zip") {
    throw "OutputName must be a filename with a .zip extension"
}

if ($PackageUrl) {
    $parsedUri = $null
    if (-not [Uri]::TryCreate($PackageUrl, [UriKind]::Absolute, [ref]$parsedUri) -or
        -not $PackageUrl.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($parsedUri.Host)) {
        throw "PackageUrl must be an absolute HTTPS URL"
    }
}

New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
if ([System.IO.Directory]::Exists($stagingDirectory)) {
    [System.IO.Directory]::Delete($stagingDirectory, $true)
}
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

cargo build --manifest-path (Join-Path $projectRoot "Cargo.toml") --target wasm32-wasip1 --release
Copy-Item (Join-Path $projectRoot "package\manifest.json") (Join-Path $stagingDirectory "manifest.json")
Copy-Item $wasmPath (Join-Path $stagingDirectory "source.wasm")

if ($PackageUrl) {
    $packageManifestPath = Join-Path $stagingDirectory "manifest.json"
    $packageManifest = Get-Content -Raw -LiteralPath $packageManifestPath | ConvertFrom-Json
    $packageManifest.packageUrl = $PackageUrl
    [System.IO.File]::WriteAllText(
        $packageManifestPath,
        ($packageManifest | ConvertTo-Json -Depth 20),
        [System.Text.UTF8Encoding]::new($false)
    )
}
$publishedManifest = Get-Content -Raw -LiteralPath (Join-Path $stagingDirectory "manifest.json")

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

if ($RepositoryIndexPath) {
    if (-not $PackageUrl) {
        throw "PackageUrl is required when RepositoryIndexPath is specified"
    }
    $manifest = $publishedManifest | ConvertFrom-Json
    $manifest.sha256 = $hash
    $manifest.artifactSizeBytes = $artifact.Length
    $indexPath = if ([System.IO.Path]::IsPathRooted($RepositoryIndexPath)) {
        [System.IO.Path]::GetFullPath($RepositoryIndexPath)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $projectRoot $RepositoryIndexPath))
    }
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($indexPath)) | Out-Null
    if ([System.IO.File]::Exists($indexPath)) {
        $index = Get-Content -Raw -LiteralPath $indexPath | ConvertFrom-Json
    } else {
        $index = [pscustomobject]@{ apiVersion = 1; sources = @() }
    }
    $index.apiVersion = 1
    $index.sources = @($index.sources | Where-Object { $_.sourceId -ne $manifest.sourceId }) + $manifest
    [System.IO.File]::WriteAllText(
        $indexPath,
        ($index | ConvertTo-Json -Depth 20),
        [System.Text.UTF8Encoding]::new($false)
    )
    Write-Output "repositoryIndex=$indexPath"
}

if ([System.IO.Directory]::Exists($stagingDirectory)) {
    [System.IO.Directory]::Delete($stagingDirectory, $true)
}
