# Copyright (c) Ray Zhang. Build a contained runtime from fixed source and hash-locked packages.
param(
    [Parameter(Mandatory=$true)][string]$SourceCheckout,
    [Parameter(Mandatory=$true)][string]$BuildPython,
    [Parameter(Mandatory=$true)][string]$EmbeddedZip,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$BuildDirectory,
    [Parameter(Mandatory=$true)][string]$VCRuntimeDirectory,
    [switch]$Offline
)
$ErrorActionPreference='Stop'
$pin=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'portable-lock.json') -Raw | ConvertFrom-Json
function Hash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function NativeResult([string]$Label){if($LASTEXITCODE-ne0){throw "$Label failed (exit $LASTEXITCODE); candidate remains for inspection"}}
function ApplyContainedPatch([string]$Directory,[string]$Patch){
    # git apply can silently skip paths when this untracked candidate is nested
    # inside the ARA worktree. Stop repository discovery at the candidate parent.
    if($env:GIT_DIR -or $env:GIT_WORK_TREE){throw 'Explicit Git environment is not supported for runtime assembly'}
    $priorCeiling=$env:GIT_CEILING_DIRECTORIES
    try {
        $env:GIT_CEILING_DIRECTORIES=[IO.Path]::GetDirectoryName($Directory)
        & git -C $Directory apply --check --verbose $Patch; NativeResult 'Standalone patch check'
        & git -C $Directory apply --verbose $Patch; NativeResult 'Standalone patch application'
        & git -C $Directory apply --reverse --check $Patch; NativeResult 'Applied patch verification'
    }finally{$env:GIT_CEILING_DIRECTORIES=$priorCeiling}
}
foreach($path in @($SourceCheckout,$BuildPython,$EmbeddedZip,$Destination,$BuildDirectory,$VCRuntimeDirectory)){
    if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'Use explicit absolute build paths'}
}
foreach($path in @($Destination,$BuildDirectory)){
    if(Test-Path -LiteralPath $path){throw "Use a new destination; preserve existing output: $path"}
}
$source=(Resolve-Path -LiteralPath $SourceCheckout).Path
$python=(Resolve-Path -LiteralPath $BuildPython).Path
$zip=(Resolve-Path -LiteralPath $EmbeddedZip).Path
$destination=[IO.Path]::GetFullPath($Destination)
$build=[IO.Path]::GetFullPath($BuildDirectory)
if($destination.StartsWith($build.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $build.StartsWith($destination.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $destination-eq$build){throw 'Build materials and deliverable must be separate directories'}
if((Hash $zip)-cne$pin.pythonSha256){throw 'CPython embedded ZIP digest mismatch'}
if((Hash (Join-Path $PSScriptRoot 'windows-mcp.patch'))-cne$pin.patchSha256 -or (Hash (Join-Path $PSScriptRoot 'uv.lock'))-cne$pin.uvLockSha256){throw 'Runtime recipe changed without updating the pin'}
if((Hash (Join-Path $PSScriptRoot 'vc-runtime-lock.json'))-cne$pin.vcRuntimeLockSha256 -or (Hash (Join-Path $PSScriptRoot 'notices/inputs.json'))-cne$pin.noticesManifestSha256){throw 'Native source pin changed'}
$noticeInputs=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'notices/inputs.json') -Raw|ConvertFrom-Json
foreach($file in $noticeInputs){if((Hash (Join-Path (Join-Path $PSScriptRoot 'notices') $file.path))-cne$file.sha256){throw 'Original notice changed'}}
$revision=git -C $source rev-parse HEAD; NativeResult 'Source revision'
$dirty=git -C $source status --porcelain; NativeResult 'Source status'
if($revision-cne$pin.upstreamRevision -or $dirty){throw 'Windows-MCP source must be the clean fixed upstream revision'}
$version=& $python -I -B -c 'import sys; assert sys.version_info[:3] == (3,14,7); assert sys.maxsize > 2**32; print(sys.version)'; NativeResult 'Build Python identity'
$null=[IO.Directory]::CreateDirectory($build)
$null=[IO.Directory]::CreateDirectory($destination)
$archive=Join-Path $build 'source.zip';$prepared=Join-Path $build 'source';$wheels=Join-Path $build 'wheels'
git -C $source archive --format=zip --output=$archive $pin.upstreamRevision; NativeResult 'Source archive'
Expand-Archive -LiteralPath $archive -DestinationPath $prepared
ApplyContainedPatch $prepared (Join-Path $PSScriptRoot 'windows-mcp.patch')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uv.lock') -Destination (Join-Path $prepared 'uv.lock')
[string[]]$network=@()
if($Offline){$network=@('--offline')}
$priorEpoch=$env:SOURCE_DATE_EPOCH
try {
    $epoch=git -C $source show -s --format=%ct $pin.upstreamRevision; NativeResult 'Source epoch'
    $env:SOURCE_DATE_EPOCH=$epoch
    $requirements=Join-Path $build 'requirements.lock.txt'
    & uv export --project $prepared --python $python --locked --no-dev --no-emit-project --no-header --no-annotate --output-file $requirements --quiet @network; NativeResult 'Hashed dependency export'
    & uv build --project $prepared --python $python --wheel --build-constraint (Join-Path $PSScriptRoot 'build-constraints.txt') --out-dir $wheels @network; NativeResult 'Backend wheel build'
    Expand-Archive -LiteralPath $zip -DestinationPath $destination
    $signature=Get-AuthenticodeSignature (Join-Path $destination 'python.exe')
    if($signature.Status-ne'Valid' -or $signature.SignerCertificate.Subject-notmatch'O=Python Software Foundation'){throw 'Official Python executable signature unavailable or invalid'}
    $site=Join-Path $destination 'Lib/site-packages'
    & uv pip install --python $python --target $site --require-hashes --link-mode copy -r $requirements @network; NativeResult 'Locked distribution install'
    $wheel=Join-Path $wheels ('windows_mcp-'+$pin.backendVersion+'-py3-none-any.whl')
    & uv pip install --python $python --target $site --no-deps --link-mode copy $wheel @network; NativeResult 'Backend wheel install'
    # uv creates developer-interpreter launchers. This package starts with -m;
    # remove only this newly created, checked child directory, never a shared tool.
    $launchers=[IO.Path]::GetFullPath((Join-Path $site 'bin'))
    if([IO.Path]::GetDirectoryName($launchers)-cne[IO.Path]::GetFullPath($site) -or -not $launchers.StartsWith($destination.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Launcher cleanup escaped the candidate'}
    if(Test-Path -LiteralPath $launchers){
        if((Get-Item -LiteralPath $launchers).Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Unexpected launcher reparse point'}
        Remove-Item -LiteralPath $launchers -Recurse -Force
    }
    [IO.File]::WriteAllText((Join-Path $destination 'python314._pth'),"python314.zip`n.`nLib/site-packages`nLib/site-packages/win32`nLib/site-packages/win32/lib`nLib/site-packages/pythonwin`n",[Text.UTF8Encoding]::new($false))
    foreach($dll in @('pythoncom314.dll','pywintypes314.dll')){Copy-Item -LiteralPath (Join-Path $site ('pywin32_system32/'+$dll)) -Destination (Join-Path $destination $dll)}
    $vcPin=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'vc-runtime-lock.json') -Raw|ConvertFrom-Json
    foreach($file in $vcPin.files){
        $original=Join-Path $VCRuntimeDirectory $file.name
        if((Hash $original)-cne$file.sha256){throw 'VC runtime source mismatch'}
        $vcSignature=Get-AuthenticodeSignature -LiteralPath $original
        if($vcSignature.Status-ne'Valid' -or $vcSignature.SignerCertificate.Subject-notmatch'O=Microsoft Corporation'){throw 'VC runtime signature invalid'}
        Copy-Item -LiteralPath $original -Destination (Join-Path $destination $file.name) -Force
    }
    $client=Join-Path $site 'comtypes/client/__init__.py'
    if((Hash $client)-cne$pin.comtypesClientSha256){throw 'comtypes patch source mismatch'}
    ApplyContainedPatch $site (Join-Path $PSScriptRoot 'comtypes-memory.patch')
    $gen=Join-Path $site 'comtypes/gen';$null=[IO.Directory]::CreateDirectory($gen)
    [IO.File]::WriteAllText((Join-Path $gen '__init__.py'),"# Reach: namespace for process-local generated COM wrappers.`n",[Text.UTF8Encoding]::new($false))
    $noticeDir=Join-Path $destination 'reach-provenance';$null=[IO.Directory]::CreateDirectory($noticeDir)
    foreach($file in @('portable-lock.json','vc-runtime-lock.json','build-constraints.txt','windows-mcp.patch','comtypes-memory.patch','uv.lock','config.toml','upstream-LICENSE.md')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $noticeDir}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'notices') -Destination (Join-Path $noticeDir 'notices') -Recurse
    Copy-Item -LiteralPath $requirements -Destination $noticeDir
    $provenance=@{schema=1;revision=$pin.revision;pythonVersion=$pin.pythonVersion;pythonUrl=$pin.pythonUrl;pythonArchiveSha256=$pin.pythonSha256;pythonSigner=$signature.SignerCertificate.Subject;backendSource=$pin.upstreamRevision;backendWheelSha256=(Hash $wheel);sourceDateEpoch=$epoch;buildPython=$version;licenseAuditComplete=$false;runtimeTested=$false}
    $provenance|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $noticeDir 'build.json') -Encoding utf8
    & (Join-Path $destination 'python.exe') -I -B (Join-Path $PSScriptRoot 'inventory-portable.py') $destination $pin.distributions; NativeResult 'Contained runtime inventory'
    Write-Output "Portable runtime candidate: $destination"
}finally{$env:SOURCE_DATE_EPOCH=$priorEpoch}
