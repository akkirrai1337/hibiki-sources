$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path $PSScriptRoot).Path
$artifactDirectory = Join-Path $repositoryRoot "artifacts"
$runId = [Guid]::NewGuid().ToString("N")
$names = @("ani-liberty-package-$runId.zip", "yummyanime-package-$runId.zip", "animego-package-$runId.zip")
$unpackRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("beakokit-package-smoke-" + $runId)

try {
    New-Item -ItemType Directory -Force -Path $unpackRoot | Out-Null
    & (Join-Path $repositoryRoot "aniliberty-wasm\build.ps1") -OutputName $names[0]
    & (Join-Path $repositoryRoot "yummyanime-wasm\build.ps1") -OutputName $names[1]
    & (Join-Path $repositoryRoot "animego-wasm\build.ps1") -OutputName $names[2]

    $paths = @()
    foreach ($name in $names) {
        $destination = Join-Path $unpackRoot ([System.IO.Path]::GetFileNameWithoutExtension($name))
        Expand-Archive -LiteralPath (Join-Path $artifactDirectory $name) -DestinationPath $destination -Force
        $wasm = Join-Path $destination "source.wasm"
        if (-not [System.IO.File]::Exists($wasm)) { throw "Package $name does not contain source.wasm" }
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
