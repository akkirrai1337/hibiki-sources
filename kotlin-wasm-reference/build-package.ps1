$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path $PSScriptRoot).Path
$wasmPath = Join-Path $projectRoot "build\compileSync\wasmWasi\main\productionExecutable\kotlin\beakokit-kotlin-wasm-reference.wasm"
$artifactDirectory = Join-Path $projectRoot "artifacts"
$stagingDirectory = Join-Path $projectRoot ".package-staging"
$archivePath = Join-Path $artifactDirectory "kotlin-reference-0.1.0.zip"

New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
if ([System.IO.Directory]::Exists($stagingDirectory)) {
    [System.IO.Directory]::Delete($stagingDirectory, $true)
}
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

& (Join-Path $projectRoot "..\..\hibiki\gradlew.bat") -p $projectRoot compileProductionExecutableKotlinWasmWasi
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
