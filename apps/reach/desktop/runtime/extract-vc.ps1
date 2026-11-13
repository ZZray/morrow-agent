# Copyright (c) Ray Zhang. Extract fixed signed binaries; never run the redistributable installer.
param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$pin=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'vc-runtime-lock.json') -Raw|ConvertFrom-Json
if(Test-Path -LiteralPath $Destination){throw 'Use a new extraction destination'}
if((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()-cne$pin.sourceSha256){throw 'VC source archive mismatch'}
function MicrosoftSignature([string]$File){$signature=Get-AuthenticodeSignature -LiteralPath $File;if($signature.Status-ne'Valid' -or $signature.SignerCertificate.Subject-notmatch'O=Microsoft Corporation'){throw 'Microsoft signature validation failed'}}
MicrosoftSignature $Archive
$target=[IO.Path]::GetFullPath($Destination);$null=[IO.Directory]::CreateDirectory($target)
$cab=Join-Path $target 'payload.cab';$source=[IO.File]::OpenRead($Archive)
try{
    $source.Position=$pin.payloadCabOffset;$bytes=[byte[]]::new($pin.payloadCabBytes);$offset=0
    while($offset-lt$bytes.Length){$count=$source.Read($bytes,$offset,$bytes.Length-$offset);if($count-eq0){throw 'VC source payload truncated'};$offset+=$count}
    if([Text.Encoding]::ASCII.GetString($bytes,0,4)-cne'MSCF'){throw 'VC source cabinet marker missing'}
    [IO.File]::WriteAllBytes($cab,$bytes)
}finally{$source.Dispose()}
$expand=Join-Path $env:SystemRoot 'System32/expand.exe';$payload=Join-Path $target 'payload';$null=[IO.Directory]::CreateDirectory($payload)
foreach($member in @('a4','a5')){& $expand $cab ('-F:'+$member) $payload|Out-Null;if($LASTEXITCODE-ne0){throw 'VC payload expansion failed'}}
$dlls=Join-Path $target 'dlls';$null=[IO.Directory]::CreateDirectory($dlls)
foreach($file in $pin.files){
    & $expand (Join-Path $payload $file.cab) ('-F:'+$file.member) $dlls|Out-Null;if($LASTEXITCODE-ne0){throw 'VC binary extraction failed'}
    $extracted=Join-Path $dlls $file.member
    if((Get-FileHash -LiteralPath $extracted -Algorithm SHA256).Hash.ToLowerInvariant()-cne$file.sha256){throw 'VC extracted binary mismatch'}
    MicrosoftSignature $extracted
    if((Get-Item -LiteralPath $extracted).VersionInfo.FileVersion-cne$pin.version){throw 'VC binary version mismatch'}
    # A checked single file is renamed within this fresh extraction directory.
    Move-Item -LiteralPath $extracted -Destination (Join-Path $dlls $file.name)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'vc-runtime-lock.json') -Destination $target
Write-Output $dlls
