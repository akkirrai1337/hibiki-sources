$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path $PSScriptRoot).Path
$artifactDirectory = Join-Path $repositoryRoot "artifacts"
$runId = [Guid]::NewGuid().ToString("N")
$names = @("ani-liberty-package-$runId.zip", "yummyanime-package-$runId.zip", "animego-package-$runId.zip")
$expectedSourceIds = @("ani-liberty", "yummy-anime", "animego")
$unpackRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("beakokit-package-smoke-" + $runId)

function Assert-ManifestMatchesRepositoryIndex($manifestPaths, $indexPath) {
    $manifests = @{}
    foreach ($manifestPath in $manifestPaths) {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$manifest.sourceId)) { throw "Local manifest has a blank sourceId: $manifestPath" }
        if ($manifests.ContainsKey([string]$manifest.sourceId)) { throw "Duplicate local manifest sourceId: $($manifest.sourceId)" }
        $manifests[[string]$manifest.sourceId] = $manifest
    }
    $index = (Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json).sources
    $indexSourceIds = @($index | ForEach-Object { [string]$_.sourceId })
    foreach ($sourceId in $manifests.Keys) {
        if ($sourceId -notin $indexSourceIds) { throw "Local manifest $sourceId is missing from repository index" }
    }
    foreach ($entry in $index) {
        $sourceId = [string]$entry.sourceId
        if (-not $manifests.ContainsKey($sourceId)) { throw "Repository index source $sourceId has no local manifest" }
        $manifest = $manifests[$sourceId]
        foreach ($field in @("sourceId", "packageVersion", "entrypoint")) {
            if ([string]$manifest.$field -ne [string]$entry.$field) {
                throw "Repository index $sourceId field $field differs from local manifest"
            }
        }
        if ((ConvertTo-Json @($manifest.capabilities) -Compress) -ne (ConvertTo-Json @($entry.capabilities) -Compress)) {
            throw "Repository index $sourceId capabilities differ from local manifest"
        }
        if ((ConvertTo-Json $manifest.sourceInfo -Depth 10 -Compress) -ne (ConvertTo-Json $entry.sourceInfo -Depth 10 -Compress)) {
            throw "Repository index $sourceId sourceInfo differs from local manifest"
        }
        if ((ConvertTo-Json @($manifest.hostCapabilities) -Compress) -ne (ConvertTo-Json @($entry.hostCapabilities) -Compress) -or
            (ConvertTo-Json $manifest.hostNetworkPolicy -Depth 10 -Compress) -ne (ConvertTo-Json $entry.hostNetworkPolicy -Depth 10 -Compress)) {
            throw "Repository index $sourceId host policy differs from local manifest"
        }
        if ([string]$manifest.runtime.id -ne [string]$entry.runtime.id -or
            [string]$manifest.runtime.abi -ne [string]$entry.runtime.abi) {
            throw "Repository index $sourceId runtime differs from local manifest"
        }
    }
}

Assert-ManifestMatchesRepositoryIndex @(
    (Join-Path $repositoryRoot "aniliberty-wasm\package\manifest.json"),
    (Join-Path $repositoryRoot "yummyanime-wasm\package\manifest.json"),
    (Join-Path $repositoryRoot "animego-wasm\package\manifest.json")
) (Join-Path $repositoryRoot "repository\index.json")

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
    if ([string]::IsNullOrWhiteSpace([string]$manifest.sourceInfo.primaryLanguage) -or
        @($manifest.sourceInfo.languages) -notcontains [string]$manifest.sourceInfo.primaryLanguage) {
        throw "Package $packageName has an invalid sourceInfo.primaryLanguage"
    }
    if ($null -eq $manifest.hostCapabilities -or @($manifest.hostCapabilities).Count -eq 0) {
        throw "Package $packageName is missing hostCapabilities"
    }
    if ($null -eq $manifest.hostNetworkPolicy -or $null -eq $manifest.hostNetworkPolicy.allowedHosts -or
        @($manifest.hostNetworkPolicy.allowedHosts).Count -eq 0) {
        throw "Package $packageName is missing hostNetworkPolicy.allowedHosts"
    }
    foreach ($allowedHost in @($manifest.hostNetworkPolicy.allowedHosts)) {
        if ([string]$allowedHost -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$') {
            throw "Package $packageName has an invalid hostNetworkPolicy.allowedHosts value: $allowedHost"
        }
    }
    foreach ($field in @("sourceInfo.languages", "capabilities", "hostCapabilities", "hostNetworkPolicy.allowedHosts")) {
        $value = $manifest
        foreach ($part in $field.Split('.')) { $value = $value.$part }
        $items = @($value)
        if (@($items | Sort-Object -Unique).Count -ne $items.Count) {
            throw "Package $packageName field $field contains duplicate values"
        }
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

function Assert-RepositoryIndex($indexPath, $expectedSourceIds) {
    if (-not [System.IO.File]::Exists($indexPath)) { throw "Repository index does not exist: $indexPath" }
    $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
    if ($index.apiVersion -ne 1 -or $null -eq $index.sources) { throw "Repository index has an invalid envelope" }
    $sourceIds = @($index.sources | ForEach-Object { [string]$_.sourceId })
    if ($sourceIds.Count -eq 0 -or @($sourceIds | Sort-Object -Unique).Count -ne $sourceIds.Count) {
        throw "Repository index contains blank or duplicate sourceId values"
    }
    foreach ($expectedSourceId in $expectedSourceIds) {
        $manifest = @($index.sources | Where-Object { $_.sourceId -eq $expectedSourceId })[0]
        if ($null -eq $manifest -or $manifest.manifestFormatVersion -ne 1 -or
            [string]$manifest.packageVersion -notmatch '^\d+\.\d+\.\d+$' -or
            [string]::IsNullOrWhiteSpace([string]$manifest.sourceInfo.displayName) -or
            $manifest.runtime.id -ne "wasm" -or $manifest.runtime.abi -ne "wasm32-wasi-preview1" -or
            $manifest.entrypoint -ne "source.wasm" -or $null -eq $manifest.capabilities -or $manifest.capabilities.Count -eq 0 -or
            [string]$manifest.packageUrl -notmatch '^https://[^\s/]+(?:/[^\s]*)?$' -or
            [string]$manifest.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or [int64]$manifest.artifactSizeBytes -le 0) {
            throw "Repository index entry is invalid: $expectedSourceId"
        }
    }
}

Assert-RepositoryIndex (Join-Path $repositoryRoot "repository\index.json") @("ani-liberty", "yummy-anime", "animego")

try {
    New-Item -ItemType Directory -Force -Path $unpackRoot | Out-Null
    $indexPath = Join-Path $unpackRoot "index.json"
    $fixtureManifest = [pscustomobject]@{
        manifestFormatVersion = 1
        sourceId = "fixture-source"
        packageVersion = "1.0.0"
        sourceInfo = [pscustomobject]@{
            displayName = "Fixture Source"
            languages = @("en")
            primaryLanguage = "en"
        }
        apiVersion = 1
        hostApiVersion = 1
        runtime = [pscustomobject]@{ id = "wasm"; abi = "wasm32-wasi-preview1" }
        entrypoint = "source.wasm"
        packageUrl = "https://example.invalid/fixture-source.zip"
        sha256 = ("0" * 64)
        artifactSizeBytes = 1
        minClientVersion = 0
        capabilities = @("SEARCH")
        hostCapabilities = @("NETWORK")
        hostNetworkPolicy = [pscustomobject]@{ allowedHosts = @("example.invalid") }
    }
    $fixtureIndex = [pscustomobject]@{ apiVersion = 1; sources = @($fixtureManifest) }
    [System.IO.File]::WriteAllText(
        $indexPath,
        ($fixtureIndex | ConvertTo-Json -Depth 20),
        [System.Text.UTF8Encoding]::new($false)
    )
    & (Join-Path $repositoryRoot "aniliberty-wasm\build.ps1") -OutputName $names[0] -PackageUrl ("https://example.invalid/" + $names[0]) -RepositoryIndexPath $indexPath
    & (Join-Path $repositoryRoot "yummyanime-wasm\build.ps1") -OutputName $names[1] -PackageUrl ("https://example.invalid/" + $names[1]) -RepositoryIndexPath $indexPath
    & (Join-Path $repositoryRoot "animego-wasm\build.ps1") -OutputName $names[2] -PackageUrl ("https://example.invalid/" + $names[2]) -RepositoryIndexPath $indexPath
    & (Join-Path $repositoryRoot "aniliberty-wasm\build.ps1") -OutputName $names[0] -PackageUrl ("https://example.invalid/" + $names[0]) -RepositoryIndexPath $indexPath

    $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
    $indexSourceIds = @($index.sources | ForEach-Object sourceId)
    $expectedIndexIds = @("fixture-source") + $expectedSourceIds
    if ($indexSourceIds.Count -ne $expectedIndexIds.Count -or
        @($indexSourceIds | Sort-Object -Unique).Count -ne $indexSourceIds.Count -or
        @($expectedIndexIds | Where-Object { $_ -notin $indexSourceIds }).Count -gt 0) {
        throw "Repository index merge validation failed: $($indexSourceIds -join ', ')"
    }

    $invalidIndexPath = Join-Path $unpackRoot "invalid-index.json"
    $invalidIndexContent = '{"apiVersion":1,"sources":[{"sourceId":"duplicate"},{"sourceId":"duplicate"}]}'
    [System.IO.File]::WriteAllText($invalidIndexPath, $invalidIndexContent, [System.Text.UTF8Encoding]::new($false))
    try {
        & (Join-Path $repositoryRoot "aniliberty-wasm\build.ps1") `
            -OutputName $names[0] `
            -PackageUrl ("https://example.invalid/" + $names[0]) `
            -RepositoryIndexPath $invalidIndexPath
        throw "Publishing accepted an invalid repository index"
    } catch {
        if ($_.Exception.Message -eq "Publishing accepted an invalid repository index") { throw }
    }
    if ((Get-Content -LiteralPath $invalidIndexPath -Raw) -ne $invalidIndexContent) {
        throw "Invalid repository index was modified after validation failure"
    }

    for ($packageIndex = 0; $packageIndex -lt $names.Count; $packageIndex++) {
        $artifactPath = Join-Path $artifactDirectory $names[$packageIndex]
        $artifact = Get-Item -LiteralPath $artifactPath
        $artifactHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifest = @($index.sources | Where-Object { $_.sourceId -eq $expectedSourceIds[$packageIndex] })[0]
        $expectedPackageUrl = "https://example.invalid/$($names[$packageIndex])"
        if ($manifest.packageUrl -ne $expectedPackageUrl -or
            $manifest.artifactSizeBytes -ne $artifact.Length -or
            ([string]$manifest.sha256).ToLowerInvariant() -ne $artifactHash) {
            throw "Repository index artifact metadata mismatch for $($names[$packageIndex])"
        }
    }

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
