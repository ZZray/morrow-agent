# Copyright (c) Ray Zhang. Actual installation orchestration, files, locks, atomic writes and HKCU.
# Only platform ACL identity, SCM/processes and Node status are explicit adapters.
param([string]$CasePattern='*')
$ErrorActionPreference='Stop'
foreach($name in @('payload','ownership','maintenance-writes','uninstall-files','uninstall-transaction','uninstall-host','maintenance-entry')){. (Join-Path $PSScriptRoot ("../packaging/windows/$name.ps1"))}
$source=Join-Path $PSScriptRoot '../packaging/windows/install.ps1';$text=[IO.File]::ReadAllText($source)
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors.Message-join'; ')}
foreach($definition in $ast.FindAll({param($a)$a-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([ScriptBlock]::Create($definition.Extent.Text))}
$begin=[regex]::Match($text,'(?m)^    RecoverJournal\r?$').Index
$end=[regex]::Match($text,'(?m)^    exit 0\r?$').Index
if($begin-le0 -or $end-le$begin){throw 'Production orchestration boundary changed'}
$installTail=[ScriptBlock]::Create($text.Substring($begin,$end-$begin))
$realWriteJson=${function:WriteJson};$realStagedWrite=${function:WriteReachStagedFile};$realRegistrationWriter=${function:WriteReachRegistration}
Add-Type -AssemblyName System.IO.Compression
$payloadAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-payload.test.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Bytes','Digest','Fixture','AgentFixture','Zip')){
    $definition=$payloadAst.Find({param($a)$a-is[Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true)
    $definitionText=$definition.Extent.Text
    if($name-ceq'Fixture'){$definitionText=$definitionText.Replace('function Fixture','function PayloadFixture')}
    if($name-ceq'AgentFixture'){$definitionText=$definitionText.Replace('function AgentFixture','function AgentPayloadFixture').Replace('$f=Fixture','$f=PayloadFixture')}
    . ([ScriptBlock]::Create($definitionText))
}
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
 public static void DisableOwned(string expected){if(ServicePath!=expected)throw new Exception("Unowned service");Calls.Add("disable-owned");}
 public static void RemoveOwned(string expected){if(ServicePath!=expected)throw new Exception("Unowned service");Remove();}
}
'@
function Security([bool]$Directory,[bool]$Public){$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($sid);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));return $acl}
function CheckPath([string]$Path,[bool]$Anchor=$false){$item=Get-Item -LiteralPath $Path -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Reparse refused by test host'}}
function Directory([string]$Path,[bool]$Public){$null=[IO.Directory]::CreateDirectory($Path);CheckPath $Path}
function NotifyEnvironment {}
function ReachRegistrySecurity {
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.RegistrySecurity]::new()
    $acl.SetOwner($sid);$acl.AddAccessRule([Security.AccessControl.RegistryAccessRule]::new($sid,'FullControl','ContainerInherit','None','Allow'));return $acl
}
function CheckReachRegistry($Key,[bool]$Anchor=$false){if($null-eq$Key){throw 'Missing test registry key'}}
function CaptureProcess([string[]]$AllowedImages){if(-not[ReachSetupNative]::Running){return $null};$p=[pscustomobject]@{Id=123};$p|Add-Member ScriptMethod Dispose {};return $p}
function ProcessRecord($Process){if($Process){return @{pid=123;startTicks=456;image='fixture'}};return $null}
function WaitRecordedExit($Record){[ReachSetupNative]::Calls.Add('wait-recorded')}
function WaitStopped($Process){[ReachSetupNative]::Calls.Add('wait-stopped');if([ReachSetupNative]::Running){throw 'Service did not stop'}}
function StopService($Process){[ReachSetupNative]::Calls.Add('stop');[ReachSetupNative]::Running=$false}
function StartService{[ReachSetupNative]::Calls.Add('start');[ReachSetupNative]::Running=$true}
function IsRunning{return [ReachSetupNative]::Running}
function Node([string]$Executable,[string]$Operation){
    if($Operation-ceq'maintenance-stop'){[ReachSetupNative]::Running=$false;return @{maintenanceStopRequested=$true;installationId='persisted-node-id';epoch=7}}
    if($script:fault-ceq'status'){$script:fault=$null;throw 'Injected candidate status failure'}
    return @{installationId='persisted-node-id';epoch=7;host=@{pid=123}}
}
function WriteJson([string]$Path,$Value){
    if($script:fault-ceq'before-commit' -and $Path-ceq$journalPath -and $Value.phase-ceq'committed'){$script:fault=$null;throw 'Injected before commit write'}
    if($script:fault-ceq'prepared-catalog' -and $Path-ceq$deploymentPath -and $null-eq$Value.record){$script:fault=$null;throw 'Injected prepared catalog failure'}
    if($script:fault-ceq'uninstall-receipt' -and $Path-ceq(Join-Path $root 'last-uninstall-result.json')){$script:fault=$null;throw 'Injected uninstall receipt failure'}
    if($script:fault -and $script:fault-ceq('before-phase-'+$Value.phase) -and $Path-ceq$journalPath){$script:fault=$null;throw 'Injected uninstall phase failure'}
    & $realWriteJson $Path $Value
}
function WriteReachRegistration($Snapshot){
    if($script:fault-ceq'partial-registration' -and $Snapshot.exists){
        $script:fault=$null
        $key=$uninstallParent.CreateSubKey('RY.Reach')
        try{foreach($value in $Snapshot.values[0..2]){$key.SetValue($value.name,$value.value,[Microsoft.Win32.RegistryValueKind]$value.kind)};$key.Flush()}finally{$key.Dispose()}
        throw 'Injected partial registry publication'
    }
    & $realRegistrationWriter $Snapshot
}
function WriteReachStagedFile([string]$Path,[byte[]]$Bytes){
    if($script:fault-ceq'partial-stage'){$script:fault=$null;& $realStagedWrite $Path $Bytes[0..1];throw 'Injected partial stage write'}
    & $realStagedWrite $Path $Bytes
}
function Assert([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Refused([scriptblock]$Action,[string]$Pattern){$failed=$false;try{&$Action|Out-Null}catch{$failed=$true;Assert ($_.Exception.Message-match$Pattern) $_.Exception.Message};Assert $failed "Expected $Pattern"}
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$evidence=Join-Path $project ('work/install-catalog-'+[Guid]::NewGuid().ToString('N'));Directory $evidence $true
$registryBase='Software\RY\ReachCatalogTests\'+[Guid]::NewGuid().ToString('N');$script:cases=0;$script:fault=$null
function Case([string]$Name,[scriptblock]$Action){if($Name-notlike$CasePattern){return};&$Action;$script:cases++;Write-Output "PASS $Name"}
function Fixture {
    $directory=Join-Path $evidence ([Guid]::NewGuid().ToString('N'));$root=Join-Path $directory 'program';$dataParent=Join-Path $directory 'data';$state=Join-Path $dataParent 'Reach'
    foreach($path in @($root,$dataParent,$state)){Directory $path $false}
    [IO.File]::WriteAllText((Join-Path $state 'node.sqlite'),'original pairing; unknown; outbox')
    [ReachSetupNative]::Remove();[ReachSetupNative]::Running=$false;[ReachSetupNative]::Calls.Clear()
    return @{root=$root;dataParent=$dataParent;state=$state;registry=($registryBase+'\'+[Guid]::NewGuid().ToString('N'))}
}
function RunInstall($Fixture,[string]$Content='MZfirst',[string]$CallerSid='S-1-5-21-1-2-3-1001',[bool]$RecoveryOnly=$false,[byte[]]$ZipBytes=$null,[scriptblock]$Maintenance=$null) {
    $root=$Fixture.root;$dataParent=$Fixture.dataParent;$state=$Fixture.state
    $bin=Join-Path $root 'bin';$versions=Join-Path $root 'versions';$cli=Join-Path $bin 'reach.exe'
    $manifestPath=Join-Path $root 'install.json';$journalPath=Join-Path $root 'install-journal.json';$deploymentPath=Join-Path $root 'deployment.json'
    $externalLock=AcquireMaintenanceLock (Join-Path $dataParent 'Reach.installation.lock');$installLock=AcquireInstallationLock
    $environment=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Fixture.registry)
    $uninstallParent=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Fixture.registry+'\Uninstall')
    $MaintenanceOperation='install';$RecoveryScriptBytes=[Text.Encoding]::UTF8.GetBytes('# fixture recovery script');$EntryDeploymentGeneration=$null
    $payloadStream=$null;$payloadArchive=$null
    try{
        RecoverReachAtomicWrites
        $deployment=if([IO.File]::Exists($deploymentPath)){ReadJson $deploymentPath}else{$null}
        if($null-ne$deployment){AssertReachDeployment $deployment $root $state}
        $BindingOwner=$CallerSid;$CompletePackage=$false;$NodePayload=[Text.Encoding]::UTF8.GetBytes($Content);$Payload=$NodePayload
        $NodeSha=Hash $NodePayload;$PayloadSha=$NodeSha;$Notices=[Text.Encoding]::UTF8.GetBytes('Reach fixture notices')
        if($null-ne$ZipBytes){
            $CompletePackage=$true;$PayloadSha=Hash $ZipBytes;$payloadStream=[IO.MemoryStream]::new($ZipBytes,$false)
            $payloadArchive=[IO.Compression.ZipArchive]::new($payloadStream,[IO.Compression.ZipArchiveMode]::Read,$true);$package=ReadReachPayload $payloadArchive
            $NodePayload=ReadReachEntry $package.entries['reach.exe'] 536870912;$NodeSha=$package.manifest.nodeSha256;$PayloadManifestSha=Hash $package.manifestBytes
        }
        if($null-ne$Maintenance){. $Maintenance}elseif($RecoveryOnly){RecoverJournal}else{. $installTail}
    }finally{if($payloadArchive){$payloadArchive.Dispose()};if($payloadStream){$payloadStream.Dispose()};$uninstallParent.Dispose();$environment.Dispose();$installLock.Dispose();$externalLock.Dispose()}
}
function LegacyEntry($Fixture) {
    # These cases explicitly model an older installer which never published an Apps entry.
    RunInstall $Fixture -Maintenance {
        $entry=GetReachDeploymentEntry $deployment
        $j=@{registration=$entry.registration;recoveryEntry=$entry.recoveryEntry}
        RemoveReachUninstallRegistration $j;RemoveReachUninstallEntry $j
    }
}
function RunUninstall($Fixture){RunInstall $Fixture -Maintenance {$MaintenanceOperation='uninstall';$null=InvokeReachInstalledUninstall}}
function Uninstalled($Fixture){
    $journal=Get-Content -LiteralPath (Join-Path $Fixture.root 'install-journal.json') -Raw|ConvertFrom-Json
    $tombstone=Get-Content -LiteralPath (Join-Path $Fixture.root 'install.json') -Raw|ConvertFrom-Json
    $receipt=Get-Content -LiteralPath (Join-Path $Fixture.root 'last-uninstall-result.json') -Raw|ConvertFrom-Json
    AssertReachUninstallTerminal $journal $tombstone $receipt
    Assert ($journal.phase-ceq'committed' -and $null-eq[ReachSetupNative]::Path()) 'Uninstall not committed'
    Assert (-not(Test-Path -LiteralPath (Join-Path $Fixture.root 'versions')) -and -not(Test-Path -LiteralPath (Join-Path $Fixture.root 'bin'))) 'Program directories remain'
    Assert ([IO.File]::ReadAllText((Join-Path $Fixture.state 'node.sqlite'))-ceq'original pairing; unknown; outbox') 'Uninstall changed ledger'
    Assert (Test-Path -LiteralPath (Join-Path $Fixture.root 'install.lock')) 'Canonical lock was deleted'
    return $tombstone
}
function Installed($Fixture){
    $record=Get-Content -LiteralPath (Join-Path $Fixture.root 'install.json') -Raw|ConvertFrom-Json
    $catalog=Get-Content -LiteralPath (Join-Path $Fixture.root 'deployment.json') -Raw|ConvertFrom-Json
    $journal=Get-Content -LiteralPath (Join-Path $Fixture.root 'install-journal.json') -Raw|ConvertFrom-Json
    Assert ($journal.schema-eq4 -and $journal.phase-ceq'committed' -and $record.deploymentGeneration-ceq$catalog.deploymentGeneration) 'Deployment not committed'
    AssertReachDeployment $catalog $Fixture.root $Fixture.state
    Assert ($catalog.recordSha256-ceq(Hash ([IO.File]::ReadAllBytes((Join-Path $Fixture.root 'install.json'))))) 'Record digest not current'
    Assert ([IO.File]::ReadAllText((Join-Path $Fixture.state 'node.sqlite'))-ceq'original pairing; unknown; outbox') 'Ledger changed'
    return @{record=$record;catalog=$catalog;journal=$journal}
}
try{
    Case 'fresh install publishes catalog and schema4 with actual atomic metadata writes' {
        $f=Fixture;RunInstall $f;$result=Installed $f
        Assert ($result.catalog.groups.Count-eq1 -and $result.catalog.cliOwned -and $result.catalog.installationId-ceq'persisted-node-id') 'Missing ownership or Node identity'
        $files=GetReachOwnedFiles $result.catalog $f.root $f.state
        $null=NewReachDeletionPlan $f.root $files (ReachRetainedMetadata)
    }
    Case 'same package reinstall receives a fresh deployment generation and preserves binding owner' {
        $f=Fixture;RunInstall $f;$first=Installed $f;RunInstall $f 'MZfirst' 'S-1-5-21-9-9-9-1002';$second=Installed $f
        Assert ($first.record.nodePath-ceq$second.record.nodePath -and $first.catalog.deploymentGeneration-cne$second.catalog.deploymentGeneration) 'Same package reused generation'
        Assert ($first.catalog.bindingOwner-ceq$second.catalog.bindingOwner -and $second.catalog.installationId-ceq'persisted-node-id') 'Reinstall changed persistent identity'
    }
    Case 'candidate failure restores old generation while retaining candidate file attribution' {
        $f=Fixture;RunInstall $f;$first=Installed $f;$script:fault='status';Refused {RunInstall $f 'MZcandidate'} 'previous program restored'
        $catalog=Get-Content -LiteralPath (Join-Path $f.root 'deployment.json') -Raw|ConvertFrom-Json
        $record=Get-Content -LiteralPath (Join-Path $f.root 'install.json') -Raw|ConvertFrom-Json
        Assert ($catalog.deploymentGeneration-ceq$first.catalog.deploymentGeneration -and $record.nodePath-ceq$first.record.nodePath -and $catalog.groups.Count-eq2) 'Rollback lost old identity or candidate attribution'
        $null=NewReachDeletionPlan $f.root (GetReachOwnedFiles $catalog $f.root $f.state) (ReachRetainedMetadata)
    }
    Case 'first-install commit interruption retains ledger identity without pretending an active installation' {
        $f=Fixture;$script:fault='before-commit';Refused {RunInstall $f} 'commit status requires checking'
        RunInstall $f 'ignored' 'S-1-5-21-1-2-3-1001' $true
        $catalog=Get-Content -LiteralPath (Join-Path $f.root 'deployment.json') -Raw|ConvertFrom-Json
        Assert ($null-eq$catalog.record -and $catalog.installationId-ceq'persisted-node-id' -and $catalog.groups.Count-eq1) 'First-install rollback discarded created identity or attribution'
        RunInstall $f;$null=Installed $f
    }
    Case 'commit write failure restores old deployment before restarting its service' {
        $f=Fixture;RunInstall $f;$first=Installed $f;$script:fault='before-commit';Refused {RunInstall $f 'MZcandidate'} 'commit status requires checking'
        RunInstall $f 'ignored' 'S-1-5-21-1-2-3-1001' $true
        $catalog=Get-Content -LiteralPath (Join-Path $f.root 'deployment.json') -Raw|ConvertFrom-Json
        Assert ($catalog.deploymentGeneration-ceq$first.catalog.deploymentGeneration -and [ReachSetupNative]::Running -and [ReachSetupNative]::ServicePath-ceq$first.record.servicePath) 'Crash recovery did not restore original deployment'
    }
    Case 'Node-only partial stage remains attributed and next attempt publishes a complete version' {
        $f=Fixture;$script:fault='partial-stage';Refused {RunInstall $f} 'partial stage'
        $before=Get-Content -LiteralPath (Join-Path $f.root 'deployment.json') -Raw|ConvertFrom-Json
        $stage=@($before.groups|Where-Object{$_.kind-ceq'stage'})[0]
        Assert ((Get-Item -LiteralPath (Join-Path $f.root ($stage.directory+'/reach.exe'))).Length-eq2) 'No real partial file was created'
        RunInstall $f;$result=Installed $f
        Assert ($result.catalog.groups.Count-eq2 -and [IO.File]::ReadAllText($result.record.nodePath)-ceq'MZfirst') 'Partial stage blocked retry or final file remained partial'
        $null=NewReachDeletionPlan $f.root (GetReachOwnedFiles $result.catalog $f.root $f.state) (ReachRetainedMetadata)
    }
    Case 'unknown preexisting final bytes are rejected without claiming their directory' {
        $f=Fixture;$digest=Hash ([Text.Encoding]::UTF8.GetBytes('MZfirst'));$folder=Join-Path $f.root ('versions/0.1.0-'+$digest.Substring(0,16));Directory $folder $true
        [IO.File]::WriteAllText((Join-Path $folder 'reach.exe'),'foreign')
        Refused {RunInstall $f} 'different bytes'
        $catalog=Get-Content -LiteralPath (Join-Path $f.root 'deployment.json') -Raw|ConvertFrom-Json
        Assert ($catalog.groups.Count-eq0 -and [IO.File]::ReadAllText((Join-Path $folder 'reach.exe'))-ceq'foreign') 'Foreign version was adopted or modified'
    }
    Case 'changed installed record is refused instead of trusting stale deployment metadata' {
        $f=Fixture;RunInstall $f;$result=Installed $f;$recordPath=Join-Path $f.root 'install.json'
        [IO.File]::AppendAllText($recordPath,' ')
        Refused {RunInstall $f} 'record changed outside'
        Assert ([ReachSetupNative]::Running -and [ReachSetupNative]::ServicePath-ceq$result.record.servicePath) 'Mismatch stopped the active service'
    }
    Case 'additional legacy current and previous import never scans an unrelated version directory' {
        $f=Fixture;RunInstall $f 'MZprevious';$first=Installed $f;RunInstall $f 'MZcurrent';$second=Installed $f
        foreach($record in @($first.record,$second.record)){$record.PSObject.Properties.Remove('deploymentGeneration')}
        [IO.File]::WriteAllText((Join-Path $f.root 'install.json'),($second.record|ConvertTo-Json -Depth 12 -Compress))
        [IO.File]::WriteAllText((Join-Path $f.root 'install-journal.json'),(@{schema=2;operation='install';phase='committed';previous=$first.record;target=$second.record}|ConvertTo-Json -Depth 12 -Compress))
        LegacyEntry $f
        [IO.File]::Delete((Join-Path $f.root 'deployment.json'))
        $unknown=Join-Path $f.root ('versions/0.1.0-'+('f'*64));Directory $unknown $true;[IO.File]::WriteAllText((Join-Path $unknown 'keep.txt'),'unrelated')
        RunInstall $f 'MZcurrent';$result=Installed $f
        Assert ($result.catalog.groups.Count-eq2) 'Legacy import did not preserve exact current/previous attribution'
        Refused {NewReachDeletionPlan $f.root (GetReachOwnedFiles $result.catalog $f.root $f.state) (ReachRetainedMetadata)} 'Unrecognized'
        Assert ([IO.File]::ReadAllText((Join-Path $unknown 'keep.txt'))-ceq'unrelated') 'Unknown version was adopted or altered'
    }
    Case 'additional legacy damaged journal candidate retains attribution without requiring it to run' {
        $f=Fixture;RunInstall $f;$current=Installed $f;$current.record.PSObject.Properties.Remove('deploymentGeneration')
        $sha=Hash ([Text.Encoding]::UTF8.GetBytes('MZintended-candidate'));$candidate=Join-Path $f.root ('versions/0.1.0-'+$sha.Substring(0,16));Directory $candidate $true
        [IO.File]::WriteAllText((Join-Path $candidate 'reach.exe'),'broken');[IO.File]::WriteAllText((Join-Path $candidate 'THIRD_PARTY_NOTICES.txt'),'notices')
        $node=Join-Path $candidate 'reach.exe';$target=@{schema=1;version='0.1.0';nodeStateSchema=1;sha256=$sha;nodePath=$node;bindingOwner=$current.record.bindingOwner
            servicePath=('"'+$node+'" --state-dir "'+$f.state+'" service --binding-owner '+$current.record.bindingOwner)}
        [IO.File]::WriteAllText((Join-Path $f.root 'install.json'),($current.record|ConvertTo-Json -Depth 12 -Compress))
        [IO.File]::WriteAllText((Join-Path $f.root 'install-journal.json'),(@{schema=2;operation='install';phase='rolled_back';previous=$current.record;target=$target}|ConvertTo-Json -Depth 12 -Compress))
        LegacyEntry $f
        [IO.File]::Delete((Join-Path $f.root 'deployment.json'))
        RunInstall $f;$result=Installed $f
        Assert ($result.catalog.groups.Count-eq2 -and [IO.File]::ReadAllText($node)-ceq'broken') 'Damaged journal candidate was lost or silently repaired'
        $null=NewReachDeletionPlan $f.root (GetReachOwnedFiles $result.catalog $f.root $f.state) (ReachRetainedMetadata)
    }
    Case 'additional complete payload installs manifest-owned files and keeps same-package generation distinct' {
        $f=Fixture;$zip=Zip (PayloadFixture)
        RunInstall $f -ZipBytes $zip;$first=Installed $f
        Assert ($first.record.schema-eq2 -and $first.catalog.groups.Count-eq1 -and $first.catalog.groups[0].files.Count-eq9) 'Complete manifest ownership is incomplete'
        RunInstall $f -ZipBytes $zip;$second=Installed $f
        Assert ($first.record.nodePath-ceq$second.record.nodePath -and $first.catalog.deploymentGeneration-cne$second.catalog.deploymentGeneration) 'Complete package reused deployment identity'
        $null=NewReachDeletionPlan $f.root (GetReachOwnedFiles $second.catalog $f.root $f.state) (ReachRetainedMetadata)
    }
    Case 'agent package upgrade owns sidecar and config while retaining the legacy rollback package' {
        $f=Fixture;RunInstall $f -ZipBytes (Zip (PayloadFixture));$legacy=Installed $f
        RunInstall $f -ZipBytes (Zip (AgentPayloadFixture));$current=Installed $f
        Assert ($current.catalog.groups.Count-eq2) 'Legacy rollback package ownership was lost'
        $manifest=ReadReachInstalledPayload (Split-Path $current.record.nodePath) $current.record.payloadManifestSha256
        Assert ($manifest.schema-eq2 -and $manifest.agentBundled) 'Agent package schema was lost during staging'
        $group=@($current.catalog.groups|Where-Object {$_.sourceSha256-ceq$current.record.packageSha256})[0]
        Assert ($group.files.Count-eq11 -and $group.files-contains'agent/morrow-agent-jsonl.exe' -and $group.files-contains'agent-runtime.json') 'Agent files were not attributed to the complete version'
        $null=NewReachDeletionPlan $f.root (GetReachOwnedFiles $current.catalog $f.root $f.state) (ReachRetainedMetadata)
        Assert ([IO.File]::Exists($legacy.record.nodePath)) 'Upgrade deleted the legacy rollback version'
    }
    Case 'additional legacy complete manifests import current and damaged candidate file ownership' {
        $f=Fixture;$zip=Zip (PayloadFixture);RunInstall $f -ZipBytes $zip;$current=Installed $f
        $variant=PayloadFixture;$variant.items['desktop/config.toml']=Bytes 'fixture=variant'
        $entry=@($variant.manifest.files|Where-Object{$_.path-ceq'desktop/config.toml'})[0]
        $entry.bytes=$variant.items['desktop/config.toml'].Length;$entry.sha256=Digest $variant.items['desktop/config.toml']
        $variantZip=Zip $variant;$script:fault='status';Refused {RunInstall $f -ZipBytes $variantZip} 'previous program restored'
        $legacy=Get-Content -LiteralPath (Join-Path $f.root 'install-journal.json') -Raw|ConvertFrom-Json
        $legacy.schema=2;$legacy.PSObject.Properties.Remove('previousDeployment')
        foreach($record in @($current.record,$legacy.previous,$legacy.target)){$record.PSObject.Properties.Remove('deploymentGeneration')}
        $damaged=Join-Path (Split-Path $legacy.target.nodePath) 'desktop/config.toml';[IO.File]::WriteAllText($damaged,'damaged candidate bytes')
        [IO.File]::WriteAllText((Join-Path $f.root 'install.json'),($current.record|ConvertTo-Json -Depth 12 -Compress))
        [IO.File]::WriteAllText((Join-Path $f.root 'install-journal.json'),($legacy|ConvertTo-Json -Depth 12 -Compress))
        LegacyEntry $f
        [IO.File]::Delete((Join-Path $f.root 'deployment.json'))
        RunInstall $f -ZipBytes $zip;$result=Installed $f
        Assert ($result.catalog.groups.Count-eq2 -and @($result.catalog.groups|Where-Object{$_.kind-ceq'complete' -and $_.files.Count-eq9}).Count-eq2) 'Legacy complete manifests were not imported exactly'
        Assert ([IO.File]::ReadAllText($damaged)-ceq'damaged candidate bytes') 'Import ran or repaired damaged historical payload'
        $null=NewReachDeletionPlan $f.root (GetReachOwnedFiles $result.catalog $f.root $f.state) (ReachRetainedMetadata)
    }
    Case 'maintenance real entry install uninstall retry and reinstall preserve identity and ledger' {
        $f=Fixture;RunInstall $f;$first=Installed $f;RunUninstall $f;$null=Uninstalled $f
        RunUninstall $f;$null=Uninstalled $f
        RunInstall $f 'MZfirst' 'S-1-5-21-9-9-9-1002';$second=Installed $f
        Assert ($first.catalog.deploymentGeneration-cne$second.catalog.deploymentGeneration -and $second.catalog.installationId-ceq$first.catalog.installationId -and $second.catalog.bindingOwner-ceq$first.catalog.bindingOwner) 'Reinstall changed persistent identity or reused generation'
        RunInstall $f -Maintenance {Assert (SameReachRegistration (ReadReachRegistration) $deployment.recovery.registration) 'Apps entry does not match new deployment'}
    }
    Case 'maintenance durable prepared handoff recovers before catalog replacement' {
        $f=Fixture;RunInstall $f;RunUninstall $f;$old=Uninstalled $f
        $script:fault='prepared-catalog';Refused {RunInstall $f} 'prepared catalog'
        $j=Get-Content -LiteralPath (Join-Path $f.root 'install-journal.json') -Raw|ConvertFrom-Json
        $d=Get-Content -LiteralPath (Join-Path $f.root 'deployment.json') -Raw|ConvertFrom-Json
        Assert ($j.phase-ceq'prepared' -and $d.deploymentGeneration-ceq$old.deploymentGeneration) 'Fault did not preserve old catalog and new handoff'
        RunInstall $f;$null=Installed $f
    }
    Case 'maintenance prepared reinstall keeps partial stage and rollback keeps tombstone' {
        $f=Fixture;RunInstall $f;RunUninstall $f;$old=Uninstalled $f
        $script:fault='partial-stage';Refused {RunInstall $f 'MZsecond'} 'partial stage'
        $script:fault='status';Refused {RunInstall $f 'MZsecond'} 'previous program restored'
        $d=Get-Content -LiteralPath (Join-Path $f.root 'deployment.json') -Raw|ConvertFrom-Json
        $t=Get-Content -LiteralPath (Join-Path $f.root 'install.json') -Raw|ConvertFrom-Json
        Assert ($null-eq$d.record -and (SameReachJson $t $old) -and $d.groups.Count-eq2) 'Reinstall rollback lost tombstone or attributed stage'
        RunInstall $f 'MZsecond';$null=Installed $f
    }
    Case 'maintenance partial registry publication rolls fresh install back and restores upgrade entry' {
        $f=Fixture;$script:fault='partial-registration';Refused {RunInstall $f} 'previous program restored'
        RunInstall $f -Maintenance {Assert (-not(ReadReachRegistration).exists -and -not(Test-Path -LiteralPath (ReachMaintenanceScriptPath))) 'Failed fresh install left a published entry'}
        RunInstall $f;$before=Installed $f
        $script:fault='partial-registration';Refused {RunInstall $f 'MZupgrade'} 'previous program restored'
        RunInstall $f -Maintenance {Assert (SameReachRegistration (ReadReachRegistration) $before.catalog.recovery.registration) 'Upgrade did not restore original Apps entry'}
    }
    Case 'maintenance registration deletion interruption resumes with loaded recovery script' {
        $f=Fixture;RunInstall $f;$script:fault='before-phase-removing_entry';Refused {RunUninstall $f} 'uninstall phase'
        RunInstall $f -Maintenance {Assert (-not(ReadReachRegistration).exists -and (Test-Path -LiteralPath (ReachMaintenanceScriptPath))) 'Interrupted phase has wrong entry state'}
        RunUninstall $f;$null=Uninstalled $f
    }
    Case 'maintenance recovery script deletion interruption resumes without registration' {
        $f=Fixture;RunInstall $f;$script:fault='before-phase-committing';Refused {RunUninstall $f} 'uninstall phase'
        RunInstall $f -Maintenance {Assert (-not(Test-Path -LiteralPath (ReachMaintenanceScriptPath))) 'Recovery script was not removed'}
        RunUninstall $f;$null=Uninstalled $f
    }
    Case 'maintenance tombstone written before receipt failure is accepted only at commit' {
        $f=Fixture;RunInstall $f;$script:fault='uninstall-receipt';Refused {RunUninstall $f} 'uninstall receipt'
        RunUninstall $f;$null=Uninstalled $f
    }
    Case 'maintenance missing registered script requires exact embedded recovery bytes' {
        $f=Fixture;RunInstall $f
        RunInstall $f -Maintenance {
            [IO.File]::Delete((ReachMaintenanceScriptPath))
            $RecoveryScriptBytes=[Text.Encoding]::UTF8.GetBytes('wrong installer')
            Refused {InvokeReachInstalledUninstall} 'matching Reach installer'
            Assert ([ReachSetupNative]::Running -and (ReadReachRegistration).exists) 'Bad repair changed service or registration'
        }
        RunUninstall $f;$null=Uninstalled $f
    }
    Case 'maintenance stale entry record plan and catalog changes refuse before stopping service' {
        $f=Fixture;RunInstall $f
        RunInstall $f -Maintenance {
            $EntryDeploymentGeneration=[Guid]::NewGuid().ToString()
            Refused {InvokeReachInstalledUninstall} 'older deployment';$EntryDeploymentGeneration=$null
            $j=NewReachInstalledUninstallJournal;$j.programPlan.files=@($j.programPlan.files|Select-Object -Skip 1)
            Refused {AssertReachCurrentDeployment $j} 'file plan differs'
            $j=NewReachInstalledUninstallJournal;[IO.File]::AppendAllText($manifestPath,' ')
            Refused {AssertReachCurrentDeployment $j} 'record changed'
            Assert ([ReachSetupNative]::Running) 'Rejected mutation stopped service'
        }
    }
    Case 'maintenance foreign registration value is preserved and prevents removal' {
        $f=Fixture;RunInstall $f
        RunInstall $f -Maintenance {
            $key=$uninstallParent.OpenSubKey('RY.Reach',$true);try{$key.SetValue('Foreign','keep')}finally{$key.Dispose()}
            Refused {InvokeReachInstalledUninstall} 'matching owned registration'
            Assert ([ReachSetupNative]::Running -and @((ReadReachRegistration).values|Where-Object{$_.name-ceq'Foreign'}).Count-eq1) 'Unrelated registration was modified'
        }
    }
}finally{[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryBase,$false)}
if($script:cases-eq0){throw 'No selected catalog tests were executed'}
Write-Output "RESULT $script:cases passed; production install orchestration + actual files/locks/atomic writes/HKCU; SCM/ACL/Node adapters; evidence=$evidence"
