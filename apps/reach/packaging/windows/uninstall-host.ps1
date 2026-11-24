# Copyright (c) Ray Zhang. Production binding of the shared uninstall transaction.
# The unified maintenance entry owns trusted paths, both locks and atomic writes.
function ReachNativeError($ErrorRecord) {
    $exception=$ErrorRecord.Exception
    while($null-ne$exception){
        if($exception-is[ComponentModel.Win32Exception]){return $exception.NativeErrorCode}
        $exception=$exception.InnerException
    }
    return $null
}
function GetReachServicePath {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while($true){
        try{return [ReachSetupNative]::Path()}
        catch{
            if((ReachNativeError $_)-ne1072){throw}
            if($timer.Elapsed.TotalSeconds-ge45){throw 'Reach service is still marked for deletion; close external service handles and retry'}
            Start-Sleep -Milliseconds 100
        }
    }
}
function WaitReachServiceAbsent {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while($true){
        try{if($null-eq[ReachSetupNative]::Path()){return}}
        catch{if((ReachNativeError $_)-ne1072){throw}}
        if($timer.Elapsed.TotalSeconds-ge45){throw 'Reach service deletion has not completed'}
        Start-Sleep -Milliseconds 100
    }
}
function DisableReachUninstallService([string]$Expected){[ReachSetupNative]::DisableOwned($Expected)}
function RemoveReachUninstallService([string]$Expected){[ReachSetupNative]::RemoveOwned($Expected)}
function SameReachJson($Left,$Right) {
    if($null-eq$Left -or $null-eq$Right){return $null-eq$Left -and $null-eq$Right}
    $leftObject=$Left-is[Collections.IDictionary] -or $Left-is[pscustomobject]
    $rightObject=$Right-is[Collections.IDictionary] -or $Right-is[pscustomobject]
    if($leftObject -or $rightObject){
        if(-not($leftObject -and $rightObject)){return $false}
        $a=@(if($Left-is[Collections.IDictionary]){$Left.Keys}else{$Left.PSObject.Properties.Name})|Sort-Object
        $b=@(if($Right-is[Collections.IDictionary]){$Right.Keys}else{$Right.PSObject.Properties.Name})|Sort-Object
        if(($a-join"`n")-cne($b-join"`n")){return $false}
        foreach($key in $a){if(-not(SameReachJson $Left.$key $Right.$key)){return $false}}
        return $true
    }
    if($Left-is[array] -or $Right-is[array]){
        if($Left-isnot[array] -or $Right-isnot[array] -or $Left.Count-ne$Right.Count){return $false}
        for($i=0;$i-lt$Left.Count;$i++){if(-not(SameReachJson $Left[$i] $Right[$i])){return $false}}
        return $true
    }
    return (ConvertTo-Json -InputObject $Left -Compress)-ceq(ConvertTo-Json -InputObject $Right -Compress)
}
function AssertReachTombstone($Value,[string]$Generation,[string]$InstallationId,[string]$Owner) {
    if($Value.schema-ne3 -or $Value.operation-cne'uninstall' -or $Value.status-cne'uninstalled' -or
        $Value.deploymentGeneration-cne$Generation -or $Value.installationId-cne$InstallationId -or
        $Value.bindingOwner-cne$Owner -or $Value.nodeStateSchema-ne1){throw 'Uninstalled record does not belong to this deployment'}
}
function AssertReachCurrentDeployment($Journal) {
    CheckPath $deploymentPath
    if($Journal.deploymentSha256-cnotmatch'^[0-9a-f]{64}$' -or
        (Hash ([IO.File]::ReadAllBytes($deploymentPath)))-cne$Journal.deploymentSha256){throw 'Deployment changed since uninstall was planned'}
    $current=ReadJson $deploymentPath;AssertReachDeployment $current $root $state
    if($null-eq$current.record -or $current.deploymentGeneration-cne$Journal.deploymentGeneration -or
        $current.installationId-cne$Journal.installationId -or $current.bindingOwner-cne$Journal.bindingOwner -or
        $current.recordSha256-cne$Journal.recordSha256 -or $current.record.nodePath-cne$Journal.nodePath -or
        $current.record.servicePath-cne$Journal.servicePath -or $Journal.root-cne$root){throw 'Uninstall identity differs from the protected deployment'}
    if(-not(SameReachJson $Journal.pathOwnership $current.record.pathOwnership)){throw 'Uninstall PATH ownership differs from the installed record'}
    $expectedFiles=@(GetReachOwnedFiles $current $root $state)
    $actualFiles=@($Journal.programPlan.files|ForEach-Object{$_.path}|Sort-Object)
    if(($expectedFiles-join"`n")-cne($actualFiles-join"`n") -or
        (@(ReachRetainedMetadata|Sort-Object)-join"`n")-cne(@($Journal.programPlan.retainedFiles|Sort-Object)-join"`n")){
        throw 'Uninstall file plan differs from the protected ownership catalog'
    }
    $expectedEntry=GetReachDeploymentEntry $current
    if(-not(SameReachJson $Journal.registration $expectedEntry.registration) -or -not(SameReachJson $Journal.recoveryEntry $expectedEntry.recoveryEntry)){
        throw 'Uninstall entry differs from the protected deployment'
    }
    CheckPath $manifestPath
    if((Hash ([IO.File]::ReadAllBytes($manifestPath)))-cne$current.recordSha256){
        if($Journal.phase-notin@('committing','committed')){throw 'Installed record changed before uninstall commit'}
        AssertReachTombstone (ReadJson $manifestPath) $Journal.deploymentGeneration $Journal.installationId $Journal.bindingOwner
    }
}
function NewReachInstalledUninstallJournal {
    if($null-eq$deployment -or $null-eq$deployment.record -or [string]::IsNullOrEmpty($deployment.installationId)){throw 'No tracked installed deployment is available for uninstall'}
    AssertReachDeployment $deployment $root $state
    CheckPath $manifestPath
    if((Hash ([IO.File]::ReadAllBytes($manifestPath)))-cne$deployment.recordSha256){throw 'Installed record differs from the protected deployment'}
    $entry=GetReachDeploymentEntry $deployment
    $identity=@{root=$root;deploymentGeneration=$deployment.deploymentGeneration;bindingOwner=$deployment.bindingOwner
        installationId=$deployment.installationId;nodePath=$deployment.record.nodePath;servicePath=$deployment.record.servicePath
        pathOwnership=$deployment.record.pathOwnership;registration=$entry.registration;recoveryEntry=$entry.recoveryEntry
        deploymentSha256=(Hash ([IO.File]::ReadAllBytes($deploymentPath)));recordSha256=$deployment.recordSha256}
    $plan=NewReachDeletionPlan $root (GetReachOwnedFiles $deployment $root $state) (ReachRetainedMetadata)
    return NewReachUninstallJournal $identity $plan
}
function InvokeReachInstalledUninstall {
    if($SetupExecutable -and [IO.Path]::GetFullPath($SetupExecutable).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){
        throw 'Move the downloaded Reach installer outside the installation directory before uninstalling'
    }
    $prior=if([IO.File]::Exists($journalPath)){ReadJson $journalPath}else{$null}
    if($null-ne$prior -and $prior.schema-eq3 -and $prior.operation-ceq'uninstall'){
        $uninstall=$prior
    }else{
        RecoverJournal
        $deployment=if([IO.File]::Exists($deploymentPath)){ReadJson $deploymentPath}else{$null}
        $uninstall=NewReachInstalledUninstallJournal
    }
    if($EntryDeploymentGeneration -and $EntryDeploymentGeneration-cne$uninstall.deploymentGeneration){throw 'This Windows uninstall entry belongs to an older deployment'}
    AssertReachCurrentDeployment $uninstall
    RepairReachRecoveryEntry $uninstall
    AssertReachUninstallHost $uninstall
    if($uninstall.phase-ceq'planned'){WriteJson $journalPath $uninstall}
    return InvokeReachUninstallTransaction $uninstall $root
}
function AssertReachReinstallTerminal($Journal) {
    AssertReachUninstallJournal $Journal $root
    if($Journal.phase-cne'committed'){throw 'Reinstall requires a committed uninstall'}
    AssertReachUninstallHost $Journal
    if($null-ne(GetReachServicePath)){throw 'Service reappeared before reinstall preparation'}
    AssertReachProgramsAbsent $Journal
    AssertReachUninstallRegistrationAbsent $Journal
    AssertReachUninstallEntryAbsent $Journal
    AssertReachUninstallTerminal $Journal (ReadJson $manifestPath) (ReadJson (Join-Path $root 'last-uninstall-result.json'))
}
function NewReachReinstallPreparation($Journal) {
    AssertReachReinstallTerminal $Journal
    $next=NewReachDeployment $root $state $Journal.bindingOwner
    $next.installationId=$Journal.installationId
    # Persist the handoff BEFORE replacing the old catalog or creating any stage.
    return @{schema=4;operation='install';phase='prepared';previous=$null;previousUninstall=$Journal
        previousTombstone=(ReadJson $manifestPath);preparedDeployment=$next;startedAt=[DateTime]::UtcNow.ToString('o')}
}
function CompleteReachReinstallPreparation($Transaction) {
    $next=$Transaction.preparedDeployment
    AssertReachDeployment $next $root $state
    if($null-ne$Transaction.previous -or $null-ne$next.record -or $next.cliOwned -or $next.groups.Count -or $null-ne$next.recovery -or
        $next.bindingOwner-cne$Transaction.previousUninstall.bindingOwner -or $next.installationId-cne$Transaction.previousUninstall.installationId -or
        $next.deploymentGeneration-ceq$Transaction.previousUninstall.deploymentGeneration){throw 'Invalid prepared reinstall identity'}
    if(-not(SameReachJson (ReadJson $manifestPath) $Transaction.previousTombstone)){throw 'Reinstall tombstone changed'}
    AssertReachTombstone $Transaction.previousTombstone $Transaction.previousUninstall.deploymentGeneration $next.installationId $next.bindingOwner
    $current=ReadJson $deploymentPath
    AssertReachDeployment $current $root $state
    if($current.deploymentGeneration-ceq$Transaction.previousUninstall.deploymentGeneration){
        AssertReachReinstallTerminal $Transaction.previousUninstall
        SaveReachDeployment $next
    }elseif($current.deploymentGeneration-ceq$next.deploymentGeneration){
        # Stage attribution may already exist after a failed extraction. Keep it;
        # the old uninstall inventory must never delete the new attempt's files.
        if($null-ne$current.record -or $null-ne$current.recovery -or $current.cliOwned -or
            $current.bindingOwner-cne$next.bindingOwner -or $current.installationId-cne$next.installationId){throw 'Prepared reinstall catalog changed'}
        if($null-ne(GetReachServicePath)){throw 'Service appeared during reinstall preparation'}
        AssertReachUninstallRegistrationAbsent $Transaction.previousUninstall
        AssertReachUninstallEntryAbsent $Transaction.previousUninstall
    }else{throw 'Prepared reinstall belongs to a different deployment'}
}
function RevokeReachManagedSshKeys {
    $intentsPath=Join-Path $state 'ssh-key-intents.json'
    if(-not [IO.File]::Exists($intentsPath)){return}
    CheckPath $intentsPath
    if((Get-Item -LiteralPath $intentsPath -Force).Length-gt1048576){return}
    $store=[IO.File]::ReadAllText($intentsPath,[Text.Encoding]::UTF8)|ConvertFrom-Json
    if($null-eq$store -or $null-eq$store.grants){return}
    $updated=$false
    foreach($grant in @($store.grants)){
        if($grant.state-notin@('authorized','authorizing')){continue}
        try{
            $keyFile=[IO.Path]::GetFullPath([string]$grant.path)
            if([IO.File]::Exists($keyFile)){
                $cursor=$keyFile
                while($cursor){
                    if(Test-Path -LiteralPath $cursor){if(((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)-ne0){throw "Reparse path on SSH cleanup: $cursor"}}
                    $next=[IO.Path]::GetDirectoryName($cursor);if([string]::IsNullOrEmpty($next) -or $next-ceq$cursor){break};$cursor=$next
                }
                $stream=[IO.File]::Open($keyFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
                try{
                    if($stream.Length-gt1048576){throw 'authorized_keys exceeds 1 MiB cleanup bound'}
                    $bytes=[byte[]]::new([int]$stream.Length);[void]$stream.Read($bytes,0,$bytes.Length)
                    $addition=[Text.Encoding]::ASCII.GetBytes(([string]$grant.addedSeparator)+([string]$grant.line)+"`r`n")
                    $offset=[int]$grant.prefixLength;$cutLen=$addition.Length
                    $prefix=[byte[]]::new([Math]::Min($offset,$bytes.Length));[Array]::Copy($bytes,$prefix,$prefix.Length)
                    $exact=($offset-ge0) -and ($offset+$cutLen-le$bytes.Length) -and ((Hash $prefix)-ceq([string]$grant.prefixSha256))
                    if($exact){for($i=0;$i-lt$cutLen;$i++){if($bytes[$offset+$i]-ne$addition[$i]){$exact=$false;break}}}
                    if(-not $exact){
                        $bomLen=if($bytes.Length-ge3 -and $bytes[0]-eq0xEF -and $bytes[1]-eq0xBB -and $bytes[2]-eq0xBF){3}else{0}
                        $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes,$bomLen,$bytes.Length-$bomLen)
                        $m=[regex]::Match($text,'(?m)^'+[regex]::Escape([string]$grant.line)+'(?:\r?\n|$)')
                        if(-not $m.Success){
                            if($text.Contains([string]$grant.marker)){throw "Managed SSH key $($grant.marker) was edited; automatic removal refused"}
                            $grant.state='cleaned';$updated=$true;continue
                        }
                        $offset=$bomLen+[Text.Encoding]::UTF8.GetByteCount($text.Substring(0,$m.Index))
                        $cutLen=[Text.Encoding]::UTF8.GetByteCount($m.Value)
                    }
                    $rem=[byte[]]::new($bytes.Length-$cutLen)
                    [Array]::Copy($bytes,0,$rem,0,$offset)
                    [Array]::Copy($bytes,$offset+$cutLen,$rem,$offset,$bytes.Length-$offset-$cutLen)
                    $stream.Position=0;$stream.Write($rem,0,$rem.Length);$stream.SetLength($rem.Length);$stream.Flush($true)
                }finally{$stream.Dispose()}
            }
            $grant.state='cleaned';$updated=$true
        }catch{
            SetReachProperty $grant 'error' $_.Exception.Message
            $updated=$true
        }
    }
    if($updated){
        $tmp=$intentsPath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
        [IO.File]::WriteAllText($tmp,($store|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($tmp,$intentsPath,[NullString]::Value)
    }
}
