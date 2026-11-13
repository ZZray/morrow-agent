# Copyright (c) Ray Zhang. Resumable uninstall orchestration; no host effects on load.
# The host owns ACL checks, both maintenance locks, trusted file attribution, SCM,
# registry access and atomic WriteJson. Loading this module grants no ownership.
function AssertReachDeploymentGeneration([string]$Generation) {
    if($Generation-cnotmatch'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'){
        throw 'Invalid deployment generation'
    }
}
function AssertReachUninstallJournal($Journal,[string]$Root) {
    $base=ReachRemovalRoot $Root
    if($Journal.schema-ne3 -or $Journal.operation-cne'uninstall' -or $Journal.root-cne$base -or
        $Journal.phase-notin@('planned','stopping','removing_files','removing_path','removing_registration','removing_entry','committing','committed')){
        throw 'Unsupported uninstall journal'
    }
    AssertReachDeploymentGeneration $Journal.deploymentGeneration
    if($Journal.bindingOwner-cnotmatch'^S-1-[0-9-]+$' -or [string]::IsNullOrEmpty($Journal.installationId) -or
        [string]::IsNullOrEmpty($Journal.servicePath)) {throw 'Invalid uninstall identity'}
    $node=[IO.Path]::GetFullPath($Journal.nodePath)
    if(-not $node.StartsWith($base+'\versions\',[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($node)-cne'reach.exe'){throw 'Uninstall service image escaped installation'}
    $null=AssertReachDeletionPlan $Journal.programPlan $base
    # Canonical synchronization and recovery metadata must survive every attempt.
    foreach($required in @('install.lock','install.json','install-journal.json','deployment.json','last-uninstall-result.json')){
        if($required-cnotin$Journal.programPlan.retainedFiles){throw 'Uninstall plan must retain synchronization and recovery metadata'}
    }
}
function NewReachUninstallJournal($Identity,$ProgramPlan) {
    $journal=@{
        schema=3;operation='uninstall';phase='planned';root=(ReachRemovalRoot $Identity.root)
        deploymentGeneration=$Identity.deploymentGeneration;bindingOwner=$Identity.bindingOwner
        installationId=$Identity.installationId;nodePath=$Identity.nodePath;servicePath=$Identity.servicePath
        programPlan=$ProgramPlan;pathOwnership=$Identity.pathOwnership
        registration=$Identity.registration;recoveryEntry=$Identity.recoveryEntry
        deploymentSha256=$Identity.deploymentSha256;recordSha256=$Identity.recordSha256
        originalProcess=$null;pathResult=$null;startedAt=[DateTime]::UtcNow.ToString('o');completedAt=$null
    }
    AssertReachUninstallJournal $journal $Identity.root
    return $journal
}
function AssertReachUninstallHost($Journal) {
    # The deployment generation changes on reinstall even when package and Node
    # installationId are identical. The host must compare protected live metadata.
    AssertReachCurrentDeployment $Journal
    $actual=GetReachServicePath
    if($null-ne$actual -and $actual-cne$Journal.servicePath){throw 'Service belongs to a different deployment'}
    # While a Windows Apps entry exists its protected script must remain usable.
    # After removal, retry comes from the downloaded Setup or the next installer.
    AssertReachUninstallEntry $Journal
}
function SaveReachUninstallPhase($Journal,[string]$Phase) {
    $previous=$Journal.phase
    $Journal.phase=$Phase
    try{WriteJson (Join-Path $Journal.root 'install-journal.json') $Journal}
    catch{$Journal.phase=$previous;throw}
}
function AssertReachProgramsAbsent($Journal) {
    AssertReachRemovalInventory $Journal.programPlan $Journal.root
    foreach($file in $Journal.programPlan.files){
        $path=ReachRemovalFile $Journal.root $file.path
        if(Test-Path -LiteralPath $path){throw 'Owned program file still exists after uninstall'}
    }
}
function AssertReachUninstallPathResult($Result) {
    if($null-eq$Result -or $Result.changed-isnot[bool] -or
        $Result.disposition-notin@('not_owned','already_restored','removed','retained_ambiguous') -or
        $Result.changed-ne($Result.disposition-ceq'removed')){throw 'Invalid PATH removal outcome'}
}
function AssertReachUninstallTerminal($Journal,$Tombstone,$Receipt) {
    AssertReachUninstallPathResult $Journal.pathResult
    AssertReachUninstallPathResult $Receipt.pathResult
    if($Tombstone.schema-ne3 -or $Tombstone.operation-cne'uninstall' -or $Tombstone.status-cne'uninstalled' -or
        $Tombstone.nodeStateSchema-ne1 -or $Tombstone.deploymentGeneration-cne$Journal.deploymentGeneration -or
        $Tombstone.bindingOwner-cne$Journal.bindingOwner -or $Tombstone.installationId-cne$Journal.installationId -or
        $Receipt.schema-ne1 -or $Receipt.operation-cne'uninstall' -or $Receipt.deploymentGeneration-cne$Journal.deploymentGeneration -or
        $Receipt.installationId-cne$Journal.installationId -or $Receipt.pathResult.disposition-cne$Journal.pathResult.disposition -or
        $Receipt.pathResult.changed-ne$Journal.pathResult.changed -or [string]::IsNullOrEmpty($Journal.completedAt) -or
        $Receipt.time-cne$Journal.completedAt){throw 'Uninstall terminal metadata differs'}
    foreach($field in @('requiresCommittedJournal','programFilesRemoved','serviceRemoved','registrationRemoved','dataRetained','rootMetadataRetained')){
        if($Receipt.$field-isnot[bool] -or -not $Receipt.$field){throw 'Invalid uninstall terminal outcome'}
    }
}
function InvokeReachUninstallTransaction($Journal,[string]$Root) {
    AssertReachUninstallJournal $Journal $Root
    AssertReachUninstallHost $Journal
    while($true){
        switch($Journal.phase){
            'planned' {
                # Durable intent precedes disabling/stopping. No network ACK is
                # required: SCM stop preserves unknown effects and pending outbox.
                SaveReachUninstallPhase $Journal 'stopping'
            }
            'stopping' {
                AssertReachUninstallHost $Journal
                if($null-ne(GetReachServicePath)){
                    DisableReachUninstallService $Journal.servicePath
                    $process=CaptureProcess @($Journal.nodePath)
                    try {
                        # Keep an earlier process identity if SCM already reports
                        # PID 0; STOPPED does not prove that process has exited.
                        if($null-ne$process){
                            $current=ProcessRecord $process
                            if($null-ne$Journal.originalProcess -and
                                ($Journal.originalProcess.pid-ne$current.pid -or $Journal.originalProcess.startTicks-ne$current.startTicks)){
                                WaitRecordedExit $Journal.originalProcess
                            }
                            $Journal.originalProcess=$current
                            SaveReachUninstallPhase $Journal 'stopping'
                        }
                        StopService $process
                    }finally{if($null-ne$process){$process.Dispose()}}
                    WaitRecordedExit $Journal.originalProcess
                    AssertReachUninstallHost $Journal
                    RemoveReachUninstallService $Journal.servicePath
                }
                WaitRecordedExit $Journal.originalProcess
                # DeleteService only marks deletion. The host closes its handles
                # and waits for OpenService to report ERROR_SERVICE_DOES_NOT_EXIST.
                WaitReachServiceAbsent
                if($null-ne(GetReachServicePath)){throw 'Service remains after deletion'}
                SaveReachUninstallPhase $Journal 'removing_files'
            }
            'removing_files' {
                AssertReachUninstallHost $Journal
                if($null-ne(GetReachServicePath)){throw 'Service reappeared before file removal'}
                WaitRecordedExit $Journal.originalProcess
                InvokeReachDeletionPlan $Journal.programPlan $Journal.root
                AssertReachProgramsAbsent $Journal
                SaveReachUninstallPhase $Journal 'removing_path'
            }
            'removing_path' {
                AssertReachUninstallHost $Journal
                if($null-ne(GetReachServicePath)){throw 'Service reappeared before PATH removal'}
                AssertReachProgramsAbsent $Journal
                $Journal.pathResult=RemoveReachOwnedPath $Journal.pathOwnership (Join-Path $Journal.root 'bin')
                AssertReachUninstallPathResult $Journal.pathResult
                SaveReachUninstallPhase $Journal 'removing_registration'
            }
            'removing_registration' {
                AssertReachUninstallHost $Journal
                if($null-ne(GetReachServicePath)){throw 'Service reappeared before registration removal'}
                AssertReachProgramsAbsent $Journal
                AssertReachUninstallPathResult $Journal.pathResult
                # The host checks exact entry ownership before deleting it and
                # verifies absence; an unrelated replacement must be preserved.
                RemoveReachUninstallRegistration $Journal
                AssertReachUninstallRegistrationAbsent $Journal
                SaveReachUninstallPhase $Journal 'removing_entry'
            }
            'removing_entry' {
                AssertReachUninstallHost $Journal
                if($null-ne(GetReachServicePath)){throw 'Service reappeared before recovery entry removal'}
                AssertReachProgramsAbsent $Journal
                AssertReachUninstallPathResult $Journal.pathResult
                AssertReachUninstallRegistrationAbsent $Journal
                RemoveReachUninstallEntry $Journal
                SaveReachUninstallPhase $Journal 'committing'
            }
            'committing' {
                AssertReachUninstallHost $Journal
                if($null-ne(GetReachServicePath)){throw 'Service reappeared before uninstall commit'}
                AssertReachProgramsAbsent $Journal
                AssertReachUninstallRegistrationAbsent $Journal
                AssertReachUninstallEntryAbsent $Journal
                AssertReachUninstallPathResult $Journal.pathResult
                $Journal.completedAt=[DateTime]::UtcNow.ToString('o')
                $tombstone=@{schema=3;operation='uninstall';status='uninstalled';deploymentGeneration=$Journal.deploymentGeneration;bindingOwner=$Journal.bindingOwner;installationId=$Journal.installationId;nodeStateSchema=1}
                WriteJson (Join-Path $Journal.root 'install.json') $tombstone
                WriteJson (Join-Path $Journal.root 'last-uninstall-result.json') @{
                    schema=1;operation='uninstall';requiresCommittedJournal=$true
                    deploymentGeneration=$Journal.deploymentGeneration;installationId=$Journal.installationId
                    programFilesRemoved=$true;serviceRemoved=$true;registrationRemoved=$true
                    pathResult=$Journal.pathResult;dataRetained=$true;rootMetadataRetained=$true;time=$Journal.completedAt
                }
                SaveReachUninstallPhase $Journal 'committed'
            }
            'committed' {
                # A phase in memory is not evidence of a successful durable
                # commit. This also rejects retrying the same object after an
                # interrupted write, even if a caller has changed its phase.
                $saved=ReadJson (Join-Path $Journal.root 'install-journal.json')
                AssertReachUninstallJournal $saved $Root
                if($saved.phase-cne'committed' -or $saved.deploymentGeneration-cne$Journal.deploymentGeneration -or
                    $saved.installationId-cne$Journal.installationId -or $saved.bindingOwner-cne$Journal.bindingOwner){throw 'Uninstall journal is not durably committed'}
                $Journal=$saved
                AssertReachUninstallHost $Journal
                if($null-ne(GetReachServicePath)){throw 'Service reappeared after uninstall'}
                AssertReachProgramsAbsent $Journal
                AssertReachUninstallRegistrationAbsent $Journal
                AssertReachUninstallEntryAbsent $Journal
                # Verify final metadata on retries; do not delete anything again.
                $tombstone=ReadJson (Join-Path $Journal.root 'install.json')
                $receipt=ReadJson (Join-Path $Journal.root 'last-uninstall-result.json')
                AssertReachUninstallTerminal $Journal $tombstone $receipt
                return $receipt
            }
        }
    }
}
