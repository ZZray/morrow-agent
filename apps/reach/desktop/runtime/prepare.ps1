# Copyright (c) Ray Zhang. Reproduce the fixed developer runtime in a disposable checkout.
param(
    [Parameter(Mandatory=$true)][string]$SourceCheckout,
    [Parameter(Mandatory=$true)][string]$Environment,
    [Parameter(Mandatory=$true)][string]$Python
)
$ErrorActionPreference='Stop'
foreach($path in @($SourceCheckout,$Environment,$Python)) {
    if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'Runtime paths must be absolute'}
}
if(-not (Test-Path -LiteralPath $Python -PathType Leaf)){throw 'Explicit Python executable missing'}
$revision=git -C $SourceCheckout rev-parse HEAD
if($LASTEXITCODE -ne 0 -or $revision -ne '94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b'){throw 'Windows-MCP source revision mismatch'}
$dirty=git -C $SourceCheckout status --porcelain
if($LASTEXITCODE -ne 0 -or $dirty){throw 'Use a clean disposable source checkout; preserve existing edits'}
$patch=Join-Path $PSScriptRoot 'windows-mcp.patch'
git -C $SourceCheckout apply --check $patch
if($LASTEXITCODE -ne 0){throw 'Runtime patch does not apply'}
git -C $SourceCheckout apply $patch
if($LASTEXITCODE -ne 0){throw 'Runtime patch failed'}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uv.lock') -Destination (Join-Path $SourceCheckout 'uv.lock')
$oldEnvironment=$env:UV_PROJECT_ENVIRONMENT
try {
    $env:UV_PROJECT_ENVIRONMENT=$Environment
    uv sync --project $SourceCheckout --python $Python --locked --no-dev --no-editable
    if($LASTEXITCODE -ne 0){throw 'Runtime installation failed; source checkout remains patched'}
    & (Join-Path $Environment 'Scripts/python.exe') -I -c 'import importlib.metadata as m; assert m.version("windows-mcp")=="0.8.8+reach.4"; print(m.version("windows-mcp"))'
    if($LASTEXITCODE -ne 0){throw 'Installed runtime verification failed'}
} finally { $env:UV_PROJECT_ENVIRONMENT=$oldEnvironment }
