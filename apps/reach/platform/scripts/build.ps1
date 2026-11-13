param(
    [string]$SourceRepository,
    [ValidateSet('Windows', 'Linux')][string]$Target = 'Windows',
    [switch]$SkipTests
)
# Copyright (c) Ray Zhang. Optional platform build, independent of the old checkout.
$ErrorActionPreference = 'Stop'
$platformRoot = Split-Path $PSScriptRoot -Parent
Push-Location $platformRoot
$priorConf = $env:HW_CONF
$priorGoos = $env:GOOS
$priorGoarch = $env:GOARCH
$priorCgo = $env:CGO_ENABLED
try {
    $prepareArgs = @('scripts/source.py', 'prepare')
    if ($SourceRepository) { $prepareArgs += @('--source-repository', $SourceRepository) }
    & python @prepareArgs
    if ($LASTEXITCODE -ne 0) { throw 'Pinned shared dependency preparation failed' }
    $env:HW_CONF = Join-Path $platformRoot ('work/test-state-' + [guid]::NewGuid().ToString('N'))
    $env:GOOS = ''
    $env:GOARCH = ''
    $env:CGO_ENABLED = '0'
    if (!$SkipTests) {
        & python scripts/test_source.py
        if ($LASTEXITCODE -ne 0) { throw 'Source preparation tests failed' }
        & go test -timeout 120s ./legacy/...
        if ($LASTEXITCODE -ne 0) { throw 'Platform Go tests failed' }
        & go vet ./legacy/...
        if ($LASTEXITCODE -ne 0) { throw 'Platform Go vet failed' }
        $webTests = @(Get-ChildItem -LiteralPath legacy/web -Filter '*.test.cjs' | ForEach-Object { $_.FullName })
        & node --test @webTests
        if ($LASTEXITCODE -ne 0) { throw 'Platform web contract tests failed' }
    }
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    $env:GOARCH = 'amd64'
    $env:GOOS = if ($Target -eq 'Linux') { 'linux' } else { 'windows' }
    $output = if ($Target -eq 'Linux') { 'dist/reach-desk-linux-amd64' } else { 'dist/reach-desk.exe' }
    & go build -trimpath -o $output ./legacy
    if ($LASTEXITCODE -ne 0) { throw 'Platform build failed' }
    Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Path, Hash
} finally {
    $env:HW_CONF = $priorConf
    $env:GOOS = $priorGoos
    $env:GOARCH = $priorGoarch
    $env:CGO_ENABLED = $priorCgo
    Pop-Location
}
