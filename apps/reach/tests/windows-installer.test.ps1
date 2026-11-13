# Copyright (c) Ray Zhang. Ordinary-user transaction tests; no machine service or PATH writes.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
. (Join-Path $PSScriptRoot '../packaging/windows/payload.ps1')
$source=Join-Path $PSScriptRoot '../packaging/windows/install.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors.Message -join '; ')}
$native=$ast.FindAll({param($a) $a -is [Management.Automation.Language.StringConstantExpressionAst] -and $a.Value.StartsWith('using System;')},$true)
Add-Type -TypeDefinition ($native.Value.Replace('class ReachSetupNative','class ReachSetupNativeCompileCheck'))
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class ReachSetupNative {
 public static string ServicePath;
 public static bool Running;
 public static List<string> Calls=new List<string>();
 public static string Path(){return ServicePath;}
 public static void Set(string value){Calls.Add("set");ServicePath=value;}
 public static void Stage(string value){Calls.Add("stage-disabled");ServicePath=value;}
 public static void Remove(){Calls.Add("remove");ServicePath=null;}
}
'@
$names=@('Hash','WriteJson','ReadJson','PathSnapshot','PlanPath','ApplyPath','RestorePath','ValidateManifestIdentity','ValidateManifest','ResumeRestored','MarkRestored','Restore','RecoverJournal','AcquireMaintenanceLock','AcquireInstallationLock')
foreach($name in $names){
    $function=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true)
    if($null-eq$function){throw "Missing production function $name"}
    . ([ScriptBlock]::Create($function.Extent.Text))
}
# Explicit test adapters: production ACL, SCM, UAC and SYSTEM behavior are NOT exercised.
function CheckPath([string]$Path) {if(-not (Test-Path -LiteralPath $Path)){throw "Missing test path $Path"}}
function Security([bool]$Directory,[bool]$Public){
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($sid);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));return $acl
}
function WriteFile([string]$Path,[byte[]]$Bytes,[bool]$Public=$false) {[IO.File]::WriteAllBytes($Path,$Bytes)}
function NotifyEnvironment {}
function CaptureProcess([string[]]$AllowedImages) {[ReachSetupNative]::Calls.Add('capture');return $null}
function StopService($Process) {[ReachSetupNative]::Calls.Add('stop-and-wait');[ReachSetupNative]::Running=$false}
function StartService {[ReachSetupNative]::Calls.Add('start');[ReachSetupNative]::Running=$true}
function IsRunning {return [ReachSetupNative]::Running}
function WaitRecordedExit($record) {[ReachSetupNative]::Calls.Add('wait-recorded')}
function WaitReachServiceAbsent {if($null-ne[ReachSetupNative]::Path()){throw 'Service not absent'}}
function Assert([bool]$Condition,[string]$Message) {if(-not $Condition){throw $Message}}
function Throws([scriptblock]$Action,[string]$Pattern) {
    $failed=$false
    try {& $Action}catch{$failed=$true;Assert ($_.Exception.Message-match$Pattern) "Unexpected error: $($_.Exception.Message)"}
    Assert $failed "Expected failure: $Pattern"
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('reach-installer-'+[Guid]::NewGuid().ToString('N'))
$registryPath='Software\RY\ReachSetupTests\'+[Guid]::NewGuid().ToString('N')
$environment=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
try {
    $null=[IO.Directory]::CreateDirectory($root)
    $versions=Join-Path $root 'versions';$bin=Join-Path $root 'bin';$state=Join-Path $root 'state'
    foreach($directory in @($versions,$bin,$state)){$null=[IO.Directory]::CreateDirectory($directory)}
    $manifestPath=Join-Path $root 'install.json';$journalPath=Join-Path $root 'install-journal.json';$cli=Join-Path $bin 'reach.exe'
    $stateFile=Join-Path $state 'node.sqlite';[IO.File]::WriteAllText($stateFile,'original ledger and candidate receipts')
    function Record([string]$Content) {
        $bytes=[Text.Encoding]::UTF8.GetBytes($Content);$sha=Hash $bytes
        $versionRoot=Join-Path $versions ('0.1.0-'+$sha.Substring(0,16));$null=[IO.Directory]::CreateDirectory($versionRoot)
        $node=Join-Path $versionRoot 'reach.exe';[IO.File]::WriteAllBytes($node,$bytes)
        return @{schema=1;version='0.1.0';nodeStateSchema=1;sha256=$sha;nodePath=$node;bindingOwner='S-1-5-21-1-2-3-1001';servicePath=('"'+$node+'" --state-dir "'+$state+'" service --binding-owner S-1-5-21-1-2-3-1001')}
    }
    $previous=Record 'MZprevious';$next=Record 'MZcandidate'
    function Transaction([string]$Phase='switching') {return @{schema=1;phase=$Phase;previous=$previous;previousRunning=$true;target=$next;pathChange=$null;originalProcess=$null;targetProcess=$null}}
    function CompleteRecord([string]$Variant) {
        $items=@{'reach.exe'='MZsame-node';'desktop/reach-desktop.exe'=('MZhelper-'+$Variant)
            'desktop/python/python.exe'='MZpython';'desktop/python/python314._pth'='.'
            'desktop/config.toml'='fixture=true';'desktop/python/reach-provenance/files.json'='[]'
            'THIRD_PARTY_NOTICES.txt'='notices'
            'desktop-runtime.json'='{"helper":"desktop/reach-desktop.exe","python":"desktop/python/python.exe","config":"desktop/config.toml"}'}
        $manifest=@{schema=1;product='Reach';version='0.1.0';architecture='x86_64-pc-windows-msvc';desktopBundled=$true;files=@()}
        foreach($name in ($items.Keys|Sort-Object)){$bytes=[Text.Encoding]::UTF8.GetBytes($items[$name]);$manifest.files+=@{path=$name;bytes=$bytes.Length;sha256=(Hash $bytes)}}
        $manifest.nodeSha256=Hash ([Text.Encoding]::UTF8.GetBytes($items['reach.exe']))
        $manifest.helperSha256=Hash ([Text.Encoding]::UTF8.GetBytes($items['desktop/reach-desktop.exe']))
        $manifest.runtimeManifestSha256=Hash ([Text.Encoding]::UTF8.GetBytes($items['desktop/python/reach-provenance/files.json']))
        $raw=[Text.Encoding]::UTF8.GetBytes(($manifest|ConvertTo-Json -Depth 8 -Compress));$manifestSha=Hash $raw
        # This fixture models two distinct sealed packages; real ZIP transport is a separate suite.
        $packageSha=Hash ([Text.Encoding]::UTF8.GetBytes(('sealed-fixture-'+$manifestSha)))
        $versionRoot=Join-Path $versions ('0.1.0-'+$packageSha);$null=[IO.Directory]::CreateDirectory($versionRoot)
        foreach($name in $items.Keys){$path=Join-Path $versionRoot $name;$null=[IO.Directory]::CreateDirectory((Split-Path $path));WriteFile $path ([Text.Encoding]::UTF8.GetBytes($items[$name]))}
        WriteFile (Join-Path $versionRoot 'payload-manifest.json') $raw
        $node=Join-Path $versionRoot 'reach.exe'
        return @{schema=2;version='0.1.0';nodeStateSchema=1;sha256=$manifest.nodeSha256;packageSha256=$packageSha;payloadManifestSha256=$manifestSha;desktopBundled=$true;nodePath=$node;bindingOwner='S-1-5-21-1-2-3-1001';servicePath=('"'+$node+'" --state-dir "'+$state+'" service --binding-owner S-1-5-21-1-2-3-1001')}
    }
    $cases=0
    function Case([string]$Name,[scriptblock]$Action) {& $Action;$script:cases++;Write-Output "PASS $Name"}

    Case 'exclusive installation file lock rejects a second owner' {
        $first=AcquireInstallationLock
        try {Throws { $second=AcquireInstallationLock; $second.Dispose() } 'being used|使用|访问|access'}finally{$first.Dispose()}
        $again=AcquireInstallationLock;$again.Dispose()
    }
    Case 'missing PATH is created without empty entry and restored as missing' {
        $change=PlanPath;Assert (-not $change.before.exists) 'PATH should not exist'
        ApplyPath $change;Assert ((PathSnapshot).raw-ceq$bin) 'Unexpected PATH'
        RestorePath $change;Assert (-not (PathSnapshot).exists) 'Missing PATH must remain missing'
    }
    Case 'empty string PATH retains registry kind after rollback' {
        $environment.SetValue('Path','',[Microsoft.Win32.RegistryValueKind]::String)
        $change=PlanPath;ApplyPath $change;RestorePath $change;$value=PathSnapshot
        Assert ($value.exists -and $value.raw-ceq'' -and $value.kind-eq1) 'Empty REG_SZ changed'
    }
    Case 'expanded PATH text and delimiters roundtrip unchanged' {
        $original='%SystemRoot%\System32;;C:\original;'
        $environment.SetValue('Path',$original,[Microsoft.Win32.RegistryValueKind]::ExpandString)
        $change=PlanPath;ApplyPath $change;RestorePath $change;$value=PathSnapshot
        Assert ($value.raw-ceq$original -and $value.kind-eq2) 'Raw expandable PATH changed'
    }
    Case 'existing quoted equivalent PATH is not duplicated' {
        $environment.SetValue('Path',('C:\other;"'+$bin+'\"'),[Microsoft.Win32.RegistryValueKind]::String)
        Assert ($null-eq(PlanPath)) 'Equivalent PATH entry duplicated'
    }
    Case 'PATH concurrent edit before apply is retained' {
        $environment.SetValue('Path','C:\before',[Microsoft.Win32.RegistryValueKind]::String)
        $change=PlanPath;$environment.SetValue('Path','C:\concurrent',[Microsoft.Win32.RegistryValueKind]::String)
        Throws {ApplyPath $change} 'changed during';Assert ((PathSnapshot).raw-ceq'C:\concurrent') 'Concurrent PATH edit lost'
    }
    Case 'PATH rollback preserves ambiguous concurrent edits instead of inferring ownership' {
        $environment.SetValue('Path','C:\before',[Microsoft.Win32.RegistryValueKind]::ExpandString)
        $change=PlanPath;ApplyPath $change
        $environment.SetValue('Path',((PathSnapshot).raw+';C:\later'),[Microsoft.Win32.RegistryValueKind]::String)
        RestorePath $change;$value=PathSnapshot
        Assert ($value.raw-ceq('C:\before;'+$bin+';C:\later') -and $value.kind-eq1) 'Concurrent PATH text or kind lost'
    }
    Case 'unapplied PATH intent cannot remove another writer addition' {
        $environment.SetValue('Path','C:\before',[Microsoft.Win32.RegistryValueKind]::String)
        $change=PlanPath;$environment.SetValue('Path',('C:\concurrent;'+$bin),[Microsoft.Win32.RegistryValueKind]::String)
        Throws {ApplyPath $change} 'changed during';RestorePath $change
        Assert ((PathSnapshot).raw-ceq('C:\concurrent;'+$bin)) 'Unapplied intent removed another writer entry'
    }
    Case 'uncertain maintenance ACK never stops a running original service or switches bytes' {
        $transaction=Transaction 'stopping';[ReachSetupNative]::ServicePath=$previous.servicePath;[ReachSetupNative]::Running=$true;[ReachSetupNative]::Calls.Clear()
        WriteFile $cli ([IO.File]::ReadAllBytes($previous.nodePath));Restore $transaction
        Assert (-not ([ReachSetupNative]::Calls -contains 'stop-and-wait') -and -not ([ReachSetupNative]::Calls -contains 'stage-disabled')) 'Uncertain ACK switched or stopped original service'
        Assert ((Hash ([IO.File]::ReadAllBytes($cli)))-ceq$previous.sha256) 'Original CLI changed'
    }
    Case 'candidate rollback stops and waits before restoring the previous image and running state' {
        $transaction=Transaction;[ReachSetupNative]::ServicePath=$next.servicePath;[ReachSetupNative]::Running=$true;[ReachSetupNative]::Calls.Clear()
        WriteJson $manifestPath $next;WriteFile $cli ([IO.File]::ReadAllBytes($next.nodePath));Restore $transaction
        Assert ([ReachSetupNative]::Calls.IndexOf('stop-and-wait')-lt[ReachSetupNative]::Calls.IndexOf('stage-disabled')) 'Old program configured before candidate stopped'
        Assert ([ReachSetupNative]::ServicePath-ceq$previous.servicePath -and [ReachSetupNative]::Running) 'Old service not restored'
        Assert ((ReadJson $manifestPath).sha256-ceq$previous.sha256) 'Old manifest not restored'
        Assert ((Hash ([IO.File]::ReadAllBytes($cli)))-ceq$previous.sha256) 'Old CLI not restored'
        Assert ([IO.File]::ReadAllText($stateFile)-ceq'original ledger and candidate receipts') 'Database was rolled back'
    }
    Case 'rollback retains an originally stopped service' {
        $transaction=Transaction;$transaction.previousRunning=$false;[ReachSetupNative]::ServicePath=$next.servicePath;[ReachSetupNative]::Running=$true
        Restore $transaction;Assert (-not [ReachSetupNative]::Running) 'Originally stopped service was started'
    }
    Case 'unexpected third party service configuration is never overwritten' {
        [ReachSetupNative]::ServicePath='third-party';[ReachSetupNative]::Calls.Clear()
        Throws {Restore (Transaction)} 'outside this transaction';Assert ([ReachSetupNative]::Calls.Count-eq0) 'Third-party service mutated'
    }
    Case 'first-install rollback removes only candidate registration and leaves state and staged program' {
        $transaction=Transaction;$transaction.previous=$null;$transaction.previousRunning=$false;[ReachSetupNative]::ServicePath=$next.servicePath;[ReachSetupNative]::Running=$true
        WriteJson $manifestPath $next;WriteFile $cli ([IO.File]::ReadAllBytes($next.nodePath));Restore $transaction
        Assert ($null-eq[ReachSetupNative]::ServicePath -and -not [IO.File]::Exists($manifestPath) -and -not [IO.File]::Exists($cli)) 'First-install registration survived rollback'
        Assert ([IO.File]::Exists($stateFile) -and [IO.File]::Exists($next.nodePath)) 'State or staged version deleted'
        Restore $transaction # Retry is idempotent.
    }
    Case 'incomplete journal is recovered once; terminal states do not replay restore' {
        $transaction=Transaction;[ReachSetupNative]::ServicePath=$next.servicePath;[ReachSetupNative]::Running=$true
        WriteJson $journalPath $transaction;RecoverJournal;Assert ((ReadJson $journalPath).phase-eq'recovered') 'Recovery not recorded'
        foreach($phase in @('recovered','rolled_back','committed')){
            $transaction.phase=$phase;WriteJson $journalPath $transaction;[ReachSetupNative]::Calls.Clear();RecoverJournal
            Assert ([ReachSetupNative]::Calls.Count-eq0) "Terminal journal replayed: $phase"
        }
    }
    Case 'crash after restoring old bytes cannot stop the already restarted old service' {
        $transaction=Transaction 'restored';[ReachSetupNative]::ServicePath=$previous.servicePath;[ReachSetupNative]::Running=$true
        WriteJson $journalPath $transaction;[ReachSetupNative]::Calls.Clear();RecoverJournal
        Assert (-not ([ReachSetupNative]::Calls -contains 'stop-and-wait') -and -not ([ReachSetupNative]::Calls -contains 'stage-disabled')) 'Recovery stopped the restored original service again'
        Assert ([ReachSetupNative]::Running -and (ReadJson $journalPath).phase-eq'recovered') 'Restored recovery failed'
    }
    $oldNode=$previous;$newNode=$next
    $completeA=CompleteRecord 'A';$completeB=CompleteRecord 'B'
    Case 'complete versions use whole-package identity even when Node is unchanged' {
        ValidateManifest $completeA;ValidateManifest $completeB
        Assert ($completeA.sha256-ceq$completeB.sha256 -and $completeA.packageSha256-cne$completeB.packageSha256 -and $completeA.nodePath-cne$completeB.nodePath) 'Runtime update reused Node-only identity'
    }
    Case 'schema1 and schema2 rollback combinations preserve ledger and whole previous version' {
        foreach($pair in @(@($oldNode,$completeA),@($completeA,$completeB),@($completeA,$newNode))){
            $previous=$pair[0];$next=$pair[1];$transaction=Transaction;$transaction.schema=2;$transaction.operation='install'
            [ReachSetupNative]::ServicePath=$next.servicePath;[ReachSetupNative]::Running=$true
            WriteJson $manifestPath $next;WriteFile $cli ([IO.File]::ReadAllBytes($next.nodePath));Restore $transaction
            Assert ([ReachSetupNative]::ServicePath-ceq$previous.servicePath) 'Wrong whole-version rollback'
            Assert ((ReadJson $manifestPath).schema-eq$previous.schema) 'Previous schema not restored'
            Assert ([IO.File]::ReadAllText($stateFile)-ceq'original ledger and candidate receipts') 'Ledger overwritten'
        }
    }
    Case 'damaged candidate runtime cannot block recovery of the complete previous version' {
        $previous=$completeA;$next=$completeB;$badPath=Join-Path (Split-Path $next.nodePath) 'desktop/reach-desktop.exe'
        $saved=[IO.File]::ReadAllBytes($badPath);WriteFile $badPath ([byte[]]@(1,2,3))
        try{
            Throws {ValidateManifest $next} 'size mismatch|digest mismatch'
            [ReachSetupNative]::ServicePath=$next.servicePath;[ReachSetupNative]::Running=$true;Restore (Transaction)
            Assert ([ReachSetupNative]::ServicePath-ceq$previous.servicePath -and [ReachSetupNative]::Running) 'Damaged candidate blocked rollback'
        }finally{WriteFile $badPath $saved}
    }
    Case 'damaged previous runtime is never restarted' {
        $previous=$completeA;$next=$completeB;$badPath=Join-Path (Split-Path $previous.nodePath) 'desktop/config.toml'
        $saved=[IO.File]::ReadAllBytes($badPath);WriteFile $badPath ([byte[]]@(1))
        try{[ReachSetupNative]::Calls.Clear();Throws {Restore (Transaction)} 'size mismatch';Assert (-not [ReachSetupNative]::Calls.Contains('start')) 'Damaged previous started'}finally{WriteFile $badPath $saved}
    }
    Case 'unknown schema and foreign full-version path refused' {
        $bad=$completeA.Clone();$bad.schema=3;Throws {ValidateManifest $bad} 'Unsupported'
        $bad=$completeA.Clone();$bad.packageSha256='0'*64;Throws {ValidateManifestIdentity $bad} 'path mismatch'
        $bad=@{schema=2;operation='uninstall';phase='switching'};WriteJson $journalPath $bad;Throws {RecoverJournal} 'Unsupported installation journal'
    }
    Case 'complete version rejects unlisted files and altered manifest bytes' {
        $folder=Split-Path $completeA.nodePath;$extra=Join-Path $folder 'extra.txt';WriteFile $extra ([byte[]]@(1))
        try{Throws {ValidateManifest $completeA} 'file set differs'}finally{[IO.File]::Delete($extra)}
        $file=Join-Path $folder 'payload-manifest.json';$saved=[IO.File]::ReadAllBytes($file);WriteFile $file ([Text.Encoding]::UTF8.GetBytes('{}'))
        try{Throws {ValidateManifest $completeA} 'manifest digest mismatch'}finally{WriteFile $file $saved}
    }
    Case 'schema2 restored journal resumes without stopping already restored service' {
        $previous=$completeA;$next=$completeB;$transaction=Transaction 'restored';$transaction.schema=2;$transaction.operation='install'
        [ReachSetupNative]::ServicePath=$previous.servicePath;[ReachSetupNative]::Running=$true;WriteJson $journalPath $transaction;[ReachSetupNative]::Calls.Clear();RecoverJournal
        Assert (-not [ReachSetupNative]::Calls.Contains('stop-and-wait')) 'Schema2 recovery repeated stop'
    }
    Write-Output "RESULT $cases passed; SCM/UAC/ACL not executed"
} finally {
    $environment.Dispose();[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryPath,$false)
    $resolved=[IO.Path]::GetFullPath($root);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if([IO.Path]::GetDirectoryName($resolved)-ine$parent -or -not [IO.Path]::GetFileName($resolved).StartsWith('reach-installer-')){throw 'Unsafe test cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
