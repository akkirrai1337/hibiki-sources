param(
    [string]$OutputName = "animego-package-smoke.zip"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path $PSScriptRoot).Path
$repositoryRoot = (Resolve-Path (Join-Path $projectRoot "..")).Path
$artifactPath = Join-Path $repositoryRoot "artifacts\$OutputName"
$unpackPath = Join-Path ([System.IO.Path]::GetTempPath()) ("beakokit-animego-smoke-" + [Guid]::NewGuid().ToString("N"))

try {
    & (Join-Path $projectRoot "build.ps1") -OutputName $OutputName
    Expand-Archive -LiteralPath $artifactPath -DestinationPath $unpackPath -Force
    $wasmPath = Join-Path $unpackPath "source.wasm"
    if (-not [System.IO.File]::Exists($wasmPath)) { throw "Package does not contain source.wasm" }
    $env:ANIMEGO_WASM_PATH = $wasmPath
    Push-Location $projectRoot
    try {
        node interop-smoke.mjs
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -LiteralPath $unpackPath -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $artifactPath -Force -ErrorAction SilentlyContinue
    Remove-Item Env:ANIMEGO_WASM_PATH -ErrorAction SilentlyContinue
}
