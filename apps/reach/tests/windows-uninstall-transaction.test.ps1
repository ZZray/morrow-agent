# Copyright (c) Ray Zhang. Real isolated files and HKCU; explicit SCM/ACL adapters.
$ErrorActionPreference='Stop'
foreach($name in @('payload','uninstall-files','uninstall-transaction')){. (Join-Path $PSScriptRoot ("../packaging/windows/$name.ps1"))}
function Assert([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Refused([scriptblock]$Action,[string]$Pattern){$failed=$false;try{&$Action|Out-Null}catch{$failed=$true;Assert ($_.Exception.Message-match$Pattern) $_.Exception.Message};Assert $failed "Expected $Pattern"}
function CheckPath([string]$Path){$item=Get-Item -LiteralPath $Path -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Reparse refused by test host'}}
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidence=Join-Path $project ('work/uninstall-transaction-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($evidence)
$script:cases=0
function Case([string]$Name,[scriptblock]$Action){&$Action;$script:cases++;Write-Output "PASS $Name"}
$registryPath='Software\RY\ReachUninstallTransactionTests\'+[Guid]::NewGuid().ToString('N')
$environment=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
function PathSnapshot {$exists=$environment.GetValueNames()-contains'Path';return @{exists=$exists;kind=$(if($exists){[int]$environment.GetValueKind('Path')}else{2});raw=[string]$environment.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}
function NotifyEnvironment {Boundary 'path-write-notified'}
function Boundary([string]$Name){
    $script:events.Add($Name)
    if($script:fault-ceq$Name){$script:fault=$null;throw "Injected interruption after $Name"}
}
function WriteJson([string]$Path,$Value){
    if([IO.Path]::GetFileName($Path)-ceq'install-journal.json'){Boundary ('before-persist-'+$Value.phase)}
    elseif([IO.Path]::GetFileName($Path)-ceq'install.json' -and $Value.schema-eq3){Boundary 'before-tombstone'}
    elseif([IO.Path]::GetFileName($Path)-ceq'last-uninstall-result.json'){Boundary 'before-receipt'}
    [IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 16 -Compress))
    if([IO.Path]::GetFileName($Path)-ceq'install-journal.json'){Boundary ('persist-'+$Value.phase)}
    elseif([IO.Path]::GetFileName($Path)-ceq'install.json' -and $Value.schema-eq3){Boundary 'tombstone'}
    elseif([IO.Path]::GetFileName($Path)-ceq'last-uninstall-result.json'){Boundary 'receipt'}
}
function ReadJson([string]$Path){CheckPath $Path;return ([IO.File]::ReadAllText($Path)|ConvertFrom-Json)}
function AssertReachCurrentDeployment($Journal){
    $current=ReadJson (Join-Path $Journal.root 'deployment.json')
    if($current.deploymentGeneration-cne$Journal.deploymentGeneration -or $current.installationId-cne$Journal.installationId -or $current.bindingOwner-cne$Journal.bindingOwner){throw 'Stale deployment generation or owner'}
}
function GetReachServicePath{return $script:service.path}
function DisableReachUninstallService([string]$Expected){Assert ($script:service.path-ceq$Expected) 'Foreign service';$script:service.disabled=$true;Boundary 'disable-service'}
function CaptureProcess([string[]]$AllowedImages){
    if(-not $script:service.running){return $null}
    Assert ($script:service.image-cin$AllowedImages) 'Foreign process image'
    $p=[pscustomobject]@{id=$script:service.pid;startTicks=$script:service.startTicks;image=$script:service.image}
    $p|Add-Member ScriptMethod Dispose {$script:events.Add('dispose-process')}
    return $p
}
function ProcessRecord($Process){return @{pid=$Process.id;startTicks=$Process.startTicks;image=$Process.image}}
function StopService($Process){$script:service.running=$false;Boundary 'stop-service'}
function WaitRecordedExit($Record){
    if($null-ne$Record -and $script:service.running -and $Record.pid-eq$script:service.pid -and $Record.startTicks-eq$script:service.startTicks){throw 'Recorded process still active'}
    if($script:exitHeld){throw 'Recorded process exit not settled'}
    Boundary 'wait-recorded-exit'
}
function RemoveReachUninstallService([string]$Expected){
    Assert ($script:service.disabled -and -not $script:service.running -and $script:service.path-ceq$Expected) 'Service was not disabled and settled'
    $script:service.path=$null;Boundary 'delete-service'
}
function WaitReachServiceAbsent{if($script:deletePending){throw 'Service marked for deletion, still present'};Boundary 'service-absent'}
function ReadRegistration{return ([IO.File]::Exists($script:registrationFile))}
function AssertReachUninstallEntry($Journal){
    if(ReadRegistration){
        Assert ([IO.File]::ReadAllText($script:registrationFile)-ceq$Journal.registration) 'Foreign uninstall registration'
        Assert ([IO.File]::Exists($script:entryFile)) 'Registered recovery script missing'
        Assert ((ReachRemovalHash $script:entryFile)-ceq$Journal.recoveryEntry.sha256) 'Registered recovery script changed'
    }
}
function RemoveReachUninstallRegistration($Journal){
    AssertReachUninstallEntry $Journal
    [IO.File]::Delete($script:registrationFile);Boundary 'remove-registration'
}
function AssertReachUninstallRegistrationAbsent($Journal){Assert (-not(ReadRegistration)) 'Uninstall registration remains'}
function RemoveReachUninstallEntry($Journal){
    AssertReachUninstallRegistrationAbsent $Journal
    if([IO.File]::Exists($script:entryFile)){
        Assert ((ReachRemovalHash $script:entryFile)-ceq$Journal.recoveryEntry.sha256) 'Recovery script changed'
        [IO.File]::Delete($script:entryFile)
    }
    Boundary 'remove-entry'
}
function AssertReachUninstallEntryAbsent($Journal){Assert (-not[IO.File]::Exists($script:entryFile)) 'Recovery entry remains'}
function Fixture {
    $script:fault=$null;$script:exitHeld=$false;$script:deletePending=$false
    $script:events=[Collections.Generic.List[string]]::new()
    $directory=Join-Path $evidence ([Guid]::NewGuid().ToString('N'));$root=Join-Path $directory 'program'
    $owned=@('bin/reach.exe','versions/0.1.0-fixture/reach.exe','versions/0.1.0-fixture/desktop/runtime.exe')
    $retained=@('install.lock','install.json','install-journal.json','deployment.json','last-uninstall-result.json')
    foreach($path in $owned){$full=Join-Path $root $path;$null=[IO.Directory]::CreateDirectory((Split-Path $full));[IO.File]::WriteAllText($full,$path)}
    [IO.File]::WriteAllText((Join-Path $root 'install.lock'),'')
    $script:entryFile=Join-Path $directory 'uninstall.ps1';[IO.File]::WriteAllText($script:entryFile,'protected system-PS recovery fixture')
    $script:registrationFile=Join-Path $directory 'registration.json';[IO.File]::WriteAllText($script:registrationFile,'owned-registration')
    $data=Join-Path $directory 'node.sqlite';[IO.File]::WriteAllText($data,'original binding; unknown operation; pending outbox')
    $before=@{exists=$true;raw='%SystemRoot%\System32';kind=2};$after=$before.raw+';'+(Join-Path $root 'bin')
    $environment.SetValue('Path',$after,[Microsoft.Win32.RegistryValueKind]::ExpandString)
    $identity=@{root=$root;deploymentGeneration=[Guid]::NewGuid().ToString();bindingOwner='S-1-5-21-1-2-3-1001';installationId='same-persistent-node-identity'
        nodePath=(Join-Path $root $owned[1]);servicePath=('"'+(Join-Path $root $owned[1])+'" service')
        pathOwnership=@{applied=$true;before=$before;after=$after};registration='owned-registration';recoveryEntry=@{sha256=(ReachRemovalHash $script:entryFile)}}
    WriteJson (Join-Path $root 'deployment.json') $identity
    WriteJson (Join-Path $root 'install.json') @{schema=2;deploymentGeneration=$identity.deploymentGeneration}
    $script:service=@{path=$identity.servicePath;image=$identity.nodePath;running=$true;disabled=$false;pid=123;startTicks=456}
    $journal=NewReachUninstallJournal $identity (NewReachDeletionPlan $root $owned $retained)
    WriteJson (Join-Path $root 'install-journal.json') $journal
    $script:events.Clear()
    return @{root=$root;journal=$journal;data=$data;identity=$identity;owned=$owned}
}
function Resume($Fixture){$saved=ReadJson (Join-Path $Fixture.root 'install-journal.json');return InvokeReachUninstallTransaction $saved $Fixture.root}
function Completed($Fixture){
    $result=Resume $Fixture
    Assert ($result.programFilesRemoved -and $result.serviceRemoved -and $result.dataRetained -and $result.rootMetadataRetained) 'Incomplete terminal receipt'
    Assert ((ReadJson (Join-Path $Fixture.root 'install-journal.json')).phase-ceq'committed') 'Missing commit'
    Assert ([IO.File]::ReadAllText($Fixture.data)-ceq'original binding; unknown operation; pending outbox') 'Persistent data modified'
    Assert ([IO.File]::Exists((Join-Path $Fixture.root 'install.lock'))) 'Canonical lock was removed'
    Assert (-not(Test-Path -LiteralPath (Join-Path $Fixture.root 'versions'))) 'Programs remain'
}
try {
    Case 'offline uninstall stops service and retains unknown/outbox and canonical metadata' {
        $f=Fixture;Completed $f
        Assert ($script:events.IndexOf('stop-service')-lt$script:events.IndexOf('delete-service')) 'Service deletion preceded stop'
        Assert ($script:events.IndexOf('remove-registration')-lt$script:events.IndexOf('remove-entry')) 'Recovery entry removed too early'
        Assert ((PathSnapshot).raw-ceq'%SystemRoot%\System32') 'Owned PATH not restored'
    }
    Case 'already stopped service is never restarted to obtain a network ACK' {
        $f=Fixture;$script:service.running=$false;Completed $f
    }
    foreach($point in @('persist-stopping','disable-service','stop-service','delete-service','service-absent','persist-removing_files','persist-removing_path','path-write-notified','persist-removing_registration','remove-registration','persist-removing_entry','remove-entry','persist-committing','tombstone','receipt','persist-committed',
        'before-persist-stopping','before-persist-removing_files','before-persist-removing_path','before-persist-removing_registration','before-persist-removing_entry','before-persist-committing','before-tombstone','before-receipt','before-persist-committed')){
        Case ("interruption at $point resumes from on-disk journal") {
            $f=Fixture;$script:fault=$point;Refused {Resume $f} 'Injected interruption';Completed $f
        }
    }
    Case 'recorded live process from pre-stop interruption is stopped rather than waited forever' {
        $f=Fixture;$f.journal.phase='stopping';$f.journal.originalProcess=@{pid=123;startTicks=456;image=$f.identity.nodePath}
        WriteJson (Join-Path $f.root 'install-journal.json') $f.journal;Completed $f
    }
    Case 'failed commit cannot succeed from the same in-memory object without durable journal' {
        $f=Fixture;$script:fault='before-persist-committed'
        Refused {InvokeReachUninstallTransaction $f.journal $f.root} 'Injected interruption'
        Assert ($f.journal.phase-ceq'committing') 'Failed commit left in-memory phase committed'
        Assert ((ReadJson (Join-Path $f.root 'install-journal.json')).phase-ceq'committing') 'Fault did not retain previous on-disk phase'
        $f.journal.phase='committed'
        Refused {InvokeReachUninstallTransaction $f.journal $f.root} 'not durably committed'
        Completed $f
    }
    Case 'SCM stopped but process has not exited prevents files and entry removal' {
        $f=Fixture;$script:exitHeld=$true;Refused {Resume $f} 'exit not settled'
        Assert (Test-Path -LiteralPath (Join-Path $f.root $f.owned[0])) 'Program removed before process exit'
        Assert (ReadRegistration) 'Registration removed before process exit';$script:exitHeld=$false;Completed $f
    }
    Case 'DeleteService pending deletion prevents file removal until confirmed absent' {
        $f=Fixture;$script:deletePending=$true;Refused {Resume $f} 'marked for deletion'
        Assert (Test-Path -LiteralPath (Join-Path $f.root $f.owned[0])) 'Program removed before SCM absence'
        $script:deletePending=$false;Completed $f
    }
    Case 'locked program file preserves recovery entry and succeeds after handle release' {
        $f=Fixture;$path=Join-Path $f.root $f.owned[0];$lock=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try{Refused {Resume $f} 'used|使用|访问|access';Assert ((ReadRegistration) -and [IO.File]::Exists($script:entryFile)) 'Recovery lost'}finally{$lock.Dispose()}
        Completed $f
    }
    Case 'changed file or newly introduced unknown content is retained on recovery' {
        $f=Fixture;$path=Join-Path $f.root 'versions/0.1.0-fixture/keep.txt';[IO.File]::WriteAllText($path,'keep')
        Refused {Resume $f} 'Unrecognized'
        Assert ([IO.File]::ReadAllText($path)-ceq'keep' -and (ReadRegistration)) 'Unknown content or recovery entry lost'
    }
    Case 'foreign service or uninstall registration is refused without destructive effects' {
        foreach($foreign in @('service','registration')){
            $f=Fixture
            if($foreign-ceq'service'){$script:service.path='foreign.exe'}else{[IO.File]::WriteAllText($script:registrationFile,'foreign')}
            Refused {Resume $f} 'different deployment|Foreign uninstall'
            Assert (Test-Path -LiteralPath (Join-Path $f.root $f.owned[0])) 'Foreign-resource refusal deleted programs'
        }
    }
    Case 'registered missing or modified recovery script blocks all effects' {
        foreach($missing in @($false,$true)){
            $f=Fixture
            if($missing){[IO.File]::Delete($script:entryFile)}else{[IO.File]::WriteAllText($script:entryFile,'unexpected')}
            Refused {Resume $f} 'Registered recovery script'
            Assert ($script:service.running -and (ReadRegistration)) 'Effects occurred without usable recovery entry'
        }
    }
    Case 'later external PATH changes survive and receipt reports ambiguous retention' {
        $f=Fixture;$environment.SetValue('Path','C:\later;C:\Reach',[Microsoft.Win32.RegistryValueKind]::String)
        Completed $f;$receipt=ReadJson (Join-Path $f.root 'last-uninstall-result.json')
        Assert ($receipt.pathResult.disposition-ceq'retained_ambiguous' -and (PathSnapshot).raw-ceq'C:\later;C:\Reach') 'PATH ambiguity hidden or modified'
    }
    Case 'same-package reinstall with same installationId rejects every stale journal phase' {
        foreach($phase in @('planned','stopping','removing_files','removing_path','removing_registration','removing_entry','committing','committed')){
            $f=Fixture;$f.journal.phase=$phase;WriteJson (Join-Path $f.root 'install-journal.json') $f.journal
            $f.identity.deploymentGeneration=[Guid]::NewGuid().ToString();WriteJson (Join-Path $f.root 'deployment.json') $f.identity
            Refused {Resume $f} 'Stale deployment'
            Assert ($script:service.running -and (ReadRegistration) -and (Test-Path -LiteralPath (Join-Path $f.root $f.owned[0]))) 'Old generation altered new deployment'
        }
    }
    Case 'committed retry verifies terminal state without replaying removal or PATH mutation' {
        $f=Fixture;Completed $f;$script:events.Clear()
        $environment.SetValue('Path','C:\external-after-uninstall',[Microsoft.Win32.RegistryValueKind]::String)
        Completed $f;Assert ($script:events.Count-eq0 -and (PathSnapshot).raw-ceq'C:\external-after-uninstall') 'Committed retry repeated effects'
    }
    Case 'new root content and changed terminal metadata cannot be reported as completed' {
        foreach($mode in @('root-file','receipt-string-bool','receipt-false','receipt-path','receipt-time','tombstone-owner','tombstone-operation')){
            $f=Fixture;Completed $f
            if($mode-ceq'root-file'){
                [IO.File]::WriteAllText((Join-Path $f.root 'keep.txt'),'external')
                Refused {Resume $f} 'Unrecognized'
                Assert ([IO.File]::ReadAllText((Join-Path $f.root 'keep.txt'))-ceq'external') 'External file deleted'
            }else{
                $path=Join-Path $f.root $(if($mode.StartsWith('receipt-')){'last-uninstall-result.json'}else{'install.json'})
                $value=ReadJson $path
                switch($mode){
                    'receipt-string-bool'{$value.serviceRemoved='true'}
                    'receipt-false'{$value.programFilesRemoved=$false}
                    'receipt-path'{$value.pathResult.changed=$false}
                    'receipt-time'{$value.time='different'}
                    'tombstone-owner'{$value.bindingOwner='S-1-5-18'}
                    'tombstone-operation'{$value.operation='install'}
                }
                WriteJson $path $value
                Refused {Resume $f} 'terminal|PATH removal outcome'
            }
        }
    }
    Case 'legacy installer rejects new uninstall journal and tombstone schemas' {
        $f=Fixture;Completed $f
        # Test the shipped install-only writer, not the new uninstall-aware host.
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'fixtures/windows-legacy-install-recovery.ps1'),[ref]$tokens,[ref]$errors)
        foreach($name in @('RecoverJournal','ValidateManifestIdentity')){
            $function=$ast.Find({param($a)$a-is[Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true)
            . ([ScriptBlock]::Create($function.Extent.Text))
        }
        $journalPath=Join-Path $f.root 'install-journal.json'
        Refused {RecoverJournal} 'Unsupported installation journal'
        Refused {ValidateManifestIdentity (ReadJson (Join-Path $f.root 'install.json'))} 'Unsupported existing installation record'
    }
}finally{$environment.Dispose();[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryPath,$false)}
Write-Output "RESULT $script:cases passed; real isolated files/HKCU; SCM, ACL and atomic writes are adapters; evidence=$evidence"
