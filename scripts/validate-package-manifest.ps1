function Assert-ManifestString {
    param([object]$Value, [string]$Field)

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        throw "Package manifest field '$Field' must be a non-empty string"
    }
}

function Assert-ManifestStringArray {
    param([object]$Value, [string]$Field, [switch]$Required)

    if ($null -eq $Value) {
        if ($Required) { throw "Package manifest field '$Field' must be an array" }
        return
    }
    $items = @($Value)
    if ($Required -and $items.Count -eq 0) {
        throw "Package manifest field '$Field' must contain at least one value"
    }
    $seen = @{}
    foreach ($item in $items) {
        Assert-ManifestString $item $Field
        if ($seen.ContainsKey($item)) {
            throw "Package manifest field '$Field' contains duplicate values"
        }
        $seen[$item] = $true
    }
}

function Assert-ManifestInteger {
    param([object]$Value, [string]$Field, [switch]$NonNegative, [switch]$Positive)

    if ($Value -isnot [int] -and $Value -isnot [long]) {
        throw "Package manifest field '$Field' must be an integer"
    }
    if ($NonNegative -and $Value -lt 0) {
        throw "Package manifest field '$Field' must not be negative"
    }
    if ($Positive -and $Value -le 0) {
        throw "Package manifest field '$Field' must be positive"
    }
}

function Assert-PackageManifest {
    param([object]$Manifest)

    if ($null -eq $Manifest -or $Manifest.manifestFormatVersion -isnot [int] -or $Manifest.manifestFormatVersion -ne 1) {
        throw "Package manifest has an unsupported format"
    }
    Assert-ManifestString $Manifest.sourceId "sourceId"
    if ($Manifest.sourceId -notmatch '^[a-z0-9][a-z0-9-]{1,63}$') {
        throw "Package manifest has an invalid sourceId"
    }
    Assert-ManifestString $Manifest.packageVersion "packageVersion"
    if ($Manifest.packageVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "Package manifest has an invalid packageVersion"
    }
    if ($null -eq $Manifest.sourceInfo -or $Manifest.sourceInfo -is [string]) {
        throw "Package manifest has an invalid sourceInfo"
    }
    Assert-ManifestString $Manifest.sourceInfo.displayName "sourceInfo.displayName"
    Assert-ManifestStringArray $Manifest.sourceInfo.languages "sourceInfo.languages" -Required
    Assert-ManifestString $Manifest.sourceInfo.primaryLanguage "sourceInfo.primaryLanguage"
    if (@($Manifest.sourceInfo.languages) -notcontains $Manifest.sourceInfo.primaryLanguage) {
        throw "Package manifest primaryLanguage must be declared in languages"
    }
    if ($Manifest.apiVersion -isnot [int] -or $Manifest.hostApiVersion -isnot [int] -or
        $Manifest.apiVersion -ne 1 -or $Manifest.hostApiVersion -ne 1) {
        throw "Package manifest has an unsupported API version"
    }
    if ($null -eq $Manifest.runtime -or $Manifest.runtime -is [string]) {
        throw "Package manifest has an unsupported runtime"
    }
    Assert-ManifestString $Manifest.runtime.id "runtime.id"
    Assert-ManifestString $Manifest.runtime.abi "runtime.abi"
    if ($Manifest.runtime.id -ne "wasm" -or $Manifest.runtime.abi -ne "wasm32-wasi-preview1") {
        throw "Package manifest has an unsupported runtime"
    }
    Assert-ManifestString $Manifest.entrypoint "entrypoint"
    if ($Manifest.entrypoint -ne "source.wasm") {
        throw "Package manifest must use source.wasm as its entrypoint"
    }
    Assert-ManifestStringArray $Manifest.capabilities "capabilities" -Required
    Assert-ManifestStringArray $Manifest.hostCapabilities "hostCapabilities" -Required
    if ($null -eq $Manifest.hostNetworkPolicy -or $Manifest.hostNetworkPolicy -is [string]) {
        throw "Package manifest must declare hostNetworkPolicy"
    }
    Assert-ManifestStringArray $Manifest.hostNetworkPolicy.allowedHosts "hostNetworkPolicy.allowedHosts" -Required
    Assert-ManifestString $Manifest.sha256 "sha256"
    if ($Manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw "Package manifest has an invalid sha256"
    }
    Assert-ManifestInteger $Manifest.artifactSizeBytes "artifactSizeBytes" -Positive
    Assert-ManifestInteger $Manifest.minClientVersion "minClientVersion" -NonNegative
    Assert-ManifestString $Manifest.packageUrl "packageUrl"
    $packageUrl = $null
    if (-not [Uri]::TryCreate($Manifest.packageUrl, [UriKind]::Absolute, [ref]$packageUrl) -or
        -not $Manifest.packageUrl.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($packageUrl.Host)) {
        throw "Package manifest must declare an absolute HTTPS packageUrl"
    }
}
