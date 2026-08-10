$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path $PSScriptRoot).Path
$artifactDirectory = Join-Path $repositoryRoot "artifacts"
$runId = [Guid]::NewGuid().ToString("N")
$names = @("ani-liberty-package-$runId.zip", "yummyanime-package-$runId.zip", "animego-package-$runId.zip")
$expectedSourceIds = @("ani-liberty", "yummy-anime", "animego")
$unpackRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("beakokit-package-smoke-" + $runId)

function Assert-PackageManifest($manifestPath, $expectedSourceId, $packageName) {
    if (-not [System.IO.File]::Exists($manifestPath)) {
        throw "Package $packageName does not contain manifest.json"
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.manifestFormatVersion -ne 1) { throw "Package $packageName has an unsupported manifest format" }
    if ($manifest.sourceId -ne $expectedSourceId) { throw "Package $packageName has sourceId '$($manifest.sourceId)', expected '$expectedSourceId'" }
    if ([string]::IsNullOrWhiteSpace([string]$manifest.packageVersion) -or
        [string]$manifest.packageVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "Package $packageName has an invalid packageVersion"
    }
    if ([string]::IsNullOrWhiteSpace([string]$manifest.sourceInfo.displayName)) {
        throw "Package $packageName is missing sourceInfo.displayName"
    }
    if ($null -eq $manifest.sourceInfo.languages -or $manifest.sourceInfo.languages.Count -eq 0) {
        throw "Package $packageName is missing sourceInfo.languages"
    }
    if ($manifest.runtime.id -ne "wasm" -or $manifest.runtime.abi -ne "wasm32-wasi-preview1") {
        throw "Package $packageName has an invalid WASM runtime declaration"
    }
    if ($manifest.entrypoint -ne "source.wasm") { throw "Package $packageName has an invalid entrypoint" }
    if ([string]$manifest.packageUrl -notmatch '^https://[^\s/]+(?:/[^\s]*)?$') {
        throw "Package $packageName has an invalid packageUrl"
    }
    if ([string]$manifest.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Package $packageName has an invalid sha256"
    }
    if ($null -eq $manifest.capabilities -or $manifest.capabilities.Count -eq 0) {
        throw "Package $packageName is missing capabilities"
    }
    return $manifest
}

try {
    New-Item -ItemType Directory -Force -Path $unpackRoot | Out-Null
    & (Join-Path $repositoryRoot "aniliberty-wasm\build.ps1") -OutputName $names[0]
    & (Join-Path $repositoryRoot "yummyanime-wasm\build.ps1") -OutputName $names[1]
    & (Join-Path $repositoryRoot "animego-wasm\build.ps1") -OutputName $names[2]

    $paths = @()
    for ($index = 0; $index -lt $names.Count; $index++) {
        $name = $names[$index]
        $destination = Join-Path $unpackRoot ([System.IO.Path]::GetFileNameWithoutExtension($name))
        Expand-Archive -LiteralPath (Join-Path $artifactDirectory $name) -DestinationPath $destination -Force
        $manifestPath = Join-Path $destination "manifest.json"
        $manifest = Assert-PackageManifest $manifestPath $expectedSourceIds[$index] $name
        $wasm = Join-Path $destination "source.wasm"
        if (-not [System.IO.File]::Exists($wasm)) { throw "Package $name does not contain source.wasm" }
        $entrypoint = Join-Path $destination ([string]$manifest.entrypoint)
        if (-not [System.IO.File]::Exists($entrypoint)) { throw "Package $name entrypoint does not exist" }
        $files = @(Get-ChildItem -LiteralPath $destination -File -Recurse | ForEach-Object {
            $_.FullName.Substring($destination.Length + 1).Replace([System.IO.Path]::DirectorySeparatorChar, "/")
        })
        $unexpectedFiles = @($files | Where-Object { $_ -notin @("manifest.json", "source.wasm") })
        if ($unexpectedFiles.Count -gt 0 -or $files.Count -ne 2) {
            throw "Package $name contains unexpected files: $($files -join ', ')"
        }
        $paths += $wasm
    }

    $env:ANILIBERTY_WASM_PATH = $paths[0]
    $env:YUMMYANIME_WASM_PATH = $paths[1]
    $env:ANIMEGO_WASM_PATH = $paths[2]
    node (Join-Path $repositoryRoot "interop-smoke.mjs")
} finally {
    Remove-Item -LiteralPath $unpackRoot -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($name in $names) {
        Remove-Item -LiteralPath (Join-Path $artifactDirectory $name) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item Env:ANILIBERTY_WASM_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:YUMMYANIME_WASM_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:ANIMEGO_WASM_PATH -ErrorAction SilentlyContinue
}
