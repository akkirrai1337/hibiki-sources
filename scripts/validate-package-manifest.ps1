function Assert-PackageManifest {
    param([object]$Manifest)

    if ($null -eq $Manifest -or $Manifest.manifestFormatVersion -ne 1) {
        throw "Package manifest has an unsupported format"
    }
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.sourceId) -or
        [string]$Manifest.sourceId -notmatch '^[a-z0-9][a-z0-9-]{1,63}$') {
        throw "Package manifest has an invalid sourceId"
    }
    if ([string]$Manifest.packageVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "Package manifest has an invalid packageVersion"
    }
    if ($null -eq $Manifest.sourceInfo -or
        [string]::IsNullOrWhiteSpace([string]$Manifest.sourceInfo.displayName)) {
        throw "Package manifest has an invalid sourceInfo"
    }
    $languages = @($Manifest.sourceInfo.languages)
    if ($languages.Count -eq 0 -or
        @($languages | Where-Object { [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        throw "Package manifest must declare at least one language"
    }
    if ($Manifest.apiVersion -ne 1 -or $Manifest.hostApiVersion -ne 1) {
        throw "Package manifest has an unsupported API version"
    }
    if ($null -eq $Manifest.runtime -or
        [string]$Manifest.runtime.id -ne "wasm" -or
        [string]$Manifest.runtime.abi -ne "wasm32-wasi-preview1") {
        throw "Package manifest has an unsupported runtime"
    }
    if ([string]$Manifest.entrypoint -ne "source.wasm") {
        throw "Package manifest must use source.wasm as its entrypoint"
    }
    if (@($Manifest.capabilities).Count -eq 0) {
        throw "Package manifest must declare capabilities"
    }
    $packageUrl = $null
    if (-not [Uri]::TryCreate([string]$Manifest.packageUrl, [UriKind]::Absolute, [ref]$packageUrl) -or
        -not ([string]$Manifest.packageUrl).StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($packageUrl.Host)) {
        throw "Package manifest must declare an absolute HTTPS packageUrl"
    }
}
