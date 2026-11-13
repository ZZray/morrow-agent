# Copyright (c) Ray Zhang. Windows Apps entry and protected recovery script lifecycle.
function ReachMaintenanceScriptPath {return Join-Path $dataParent 'Reach.maintenance/uninstall.ps1'}
function ReachRegistrySecurity {
    $acl=[Security.AccessControl.RegistrySecurity]::new();$acl.SetOwner($adminSid);$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @($adminSid,$systemSid)){$acl.AddAccessRule([Security.AccessControl.RegistryAccessRule]::new($sid,'FullControl','ContainerInherit','None','Allow'))}
    $acl.AddAccessRule([Security.AccessControl.RegistryAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadKey','ContainerInherit','None','Allow'))
    return $acl
}
function CheckReachRegistry($Key,[bool]$Anchor=$false) {
    $acl=$Key.GetAccessControl();$allowed=@('S-1-5-18','S-1-5-32-544');if($Anchor){$allowed+=@($trustedInstaller)}
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-notin$allowed){throw 'Untrusted uninstall registry owner'}
    if(-not $Anchor -and -not $acl.AreAccessRulesProtected){throw 'Uninstall registry permissions must be protected'}
    # The Windows-owned shared anchor permits child creation (including the
    # standard Terminal Server Users ACE). Each product key is checked below.
    $writes=if($Anchor){[Security.AccessControl.RegistryRights]'ChangePermissions,TakeOwnership'}else{[Security.AccessControl.RegistryRights]'SetValue,CreateSubKey,Delete,ChangePermissions,TakeOwnership'}
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($Anchor -and ($ace.PropagationFlags-band[Security.AccessControl.PropagationFlags]::InheritOnly)-ne0){continue}
        $rights=[long]$ace.RegistryRights
        $genericWrite=($rights-band0x10000000)-ne0 -or (-not $Anchor -and ($rights-band0x40000000)-ne0)
        if($ace.AccessControlType-eq'Allow' -and (($rights-band$writes)-ne0 -or $genericWrite) -and $ace.IdentityReference.Value-notin$allowed){throw 'Untrusted uninstall registry write access'}
    }
}
function OpenReachUninstallRegistry {
    $machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
    try{
        $parent=$machine.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',$true)
        if($null-eq$parent){throw 'Windows uninstall registry parent is missing'}
        try{CheckReachRegistry $parent $true;return $parent}catch{$parent.Dispose();throw}
    }finally{$machine.Dispose()}
}
function ReadReachRegistration {
    $key=$uninstallParent.OpenSubKey('RY.Reach',$false)
    if($null-eq$key){return @{exists=$false;values=@()}}
    try{
        CheckReachRegistry $key
        if($key.GetSubKeyNames().Count){throw 'Unrecognized nested uninstall registration'}
        $values=@()
        foreach($name in ($key.GetValueNames()|Sort-Object)){
            $kind=[int]$key.GetValueKind($name)
            if($kind-notin@(1,4)){throw 'Unrecognized uninstall registry value type'}
            $values+=@{name=$name;kind=$kind;value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
        }
        return @{exists=$true;values=$values}
    }finally{$key.Dispose()}
}
function SameReachRegistration($Left,$Right) {
    if($null-eq$Left -or $null-eq$Right -or $Left.exists-isnot[bool] -or $Right.exists-isnot[bool] -or $Left.exists-ne$Right.exists -or
        $Left.values-isnot[array] -or $Right.values-isnot[array] -or $Left.values.Count-ne$Right.values.Count){return $false}
    $a=@($Left.values|Sort-Object {$_.name});$b=@($Right.values|Sort-Object {$_.name})
    for($i=0;$i-lt$a.Count;$i++){if($a[$i].name-cne$b[$i].name -or $a[$i].kind-ne$b[$i].kind -or $a[$i].value-cne$b[$i].value){return $false}}
    return $true
}
function NewReachUninstallCommand([string]$Generation,[string]$ScriptSha) {
    AssertReachGeneration $Generation
    if($ScriptSha-cnotmatch'^[0-9a-f]{64}$'){throw 'Invalid recovery script digest'}
    $path=(ReachMaintenanceScriptPath).Replace("'","''")
    $inner=@'
$ErrorActionPreference='Stop'
try {
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator token required'}
 $EntryDeploymentGeneration='__GENERATION__';$ShowMaintenanceError=$true
 $bytes=[IO.File]::ReadAllBytes('__PATH__')
 $algorithm=[Security.Cryptography.SHA256]::Create()
 try{$sha=([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose()}
 if($sha-cne'__SHA__'){throw 'Reach recovery script integrity mismatch'}
 & ([ScriptBlock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($bytes)))
 exit 0
}catch{
 [Console]::Error.WriteLine($_.Exception.Message)
 Add-Type -AssemblyName System.Windows.Forms
 [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'Reach uninstall failed')
 exit 2
}
'@
    $inner=$inner.Replace('__GENERATION__',$Generation).Replace('__SHA__',$ScriptSha).Replace('__PATH__',$path)
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $outer=@'
$ErrorActionPreference='Stop'
try {
 $system=[Environment]::SystemDirectory
 $info=[Diagnostics.ProcessStartInfo]::new()
 $info.FileName=[IO.Path]::Combine($system,'WindowsPowerShell\v1.0\powershell.exe')
 $info.Arguments='-NoLogo -NoProfile -NonInteractive -EncodedCommand __INNER__'
 $info.UseShellExecute=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
 if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){$info.Verb='runas'}
 $process=[Diagnostics.Process]::Start($info)
 try{$process.WaitForExit();$result=$process.ExitCode}finally{$process.Dispose()}
 exit $result
}catch{
 [Console]::Error.WriteLine($_.Exception.Message)
 Add-Type -AssemblyName System.Windows.Forms
 [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'Reach uninstall failed')
 exit 2
}
'@
    $outer=$outer.Replace('__INNER__',$encoded)
    $command='"'+(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe')+'" -NoLogo -NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($outer))
    if($command.Length-ge30000){throw 'Windows uninstall command exceeds the process command-line bound'}
    return $command
}
function NewReachRegistration($Record,[string]$ScriptSha) {
    $command=NewReachUninstallCommand $Record.deploymentGeneration $ScriptSha
    $values=@()
    $strings=@{DisplayName='Reach';DisplayVersion=$Record.version;Publisher='Ray Zhang';InstallLocation=$root;DisplayIcon=('"'+$cli+'",0')
        UninstallString=$command;QuietUninstallString=$command;ReachGeneration=$Record.deploymentGeneration;ReachRoot=$root;ReachScriptSha256=$ScriptSha}
    foreach($name in ($strings.Keys|Sort-Object)){$values+=@{name=$name;kind=1;value=[string]$strings[$name]}}
    foreach($name in @('NoModify','NoRepair','ReachSchema')){$values+=@{name=$name;kind=4;value=1}}
    return @{exists=$true;values=@($values|Sort-Object {$_.name})}
}
function GetReachDeploymentEntry($Deployment) {
    if($null-eq$Deployment.recovery){return @{registration=@{exists=$false;values=@()};recoveryEntry=$null}}
    $entry=$Deployment.recovery
    if($entry.generation-cne$Deployment.deploymentGeneration -or $entry.path-cne(ReachMaintenanceScriptPath) -or
        $entry.sha256-cnotmatch'^[0-9a-f]{64}$' -or $entry.registration.exists-isnot[bool] -or -not $entry.registration.exists){throw 'Invalid protected recovery entry'}
    foreach($pair in @(@('ReachRoot',$root),@('ReachGeneration',$Deployment.deploymentGeneration),@('ReachScriptSha256',$entry.sha256))){
        $value=@($entry.registration.values|Where-Object{$_.name-ceq$pair[0]})
        if($value.Count-ne1 -or $value[0].kind-ne1 -or $value[0].value-cne$pair[1]){throw 'Recovery registration identity differs from deployment'}
    }
    return @{registration=$entry.registration;recoveryEntry=@{path=$entry.path;sha256=$entry.sha256;generation=$entry.generation}}
}
function NewReachEntryChange($Previous,$Next,[byte[]]$ScriptBytes) {
    if($null-eq$ScriptBytes -or $ScriptBytes.Length-eq0 -or $ScriptBytes.Length-gt2097152){throw 'Embedded recovery script is missing or too large'}
    $before=GetReachDeploymentEntry $Previous;$actual=ReadReachRegistration
    if(-not(SameReachRegistration $actual $before.registration)){throw 'Uninstall registration differs from the tracked deployment'}
    $path=ReachMaintenanceScriptPath;$directory=Split-Path $path
    if(Test-Path -LiteralPath $directory){
        CheckPath $directory
        foreach($item in (Get-ChildItem -LiteralPath $directory -Force)){if($item.Name-cne'uninstall.ps1' -or $item.PSIsContainer){throw 'Unrecognized recovery directory content'}}
    }
    $beforeBytes=$null
    if($null-ne$before.recoveryEntry){
        CheckPath $path;$beforeBytes=[IO.File]::ReadAllBytes($path)
        if((Hash $beforeBytes)-cne$before.recoveryEntry.sha256){throw 'Previous recovery script differs from its trusted digest'}
    }elseif(Test-Path -LiteralPath $path){throw 'Recovery script has no trusted installation ownership'}
    $sha=Hash $ScriptBytes
    $target=@{path=$path;sha256=$sha;generation=$Next.deploymentGeneration;registration=(NewReachRegistration $Next $sha)}
    return @{before=$before;beforeBytes=$(if($null-ne$beforeBytes){[Convert]::ToBase64String($beforeBytes)}else{$null})
        target=$target;targetBytes=[Convert]::ToBase64String($ScriptBytes)}
}
function AssertReachRegistrationChange($Actual,$Change) {
    $before=$Change.before.registration;$after=$Change.target.registration
    if(-not $Actual.exists){if($before.exists){throw 'Existing uninstall registration disappeared outside this change'};return}
    foreach($value in $Actual.values){
        $allowed=@(@($before.values)+@($after.values)|Where-Object{$_.name-ceq$value.name -and $_.kind-eq$value.kind -and $_.value-ceq$value.value})
        if(-not $allowed.Count){throw 'Uninstall registration contains an unrelated replacement'}
    }
    if($before.exists){foreach($value in $before.values){if(-not @($Actual.values|Where-Object{$_.name-ceq$value.name}).Count){throw 'Existing uninstall registration lost a value outside this change'}}}
}
function WriteReachRegistration($Snapshot) {
    if(-not $Snapshot.exists){$uninstallParent.DeleteSubKey('RY.Reach',$false);$uninstallParent.Flush();return}
    $key=$uninstallParent.CreateSubKey('RY.Reach',[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[Microsoft.Win32.RegistryOptions]::None,(ReachRegistrySecurity))
    try{
        CheckReachRegistry $key
        foreach($value in $Snapshot.values){$key.SetValue($value.name,$value.value,[Microsoft.Win32.RegistryValueKind]$value.kind)}
        foreach($name in $key.GetValueNames()){if($name-cnotin@($Snapshot.values|ForEach-Object{$_.name})){$key.DeleteValue($name,$false)}}
        $key.Flush()
    }finally{$key.Dispose()}
    if(-not(SameReachRegistration (ReadReachRegistration) $Snapshot)){throw 'Uninstall registration publication did not match its intent'}
}
function PublishReachEntry($Change) {
    if($Change.target.path-cne(ReachMaintenanceScriptPath)){throw 'Recovery script path differs from this installation'}
    $bytes=[Convert]::FromBase64String($Change.targetBytes)
    if((Hash $bytes)-cne$Change.target.sha256){throw 'Recovery publication bytes differ from intent'}
    AssertReachRegistrationChange (ReadReachRegistration) $Change
    Directory (Split-Path $Change.target.path) $false
    WriteFile $Change.target.path $bytes
    if((Hash ([IO.File]::ReadAllBytes($Change.target.path)))-cne$Change.target.sha256){throw 'Recovery script publication failed'}
    WriteReachRegistration $Change.target.registration
}
function RestoreReachEntry($Change) {
    if($null-eq$Change){return}
    if($Change.target.path-cne(ReachMaintenanceScriptPath)){throw 'Recovery rollback path differs from this installation'}
    AssertReachRegistrationChange (ReadReachRegistration) $Change
    $path=$Change.target.path
    if(Test-Path -LiteralPath $path){
        CheckPath $path;$sha=Hash ([IO.File]::ReadAllBytes($path))
        if($sha-cne$Change.target.sha256 -and ($null-eq$Change.before.recoveryEntry -or $sha-cne$Change.before.recoveryEntry.sha256)){throw 'Recovery script changed outside this installation'}
    }
    if($null-ne$Change.before.recoveryEntry){
        $bytes=[Convert]::FromBase64String($Change.beforeBytes)
        if((Hash $bytes)-cne$Change.before.recoveryEntry.sha256){throw 'Previous recovery script snapshot changed'}
        Directory (Split-Path $path) $false;WriteFile $path $bytes
        WriteReachRegistration $Change.before.registration
    }else{
        WriteReachRegistration $Change.before.registration
        if(Test-Path -LiteralPath $path){CheckPath $path;[IO.File]::Delete($path)}
        $directory=Split-Path $path
        if(Test-Path -LiteralPath $directory){CheckPath $directory;[IO.Directory]::Delete($directory,$false)}
    }
}
function AssertReachUninstallEntry($Journal) {
    $actual=ReadReachRegistration
    if($actual.exists){
        if(-not(SameReachRegistration $actual $Journal.registration)){throw 'Uninstall registration belongs to a different deployment'}
        if($null-eq$Journal.recoveryEntry){throw 'Uninstall registration has no trusted script'}
        $path=ReachMaintenanceScriptPath;CheckPath (Split-Path $path);CheckPath $path
        if($Journal.recoveryEntry.path-cne$path -or (Hash ([IO.File]::ReadAllBytes($path)))-cne$Journal.recoveryEntry.sha256){throw 'Registered recovery script integrity mismatch'}
    }
}
function RepairReachRecoveryEntry($Journal) {
    $actual=ReadReachRegistration
    if(-not $actual.exists){return}
    if(-not(SameReachRegistration $actual $Journal.registration) -or $null-eq$Journal.recoveryEntry){throw 'Recovery repair has no matching owned registration'}
    $path=ReachMaintenanceScriptPath
    if(Test-Path -LiteralPath $path){return}
    if($null-eq$RecoveryScriptBytes -or (Hash $RecoveryScriptBytes)-cne$Journal.recoveryEntry.sha256){throw 'The registered recovery script is missing; use the matching Reach installer to restore it'}
    Directory (Split-Path $path) $false;WriteFile $path $RecoveryScriptBytes
}
function RemoveReachUninstallRegistration($Journal) {
    AssertReachUninstallEntry $Journal
    WriteReachRegistration @{exists=$false;values=@()}
    AssertReachUninstallRegistrationAbsent $Journal
}
function AssertReachUninstallRegistrationAbsent($Journal){if((ReadReachRegistration).exists){throw 'Uninstall registration remains'}}
function RemoveReachUninstallEntry($Journal) {
    AssertReachUninstallRegistrationAbsent $Journal
    $path=ReachMaintenanceScriptPath
    if(Test-Path -LiteralPath $path){
        CheckPath (Split-Path $path);CheckPath $path
        if($null-eq$Journal.recoveryEntry -or $Journal.recoveryEntry.path-cne$path -or (Hash ([IO.File]::ReadAllBytes($path)))-cne$Journal.recoveryEntry.sha256){throw 'Recovery script removal has no matching ownership'}
        [IO.File]::Delete($path)
    }
    $directory=Split-Path $path
    if(Test-Path -LiteralPath $directory){CheckPath $directory;[IO.Directory]::Delete($directory,$false)}
}
function AssertReachUninstallEntryAbsent($Journal){if(Test-Path -LiteralPath (Split-Path (ReachMaintenanceScriptPath))){throw 'Recovery script directory remains'}}
