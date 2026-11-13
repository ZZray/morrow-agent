# Copyright (c) Ray Zhang. Real filesystem staging; explicit ordinary-user ACL adapters.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
. (Join-Path $PSScriptRoot '../packaging/windows/payload.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/ownership.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/maintenance-writes.ps1')
# Dot-source the exact function definitions in this scope, preserving their parameters.
foreach($source in @(@((Join-Path $PSScriptRoot '../packaging/windows/install.ps1'),@('Hash','StageCompletePayload')),@((Join-Path $PSScriptRoot 'windows-payload.test.ps1'),@('Bytes','Digest','Fixture','Zip')))){
    $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source[0],[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Production parse failure'}
    foreach($name in $source[1]){$definition=$ast.Find({param($a)$a-is[Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true);. ([ScriptBlock]::Create($definition.Extent.Text))}
}
function CheckPath([string]$Path){$item=Get-Item -LiteralPath $Path -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Test reparse rejected'}}
function Directory([string]$Path,[bool]$Public){$null=[IO.Directory]::CreateDirectory($Path);CheckPath $Path}
function WriteFile([string]$Path,[byte[]]$Bytes,[bool]$Public){[IO.File]::WriteAllBytes($Path,$Bytes)}
function WriteJson([string]$Path,$Value){WriteFile $Path ([Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress)))}
function Security([bool]$Directory,[bool]$Public){$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($sid);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));return $acl}
function Assert([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Refused([scriptblock]$Action,[string]$Pattern){$failed=$false;try{&$Action|Out-Null}catch{$failed=$true;Assert ($_.Exception.Message-match$Pattern) $_.Exception.Message};Assert $failed "Expected $Pattern"}
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $project ('work/stage-'+[Guid]::NewGuid().ToString('N').Substring(0,8));Directory $root $true
$versions=Join-Path $root 'versions';Directory $versions $true
$state=Join-Path $root 'state';$deployment=NewReachDeployment $root $state 'S-1-5-21-1-2-3-1001'
$data=Zip (Fixture);$packageSha=Hash $data;$stream=[IO.MemoryStream]::new($data,$false);$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read,$true)
try{
    $package=ReadReachPayload $zip;$manifestSha=Hash $package.manifestBytes
    $folder=StageCompletePayload $package $packageSha $manifestSha
    Assert ([IO.File]::Exists((Join-Path $folder 'desktop/python/python.exe'))) 'Complete tree not published'
    Assert (@(Get-ChildItem -LiteralPath $versions -Directory).Count-eq1) 'Staging tree remains after publish'
    Write-Output 'PASS fresh complete version atomically published with all bytes'
    $time=(Get-Item -LiteralPath (Join-Path $folder 'reach.exe')).LastWriteTimeUtc
    $again=StageCompletePayload $package $packageSha $manifestSha
    Assert ($again-ceq$folder -and (Get-Item -LiteralPath (Join-Path $folder 'reach.exe')).LastWriteTimeUtc-eq$time) 'Existing version rewritten'
    Write-Output 'PASS identical complete version reused without rewriting'
    $file=Join-Path $folder 'desktop/config.toml';$saved=[IO.File]::ReadAllBytes($file);[IO.File]::WriteAllText($file,'damaged')
    Refused {StageCompletePayload $package $packageSha $manifestSha} 'size mismatch|digest mismatch'
    Assert ([IO.File]::ReadAllText($file)-ceq'damaged') 'Damaged existing version silently overwritten'
    [IO.File]::WriteAllBytes($file,$saved)
    Write-Output 'PASS damaged existing version refused without overwrite'
    $oldVersions=$versions;$versions=Join-Path $versions ('long-'+('x'*120))
    try{Refused {StageCompletePayload $package $packageSha $manifestSha} 'too long';Assert (-not(Test-Path -LiteralPath $versions)) 'Length check wrote partial tree'}finally{$versions=$oldVersions}
    Write-Output 'PASS final and temporary path lengths checked before staging'
    Write-Output "RESULT 4 passed; ordinary filesystem at $versions; production ACL/UAC not executed"
}finally{$zip.Dispose();$stream.Dispose()}
