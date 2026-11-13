# Copyright (c) Ray Zhang. Protected installation inventory; no effects on load.
# Callers hold external then legacy locks and supply checked WriteJson/ReadJson.
function ReachRetainedMetadata {
    $names=@('install.lock','install.json','install-journal.json','deployment.json','last-install-result.json','last-uninstall-result.json')
    return $names
}
function AssertReachGeneration([string]$Generation) {
    if($Generation-cnotmatch'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'){throw 'Invalid deployment generation'}
}
function ReachRecordDirectory($Record,[string]$Root,[string]$State) {
    if($Record.schema-notin@(1,2) -or $Record.version-cne'0.1.0' -or $Record.nodeStateSchema-ne1 -or
        $Record.sha256-cnotmatch'^[0-9a-f]{64}$' -or $Record.bindingOwner-cnotmatch'^S-1-[0-9-]+$'){throw 'Unsupported owned installation record'}
    $key=$Record.sha256.Substring(0,16)
    if($Record.schema-eq2){
        if($Record.packageSha256-cnotmatch'^[0-9a-f]{64}$' -or $Record.payloadManifestSha256-cnotmatch'^[0-9a-f]{64}$' -or
            $Record.desktopBundled-isnot[bool] -or -not $Record.desktopBundled){throw 'Invalid owned complete installation record'}
        $key=$Record.packageSha256
    }
    $relative='versions/0.1.0-'+$key
    $node=Join-Path $Root ($relative+'/reach.exe')
    $service='"'+$node+'" --state-dir "'+$State+'" service --binding-owner '+$Record.bindingOwner
    if($Record.nodePath-cne$node -or $Record.servicePath-cne$service){throw 'Owned record paths differ from canonical installation'}
    return $relative
}
function AssertReachOwnershipGroup($Group) {
    if($Group.kind-notin@('complete','node','stage') -or $Group.sourceSha256-cnotmatch'^[0-9a-f]{64}$' -or
        $Group.files-isnot[array] -or $Group.files.Count-lt1 -or $Group.files.Count-gt20001){throw 'Invalid ownership group'}
    $expected=if($Group.kind-ceq'stage'){'^versions/s-[0-9a-f]{32}$'}elseif($Group.kind-ceq'complete'){'^versions/0\.1\.0-'+$Group.sourceSha256+'$'}else{'^versions/0\.1\.0-'+$Group.sourceSha256.Substring(0,16)+'$'}
    if($Group.directory-cnotmatch$expected){throw 'Ownership directory differs from source identity'}
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($relative in $Group.files){
        [void](ReachRelativePath $relative)
        if(-not $seen.Add($relative)){throw 'Duplicate owned file'}
    }
    foreach($relative in $seen){
        $parts=$relative.Split('/')
        for($i=1;$i-lt$parts.Length;$i++){if($seen.Contains(($parts[0..($i-1)]-join'/'))){throw 'Ownership file and directory conflict'}}
    }
    if(-not $seen.Contains('reach.exe')){throw 'Ownership group has no Node image'}
    if($Group.kind-ceq'complete' -and -not $seen.Contains('payload-manifest.json')){throw 'Complete ownership group has no payload manifest'}
    if($Group.kind-ceq'node' -and ($seen.Count-ne2 -or -not $seen.Contains('THIRD_PARTY_NOTICES.txt'))){throw 'Invalid legacy Node file set'}
}
function NewReachDeployment([string]$Root,[string]$State,[string]$BindingOwner) {
    return @{schema=1;product='Reach';root=$Root;stateRoot=$State;bindingOwner=$BindingOwner;nodeStateSchema=1
        deploymentGeneration=[Guid]::NewGuid().ToString();installationId=$null;record=$null;recordSha256=$null;groups=@();cliOwned=$false;recovery=$null}
}
function SetReachProperty($Object,[string]$Name,$Value) {
    if($Object-is[Collections.IDictionary]){$Object[$Name]=$Value}
    elseif($null-ne$Object.PSObject.Properties[$Name]){$Object.$Name=$Value}
    else{$Object|Add-Member -NotePropertyName $Name -NotePropertyValue $Value}
}
function AssertReachDeployment($Deployment,[string]$Root,[string]$State) {
    if($Deployment.schema-ne1 -or $Deployment.product-cne'Reach' -or $Deployment.root-cne$Root -or $Deployment.stateRoot-cne$State -or
        $Deployment.bindingOwner-cnotmatch'^S-1-[0-9-]+$' -or $Deployment.nodeStateSchema-ne1 -or
        $Deployment.groups-isnot[array] -or $Deployment.cliOwned-isnot[bool]){throw 'Invalid protected deployment catalog'}
    AssertReachGeneration $Deployment.deploymentGeneration
    $directories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($group in $Deployment.groups){AssertReachOwnershipGroup $group;if(-not $directories.Add($group.directory)){throw 'Duplicate ownership directory'}}
    if($null-ne$Deployment.record){
        $directory=ReachRecordDirectory $Deployment.record $Root $State
        if($Deployment.record.bindingOwner-cne$Deployment.bindingOwner -or $Deployment.recordSha256-cnotmatch'^[0-9a-f]{64}$' -or
            -not $directories.Contains($directory) -or -not $Deployment.cliOwned){throw 'Active deployment lacks owned program identity'}
        if($Deployment.record.deploymentGeneration -and $Deployment.record.deploymentGeneration-cne$Deployment.deploymentGeneration){throw 'Active record generation differs from deployment'}
    }elseif($null-ne$Deployment.recordSha256){throw 'Record digest without installed record'}
}
function AddReachOwnershipGroup($Deployment,[string]$Directory,[string]$Kind,[string]$SourceSha256,[string[]]$Files) {
    $next=@{directory=$Directory;kind=$Kind;sourceSha256=$SourceSha256;files=@($Files|Sort-Object)}
    AssertReachOwnershipGroup $next
    $existing=@($Deployment.groups|Where-Object{$_.directory-ieq$Directory})
    if($existing.Count){
        if($existing.Count-ne1 -or $existing[0].directory-cne$Directory -or $existing[0].kind-cne$Kind -or $existing[0].sourceSha256-cne$SourceSha256 -or
            (@($existing[0].files|Sort-Object)-join"`n")-cne($next.files-join"`n")){throw 'Owned version identity changed'}
        return
    }
    $Deployment.groups+=@($next)
}
function GetReachOwnedFiles($Deployment,[string]$Root,[string]$State) {
    AssertReachDeployment $Deployment $Root $State
    $files=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if($Deployment.cliOwned){[void]$files.Add('bin/reach.exe')}
    foreach($group in $Deployment.groups){foreach($relative in $group.files){if(-not $files.Add(($group.directory+'/'+$relative))){throw 'Overlapping owned program files'}}}
    return @($files|Sort-Object)
}
function SaveReachDeployment($Deployment) {
    AssertReachDeployment $Deployment $Deployment.root $Deployment.stateRoot
    WriteJson (Join-Path $Deployment.root 'deployment.json') $Deployment
}
function ImportReachInstalledOwnership($Deployment,$Record) {
    $relative=ReachRecordDirectory $Record $Deployment.root $Deployment.stateRoot
    $directory=Join-Path $Deployment.root $relative
    # Import exact trusted current/previous/journal records, never directory names.
    # Damaged program bytes do not invalidate ownership of the paths declared by
    # an authenticated manifest; current runnable programs are checked separately.
    ValidateManifestIdentity $Record
    if(-not(Test-Path -LiteralPath $directory)){return}
    CheckPath $directory
    if($Record.schema-eq2){
        $manifestPath=Join-Path $directory 'payload-manifest.json';CheckPath $manifestPath
        if((Get-Item -LiteralPath $manifestPath).Length-gt16777216){throw 'Owned payload manifest exceeds the bound'}
        $bytes=[IO.File]::ReadAllBytes($manifestPath)
        if((Hash $bytes)-cne$Record.payloadManifestSha256){throw 'Owned payload manifest identity differs'}
        $manifest=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json
        AssertReachManifestHeader $manifest
        if($manifest.nodeSha256-cne$Record.sha256){throw 'Owned manifest Node identity differs'}
        AddReachOwnershipGroup $Deployment $relative 'complete' $Record.packageSha256 (@($manifest.files|ForEach-Object{$_.path})+@('payload-manifest.json'))
    }else{
        AddReachOwnershipGroup $Deployment $relative 'node' $Record.sha256 @('reach.exe','THIRD_PARTY_NOTICES.txt')
    }
}
function RestoreReachDeploymentIdentity($Deployment,$Previous) {
    # Candidate/stage attribution must survive rollback. Only the active identity
    # returns to its old generation; file ownership is never rolled back blindly.
    if($null-ne$Previous){
        AssertReachDeployment $Previous $Deployment.root $Deployment.stateRoot
        $Deployment.deploymentGeneration=$Previous.deploymentGeneration
        if($Previous.installationId -or -not $Deployment.installationId){$Deployment.installationId=$Previous.installationId}
        $Deployment.record=$Previous.record;$Deployment.recordSha256=$Previous.recordSha256
        SetReachProperty $Deployment 'recovery' $Previous.recovery
        if($null-ne$Previous.record){$Deployment.recordSha256=Hash ([IO.File]::ReadAllBytes((Join-Path $Deployment.root 'install.json')))}
    }else{$Deployment.record=$null;$Deployment.recordSha256=$null;SetReachProperty $Deployment 'recovery' $null}
    SaveReachDeployment $Deployment
}
