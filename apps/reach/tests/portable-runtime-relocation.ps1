# Copyright (c) Ray Zhang. Exercise a relocated package under a real read/execute-only DACL.
param(
    [Parameter(Mandatory=$true)][string]$Runtime,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$Evidence,
    [Parameter(Mandatory=$true)][string]$BuildPython,
    [string]$DesktopBinary
)
$ErrorActionPreference='Stop'
function DaclBytes([string]$Sddl){
    $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    $bytes=[byte[]]::new($descriptor.DiscretionaryAcl.BinaryLength)
    $descriptor.DiscretionaryAcl.GetBinaryForm($bytes,0)
    return [Convert]::ToHexString($bytes)
}
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$work=Join-Path $project 'work'
$target=[IO.Path]::GetFullPath($Destination)
$evidencePath=[IO.Path]::GetFullPath($Evidence)
foreach($path in @($Runtime,$Destination,$Evidence,$BuildPython)){
    if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'Absolute test paths are required'}
}
foreach($path in @($target,$evidencePath)){
    if(-not $path.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $path)){
        throw 'Use new contained work directories for this test'
    }
}
if($target-notmatch'[^\x00-\x7F]' -or $target-notmatch' '){throw 'Relocation must exercise both Unicode and space characters'}
if($evidencePath.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence must be outside the runtime'}
$source=(Resolve-Path -LiteralPath $Runtime).Path
$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
Copy-Item -LiteralPath $source -Destination $target -Recurse
$original=Get-Acl -LiteralPath $target
$originalAccess=$original.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
if($original.AreAccessRulesProtected -or @($original.Access|Where-Object {-not $_.IsInherited}).Count){throw 'The new relocation directory must start with only inherited access rules'}
[IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($target)) 'original-access.sddl'),$originalAccess)
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$restricted=[Security.AccessControl.DirectorySecurity]::new()
$restricted.SetAccessRuleProtection($true,$false)
$restricted.SetOwner($current)
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation=[Security.AccessControl.PropagationFlags]::None
$allow=[Security.AccessControl.AccessControlType]::Allow
$restricted.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,$propagation,$allow))
$restricted.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$propagation,$allow))
$changed=$false
try {
    Set-Acl -LiteralPath $target -AclObject $restricted
    $changed=$true
    $denied=@()
    foreach($relative in @('python.exe','Lib/site-packages/comtypes/gen/__init__.py')){
        try {
            $stream=[IO.File]::Open((Join-Path $target $relative),[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
            $stream.Dispose()
            throw "Runtime file unexpectedly writable: $relative"
        }catch [UnauthorizedAccessException]{$denied+=$relative}
    }
    try {
        $stream=[IO.File]::Open((Join-Path $target 'Lib/site-packages/comtypes/gen/reach-write-probe.tmp'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
        $stream.Dispose()
        throw 'Runtime directory unexpectedly permits creating files'
    }catch [UnauthorizedAccessException]{$denied+='comtypes/gen/create-file'}
    & $BuildPython -I -B (Join-Path $PSScriptRoot 'portable-runtime.test.py') --root $target --evidence $evidencePath
    if($LASTEXITCODE-ne0){throw 'Relocated, read-only runtime checks failed'}
    if($DesktopBinary){
        $priorBinary=$env:REACH_DESKTOP_BIN;$priorPython=$env:REACH_DESKTOP_PYTHON
        try {
            $env:REACH_DESKTOP_BIN=(Resolve-Path -LiteralPath $DesktopBinary).Path
            $env:REACH_DESKTOP_PYTHON=Join-Path $target 'python.exe'
            Push-Location $project
            try { & node --test --test-concurrency=1 tests/desktop.integration.test.ts; if($LASTEXITCODE-ne0){throw 'Read-only relocated desktop integration failed'} }
            finally { Pop-Location }
        }finally{$env:REACH_DESKTOP_BIN=$priorBinary;$env:REACH_DESKTOP_PYTHON=$priorPython}
        # Validate every original byte again after the real desktop operations.
        & $BuildPython -I -B -c 'import hashlib,json,sys;from pathlib import Path;r=Path(sys.argv[1]);m=json.loads((r/"reach-provenance/files.json").read_text());assert {p.relative_to(r).as_posix() for p in r.rglob("*") if p.is_file()} == {i["path"] for i in m}|{"reach-provenance/files.json"};assert all(hashlib.sha256((r/i["path"]).read_bytes()).hexdigest()==i["sha256"] for i in m);print("Runtime unchanged after actual desktop operations")' $target
        if($LASTEXITCODE-ne0){throw 'Desktop operations changed runtime package'}
    }
}finally{
    if($changed){
        # Reset only the DACL of this newly copied directory. Set-Acl restoration
        # can request SACL privileges unavailable to an ordinary interactive user.
        & icacls $target /reset | Out-Null
        if($LASTEXITCODE-ne0){throw 'Cannot restore relocation directory DACL'}
        $restored=Get-Acl -LiteralPath $target
        $restoredAccess=$restored.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
        # Windows may add SE_DACL_AUTO_INHERITED during recalculation. Compare
        # actual ACE bytes and inheritance protection, rather than that marker.
        if($restored.AreAccessRulesProtected -or (DaclBytes $restoredAccess)-cne(DaclBytes $originalAccess)){throw 'Restored relocation access rules do not match the original'}
    }
}
@{schema=1;runtime=$target;readOnlyAclTested=$true;writeDenied=$denied;desktopTested=[bool]$DesktopBinary;restoredAfterTest=$true}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $evidencePath 'relocation-acl.json') -Encoding utf8
