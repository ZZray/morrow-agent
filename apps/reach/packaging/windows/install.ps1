# Copyright (c) Ray Zhang. Embedded installer entry. Inputs arrive on the private stdin pipe.
try {
    $ErrorActionPreference = 'Stop'
    if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator token required' }
    if(-not $MaintenanceOperation){$MaintenanceOperation='install'}
    if($MaintenanceOperation-cnotin@('install','uninstall')){throw 'Unsupported maintenance operation'}
    if ($MaintenanceOperation-ceq'install' -and ($BindingOwner -notmatch '^S-1-[0-9-]+$' -or $PayloadSha -notmatch '^[0-9a-f]{64}$')) { throw 'Invalid embedded installation inputs' }
    function Hash([byte[]]$Bytes) { $algorithm=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() } }
    if ($MaintenanceOperation-ceq'install' -and (Hash $Payload) -ne $PayloadSha) { throw 'Embedded payload hash mismatch' }
    $package=$null;$payloadArchive=$null;$payloadStream=$null
    if($MaintenanceOperation-ceq'install' -and $CompletePackage){
        Add-Type -AssemblyName System.IO.Compression
        $payloadStream=[IO.MemoryStream]::new($Payload,$false)
        $payloadArchive=[IO.Compression.ZipArchive]::new($payloadStream,[IO.Compression.ZipArchiveMode]::Read,$true)
        $package=ReadReachPayload $payloadArchive
        if((Get-Variable ExpectedAgentSha -ErrorAction SilentlyContinue) -and $ExpectedAgentSha){
            if($ExpectedAgentSha-cnotmatch'^[0-9a-f]{64}$' -or $package.manifest.schema-ne2 -or $package.manifest.agentBundled-ne$true -or $package.manifest.agentSha256-cne$ExpectedAgentSha){throw 'Embedded Agent package identity mismatch'}
        }
        $NodeSha=$package.manifest.nodeSha256
        $NodePayload=ReadReachEntry $package.entries['reach.exe'] 536870912
        $PayloadManifestSha=Hash $package.manifestBytes
        if($PayloadManifestSha-cne$ExpectedManifestSha){throw 'Embedded manifest identity mismatch'}
    }elseif($MaintenanceOperation-ceq'install'){$NodeSha=$PayloadSha;$NodePayload=$Payload}
    $adminSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $systemSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $trustedInstaller='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    function Security([bool]$Directory,[bool]$Public) {
        $acl=if($Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
        $acl.SetOwner($adminSid);$acl.SetAccessRuleProtection($true,$false)
        $inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
        foreach($sid in @($adminSid,$systemSid)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow')) }
        if($Public){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute',$inherit,'None','Allow'))}
        return $acl
    }
    function CheckPath([string]$Path,[bool]$Anchor=$false) {
        $item=Get-Item -LiteralPath $Path -Force
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne0){throw "Reparse path refused: $Path"}
        $acl=if($item.PSIsContainer){[IO.Directory]::GetAccessControl($Path)}else{[IO.File]::GetAccessControl($Path)}
        $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        $allowed=@('S-1-5-18','S-1-5-32-544');if($Anchor){$allowed+=@($trustedInstaller)}
        if($owner -notin $allowed){throw "Untrusted Windows owner: $Path"}
        $writes=if($Anchor){[Security.AccessControl.FileSystemRights]'Delete,ChangePermissions,TakeOwnership,DeleteSubdirectoriesAndFiles'}else{[Security.AccessControl.FileSystemRights]'Write,Delete,ChangePermissions,TakeOwnership,DeleteSubdirectoriesAndFiles'}
        foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
            # ProgramData allows child creation. Inherit-only ACEs do not confer
            # rights on this anchor; every product child is checked separately.
            if($Anchor -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)-ne0){continue}
            if($ace.AccessControlType -eq 'Allow' -and ($ace.FileSystemRights -band $writes)-ne0 -and $ace.IdentityReference.Value -notin $allowed){throw "Untrusted write access: $Path"}
        }
    }
    function Directory([string]$Path,[bool]$Public) {
        if(-not [IO.Directory]::Exists($Path)){[IO.Directory]::CreateDirectory($Path,(Security $true $Public))|Out-Null}
        CheckPath $Path
    }
    function CheckAnchor([string]$Path) {
        $current=$Path
        while($current){
            CheckPath $current $true
            $parent=[IO.Directory]::GetParent($current)
            $current=if($parent){$parent.FullName}else{$null}
        }
    }
    function WriteFile([string]$Path,[byte[]]$Bytes,[bool]$Public=$false) {
        WriteReachAtomicFile $Path $Bytes $Public
    }
    function WriteJson([string]$Path,$Value) { WriteFile $Path ([Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 20 -Compress))) }
    function ReadJson([string]$Path) {CheckPath $Path; return ([IO.File]::ReadAllText($Path)|ConvertFrom-Json)}
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class ReachSetupNative {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateService(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string path,string group,IntPtr tag,string dependencies,string account,string password);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ChangeServiceConfig(IntPtr service,uint type,uint start,uint error,string path,string group,IntPtr tag,string dependencies,string account,string password,string display);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ChangeServiceConfig2(IntPtr service,uint level,ref int info);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceConfigW(IntPtr service,IntPtr info,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CloseServiceHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool DeleteService(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr service,int level,out Status status,uint size,out uint needed);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window,uint message,IntPtr wparam,string lparam,uint flags,uint timeout,out IntPtr result);
 [StructLayout(LayoutKind.Sequential)] struct Config {public uint type,start,error; public IntPtr path,group;public uint tag;public IntPtr dependencies,account,display;}
 [StructLayout(LayoutKind.Sequential)] struct Status {public uint type,state,accepted,win32,code,checkpoint,hint,pid,flags;}
 static void Check(bool value){if(!value)throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static string Path(){IntPtr m=OpenSCManager(null,null,1);Check(m!=IntPtr.Zero);try{IntPtr s=OpenService(m,"RYReach",1);if(s==IntPtr.Zero){if(Marshal.GetLastWin32Error()==1060)return null;throw new Win32Exception();}try{uint n;QueryServiceConfigW(s,IntPtr.Zero,0,out n);IntPtr p=Marshal.AllocHGlobal((int)n);try{Check(QueryServiceConfigW(s,p,n,out n));Config c=(Config)Marshal.PtrToStructure(p,typeof(Config));return Marshal.PtrToStringUni(c.path);}finally{Marshal.FreeHGlobal(p);}}finally{CloseServiceHandle(s);}}finally{CloseServiceHandle(m);}}
 public static void Set(string path){Configure(path,2);}
 public static void Stage(string path){Configure(path,4);}
 static void Configure(string path,uint start){IntPtr m=OpenSCManager(null,null,3);Check(m!=IntPtr.Zero);try{IntPtr s=OpenService(m,"RYReach",0xF01FF);if(s==IntPtr.Zero){if(Marshal.GetLastWin32Error()!=1060)throw new Win32Exception();s=CreateService(m,"RYReach","Reach Node",0xF01FF,0x10,start,1,path,null,IntPtr.Zero,null,"LocalSystem",null);Check(s!=IntPtr.Zero);}try{Check(ChangeServiceConfig(s,0x10,start,1,path,null,IntPtr.Zero,null,"LocalSystem",null,"Reach Node"));if(start==2){int delayed=1;Check(ChangeServiceConfig2(s,3,ref delayed));}}finally{CloseServiceHandle(s);}}finally{CloseServiceHandle(m);}}
 public static void Remove(){IntPtr m=OpenSCManager(null,null,1);Check(m!=IntPtr.Zero);try{IntPtr s=OpenService(m,"RYReach",0x10000);if(s==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==1060)return;throw new Win32Exception(error);}try{Check(DeleteService(s));}finally{CloseServiceHandle(s);}}finally{CloseServiceHandle(m);}}
 static void AssertOwned(IntPtr service,string expected){uint size;QueryServiceConfigW(service,IntPtr.Zero,0,out size);IntPtr buffer=Marshal.AllocHGlobal((int)size);try{Check(QueryServiceConfigW(service,buffer,size,out size));Config config=(Config)Marshal.PtrToStructure(buffer,typeof(Config));string path=Marshal.PtrToStringUni(config.path),account=Marshal.PtrToStringUni(config.account);if(config.type!=0x10||!String.Equals(path,expected,StringComparison.Ordinal)||(!String.Equals(account,"LocalSystem",StringComparison.OrdinalIgnoreCase)&&!String.Equals(account,@"NT AUTHORITY\SYSTEM",StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("Service configuration differs from the owned Reach deployment");}finally{Marshal.FreeHGlobal(buffer);}}
 public static void DisableOwned(string expected){IntPtr manager=OpenSCManager(null,null,1);Check(manager!=IntPtr.Zero);try{IntPtr service=OpenService(manager,"RYReach",3);Check(service!=IntPtr.Zero);try{AssertOwned(service,expected);Check(ChangeServiceConfig(service,0xffffffff,4,0xffffffff,null,null,IntPtr.Zero,null,null,null,null));}finally{CloseServiceHandle(service);}}finally{CloseServiceHandle(manager);}}
 public static void RemoveOwned(string expected){IntPtr manager=OpenSCManager(null,null,1);Check(manager!=IntPtr.Zero);try{IntPtr service=OpenService(manager,"RYReach",0x10001);if(service==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==1060||error==1072)return;throw new Win32Exception(error);}try{AssertOwned(service,expected);if(!DeleteService(service)){int error=Marshal.GetLastWin32Error();if(error!=1072)throw new Win32Exception(error);}}finally{CloseServiceHandle(service);}}finally{CloseServiceHandle(manager);}}
 public static uint Pid(){IntPtr m=OpenSCManager(null,null,1);Check(m!=IntPtr.Zero);try{IntPtr s=OpenService(m,"RYReach",4);Check(s!=IntPtr.Zero);try{Status status;uint needed;Check(QueryServiceStatusEx(s,0,out status,(uint)Marshal.SizeOf(typeof(Status)),out needed));return status.pid;}finally{CloseServiceHandle(s);}}finally{CloseServiceHandle(m);}}
}
'@
    Add-Type -AssemblyName System.ServiceProcess
    function AcquireMaintenanceLock([string]$Path) {
        if(-not(Test-Path -LiteralPath $Path)){
            try{$created=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(Security $false $false));$created.Dispose()}
            catch{if(-not[IO.File]::Exists($Path)){throw}}
        }
        CheckPath $Path
        return [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
    $programAnchor=[Environment]::GetFolderPath('ProgramFiles')
    $dataAnchor=[Environment]::GetFolderPath('CommonApplicationData')
    CheckAnchor $programAnchor;CheckAnchor $dataAnchor
    $programParent=Join-Path $programAnchor 'RY';$dataParent=Join-Path $dataAnchor 'RY'
    if($MaintenanceOperation-ceq'install'){Directory $dataParent $false}else{CheckPath $dataParent}
    $externalLock=AcquireMaintenanceLock (Join-Path $dataParent 'Reach.installation.lock')
    if($MaintenanceOperation-ceq'install'){Directory $programParent $true}else{CheckPath $programParent}
    $root=Join-Path $programParent 'Reach';$state=Join-Path $dataParent 'Reach'
    if($MaintenanceOperation-ceq'install'){Directory $root $true}else{CheckPath $root}
    $bin=Join-Path $root 'bin';$versions=Join-Path $root 'versions'
    $manifestPath=Join-Path $root 'install.json';$journalPath=Join-Path $root 'install-journal.json';$cli=Join-Path $bin 'reach.exe'
    function AcquireInstallationLock {
        $lockPath=Join-Path $root 'install.lock'
        # The protected, persistent lock file is never unlinked/replaced while held.
        return AcquireMaintenanceLock $lockPath
    }
    $installLock=AcquireInstallationLock
    RecoverReachAtomicWrites
    if($MaintenanceOperation-ceq'install'){Directory $state $false}else{CheckPath $state}
    foreach($leaf in @('node.sqlite','node.sqlite-wal','node.sqlite-shm','reach.lock')) { $path=Join-Path $state $leaf;if([IO.File]::Exists($path)){CheckPath $path} }
    $deploymentPath=Join-Path $root 'deployment.json'
    $deployment=if([IO.File]::Exists($deploymentPath)){ReadJson $deploymentPath}else{$null}
    if($null-ne$deployment){AssertReachDeployment $deployment $root $state}
    $environment=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment',$true)
    $uninstallParent=OpenReachUninstallRegistry
    function PathSnapshot {
        $exists=$environment.GetValueNames() -contains 'Path'
        $kind=if($exists){$environment.GetValueKind('Path')}else{[Microsoft.Win32.RegistryValueKind]::ExpandString}
        if($kind -notin @([Microsoft.Win32.RegistryValueKind]::String,[Microsoft.Win32.RegistryValueKind]::ExpandString)){throw 'Unsupported machine PATH registry type'}
        return @{exists=$exists;kind=[int]$kind;raw=[string]$environment.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
    }
    function NotifyEnvironment {
        $unused=[IntPtr]::Zero;[void][ReachSetupNative]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,3000,[ref]$unused)
    }
    function PlanPath {
        $before=PathSnapshot
        $found=@($before.raw.Split(';')|Where-Object{[Environment]::ExpandEnvironmentVariables($_).Trim().Trim('"').TrimEnd('\') -ieq $bin.TrimEnd('\')}).Count -gt 0
        if($found){return $null}
        $after=if($before.raw.Length-eq0){$bin}else{$before.raw+';'+$bin}
        return @{before=$before;after=$after;applied=$false}
    }
    function ApplyPath($change) {
        if($null-eq$change){return}
        $now=PathSnapshot
        if($now.exists-ne$change.before.exists -or $now.kind-ne$change.before.kind -or $now.raw-cne$change.before.raw){throw 'Machine PATH changed during installation; retry with the current value'}
        $environment.SetValue('Path',$change.after,[Microsoft.Win32.RegistryValueKind]$change.before.kind)
        $change.applied=$true
        NotifyEnvironment
    }
    function RestorePath($change) {
        if($null-eq$change -or -not $change.applied){return}
        $now=PathSnapshot
        if($now.raw-ceq$change.before.raw -and $now.exists-eq$change.before.exists){return}
        if($now.raw-ceq$change.after -and $now.kind-eq$change.before.kind){
            if($change.before.exists){$environment.SetValue('Path',$change.before.raw,[Microsoft.Win32.RegistryValueKind]$change.before.kind)}else{$environment.DeleteValue('Path',$false)}
        }else{return} # Concurrent/uncertain edits are preserved; ownership cannot be inferred from text.
        NotifyEnvironment
    }
    function CaptureProcess([string[]]$AllowedImages) {
        $servicePid=[ReachSetupNative]::Pid()
        if($servicePid-eq0){return $null}
        $process=[Diagnostics.Process]::GetProcessById([int]$servicePid)
        try {
            $null=$process.Handle # Hold the actual process object across SCM STOPPED/PID reuse.
            if($process.MainModule.FileName -notin $AllowedImages){
                throw 'Running service image is outside this installation transaction'
            }
            return $process
        } catch {$process.Dispose();throw}
    }
    function WaitStopped($Process) {
        $service=[ServiceProcess.ServiceController]::new('RYReach')
        try{$service.Refresh();$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45))}finally{$service.Dispose()}
        if($null-ne$Process -and -not $Process.WaitForExit(45000)){throw 'SCM stopped but the original service process has not exited'}
    }
    function StopService($Process) {
        $service=[ServiceProcess.ServiceController]::new('RYReach')
        try {$service.Refresh();if($service.Status-ne'Stopped' -and $service.Status-ne'StopPending'){$service.Stop()}}finally{$service.Dispose()}
        WaitStopped $Process
    }
    function IsRunning {
        $service=[ServiceProcess.ServiceController]::new('RYReach');try{$service.Refresh();return $service.Status-eq'Running'}finally{$service.Dispose()}
    }
    function StartService {
        $service=[ServiceProcess.ServiceController]::new('RYReach')
        try{
            $service.Refresh()
            if($service.Status-eq'StopPending'){$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45));$service.Refresh()}
            if($service.Status-eq'Stopped'){$service.Start()}
            $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(40))
        }finally{$service.Dispose()}
    }
    function ProcessRecord($Process) {
        if($null-eq$Process){return $null}
        return @{pid=$Process.Id;startTicks=$Process.StartTime.ToUniversalTime().Ticks;image=$Process.MainModule.FileName}
    }
    function WaitRecordedExit($record) {
        if($null-eq$record){return}
        $process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if($null-eq$process){return}
        try {
            $null=$process.Handle
            if($process.StartTime.ToUniversalTime().Ticks-ne$record.startTicks){return}
            if($process.MainModule.FileName-ine$record.image){throw 'Recorded process identity changed'}
            if(-not $process.WaitForExit(45000)){throw 'Recorded service process has not exited'}
        }finally{$process.Dispose()}
    }
    function Node([string]$Executable,[string]$Operation) {
        $raw=& $Executable $Operation 2>&1
        if($LASTEXITCODE-ne0){throw "Node $Operation failed: $raw"}
        return ($raw -join "`n"|ConvertFrom-Json)
    }
    function ValidateManifestIdentity($record) {
        if($record.schema-notin@(1,2) -or $record.version-ne'0.1.0' -or $record.nodeStateSchema-ne1 -or $record.sha256-notmatch'^[0-9a-f]{64}$' -or $record.bindingOwner-notmatch'^S-1-[0-9-]+$'){throw 'Unsupported existing installation record'}
        $versionKey=$record.sha256.Substring(0,16)
        if($record.schema-eq2){
            if($record.packageSha256-notmatch'^[0-9a-f]{64}$' -or $record.payloadManifestSha256-notmatch'^[0-9a-f]{64}$' -or $record.desktopBundled-isnot[bool] -or -not $record.desktopBundled){throw 'Unsupported complete installation record'}
            $versionKey=$record.packageSha256
        }
        $expected=Join-Path (Join-Path $versions ($record.version+'-'+$versionKey)) 'reach.exe'
        if($record.nodePath-cne$expected -or $record.servicePath-cne('"'+$expected+'" --state-dir "'+$state+'" service --binding-owner '+$record.bindingOwner)){throw 'Existing installation path mismatch'}
        # Identity checks remain possible when a failed candidate lost a file.
        # The caller must validate bytes before starting a version.
        CheckPath $versions
        if([IO.Directory]::Exists((Split-Path $expected))){CheckPath (Split-Path $expected)}
        if([IO.File]::Exists($expected)){CheckPath $expected}
    }
    function ValidateManifest($record) {
        ValidateManifestIdentity $record
        $expected=$record.nodePath
        CheckPath (Split-Path $expected);CheckPath $expected
        if((Hash ([IO.File]::ReadAllBytes($expected)))-ne$record.sha256){throw 'Existing installed binary hash mismatch'}
        if($record.schema-eq2){
            $verified=ReadReachInstalledPayload (Split-Path $expected) $record.payloadManifestSha256
            if($verified.nodeSha256-cne$record.sha256){throw 'Installed Node and package identities differ'}
        }
    }
    function StageCompletePayload($Package,[string]$PackageSha,[string]$ManifestSha) {
        $final=Join-Path $versions ('0.1.0-'+$PackageSha)
        foreach($name in $Package.entries.Keys){
            $target=Join-Path $final $name
            # Payload files are written directly inside a shorter reserved stage;
            # only metadata uses atomic-write temporaries. WinPS 5.1 uses MAX_PATH.
            if($target.Length-ge260){throw "Installed path is too long: $name"}
        }
        $files=@($Package.manifest.files|ForEach-Object{$_.path})+@('payload-manifest.json')
        if(Test-Path -LiteralPath $final){
            $null=ReadReachInstalledPayload $final $ManifestSha
            AddReachOwnershipGroup $deployment ('versions/0.1.0-'+$PackageSha) 'complete' $PackageSha $files
            SaveReachDeployment $deployment
            return $final
        }
        $stage=Join-Path $versions ('s-'+[Guid]::NewGuid().ToString('N'))
        AddReachOwnershipGroup $deployment ('versions/0.1.0-'+$PackageSha) 'complete' $PackageSha $files
        AddReachOwnershipGroup $deployment ('versions/'+[IO.Path]::GetFileName($stage)) 'stage' $PackageSha $files
        SaveReachDeployment $deployment
        Directory $stage $true
        $directories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);[void]$directories.Add($stage)
        foreach($name in ($Package.entries.Keys|Sort-Object)){
            $parts=$name.Split('/');$parent=$stage
            for($i=0;$i-lt$parts.Length-1;$i++){$parent=Join-Path $parent $parts[$i];if($directories.Add($parent)){Directory $parent $true}}
            WriteReachStagedFile (Join-Path $stage $name) (ReadReachEntry $Package.entries[$name] 536870912)
        }
        $null=ReadReachInstalledPayload $stage $ManifestSha
        [IO.Directory]::Move($stage,$final)
        CheckPath $final
        $deployment.groups=@($deployment.groups|Where-Object{$_.directory-cne('versions/'+[IO.Path]::GetFileName($stage))})
        SaveReachDeployment $deployment
        return $final
    }
    function StageNodePayload {
        $versionRoot=Join-Path $versions ('0.1.0-'+$NodeSha.Substring(0,16))
        if($null-eq$Notices -or $Notices.Length-eq0){throw 'Third-party notices are missing from this package'}
        $items=@(@('reach.exe',$NodePayload),@('THIRD_PARTY_NOTICES.txt',$Notices))
        if(Test-Path -LiteralPath $versionRoot){
            CheckPath $versionRoot
            foreach($item in $items){$path=Join-Path $versionRoot $item[0];CheckPath $path;if((Hash ([IO.File]::ReadAllBytes($path)))-cne(Hash $item[1])){throw 'Existing Node version contains different bytes'}}
            AddReachOwnershipGroup $deployment ('versions/0.1.0-'+$NodeSha.Substring(0,16)) 'node' $NodeSha @('reach.exe','THIRD_PARTY_NOTICES.txt')
            SaveReachDeployment $deployment
            return $versionRoot
        }
        $stageRelative='versions/s-'+[Guid]::NewGuid().ToString('N');$stage=Join-Path $root $stageRelative
        AddReachOwnershipGroup $deployment ('versions/0.1.0-'+$NodeSha.Substring(0,16)) 'node' $NodeSha @('reach.exe','THIRD_PARTY_NOTICES.txt')
        AddReachOwnershipGroup $deployment $stageRelative 'stage' $NodeSha @('reach.exe','THIRD_PARTY_NOTICES.txt')
        SaveReachDeployment $deployment
        Directory $stage $true
        foreach($item in $items){WriteReachStagedFile (Join-Path $stage $item[0]) $item[1]}
        foreach($item in $items){$path=Join-Path $stage $item[0];CheckPath $path;if((Hash ([IO.File]::ReadAllBytes($path)))-cne(Hash $item[1])){throw 'Staged Node version contains different bytes'}}
        [IO.Directory]::Move($stage,$versionRoot);CheckPath $versionRoot
        $deployment.groups=@($deployment.groups|Where-Object{$_.directory-cne$stageRelative});SaveReachDeployment $deployment
        return $versionRoot
    }
    function ResumeRestored($transaction) {
        if($transaction.schema-eq4 -and ($null-eq$deployment -or $deployment.deploymentGeneration-cne$transaction.previousDeployment.deploymentGeneration)){
            throw 'Restored deployment generation differs from the installation transaction'
        }
        $expected=if($null-ne$transaction.previous){$transaction.previous.servicePath}else{$null}
        if([ReachSetupNative]::Path()-cne$expected){throw 'Restored service configuration changed; automatic recovery refused'}
        if($null-ne$transaction.previous){
            ValidateManifest $transaction.previous
            [ReachSetupNative]::Set($expected)
            if($transaction.previousRunning){StartService}
        }
    }
    function MarkRestored($transaction) {
        if($null-ne$transaction.entryChange){RestoreReachEntry $transaction.entryChange}
        if($transaction.schema-eq4){
            if($null-eq$deployment){throw 'Tracked installation recovery is missing its ownership catalog'}
            RestoreReachDeploymentIdentity $deployment $transaction.previousDeployment
        }
        $transaction.phase='restored';WriteJson $journalPath $transaction
        # Persist this boundary BEFORE restarting the old version, which can
        # acquire work. Recovery of this phase must never stop it again.
        ResumeRestored $transaction
    }
    function Restore($transaction) {
        ValidateManifestIdentity $transaction.target
        $allowedPaths=@($transaction.target.servicePath);$allowedImages=@($transaction.target.nodePath)
        if($null-ne$transaction.previous){ValidateManifest $transaction.previous;$allowedPaths+=@($transaction.previous.servicePath);$allowedImages+=@($transaction.previous.nodePath)}
        $actual=[ReachSetupNative]::Path()
        if($null-ne$actual -and $actual-notin$allowedPaths){throw 'Service configuration changed outside this transaction; automatic rollback refused'}
        if($transaction.phase-eq'restored'){ResumeRestored $transaction;return}
        # An unknown maintenance ACK on the old service must not kill active work.
        # Only a transaction which entered switching may stop the candidate.
        if($transaction.phase -in @('staged','stopping')){
            if($null-ne$transaction.previous){
                if($actual-cne$transaction.previous.servicePath){throw 'Original service configuration changed before switching'}
                if($transaction.previousRunning){if(-not (IsRunning)){WaitRecordedExit $transaction.originalProcess}}
                elseif(IsRunning){$process=CaptureProcess $allowedImages;try{StopService $process}finally{if($process){$process.Dispose()}}}
            }
            MarkRestored $transaction;return
        }
        if($null-ne$actual){
            $process=CaptureProcess $allowedImages
            try {StopService $process}finally{if($process){$process.Dispose()}}
        }
        WaitRecordedExit $transaction.originalProcess
        WaitRecordedExit $transaction.targetProcess
        # Both versions use nodeStateSchema 1. Never restore an old database:
        # candidate effects and unacknowledged/unknown receipts must remain.
        if($null-ne$transaction.previous){
            # Keep auto-start disabled until the restored checkpoint is durable;
            # a reboot between restoring files and that checkpoint cannot run it.
            [ReachSetupNative]::Stage($transaction.previous.servicePath)
            WriteFile $cli ([IO.File]::ReadAllBytes($transaction.previous.nodePath)) $true
            WriteJson $manifestPath $transaction.previous
        }else{
            if($null-ne$actual){[ReachSetupNative]::Remove();WaitReachServiceAbsent}
            foreach($path in @($manifestPath,$cli)){
                if([IO.File]::Exists($path)){
                    CheckPath $path
                    if($path-eq$manifestPath){
                        $value=ReadJson $path
                        if($null-ne$transaction.previousTombstone -and (SameReachJson $value $transaction.previousTombstone)){continue}
                        if($value.sha256-cne$transaction.target.sha256 -or $value.schema-ne$transaction.target.schema -or ($value.schema-eq2 -and $value.packageSha256-cne$transaction.target.packageSha256)){throw 'Unexpected installation record during rollback'}
                    }
                    elseif((Hash ([IO.File]::ReadAllBytes($path)))-cne$transaction.target.sha256){throw 'Unexpected CLI during rollback'}
                    [IO.File]::Delete($path)
                }
            }
            if($null-ne$transaction.previousTombstone){WriteJson $manifestPath $transaction.previousTombstone}
        }
        RestorePath $transaction.pathChange
        MarkRestored $transaction
    }
    function RecoverJournal {
      if([IO.File]::Exists($journalPath)){
        $prior=ReadJson $journalPath
        if($prior.schema-eq3 -and $prior.operation-ceq'uninstall'){
            if($MaintenanceOperation-ceq'uninstall'){throw 'Uninstall journal requires uninstall dispatch'}
            $null=InvokeReachUninstallTransaction $prior $root
            $prior=NewReachReinstallPreparation (ReadJson $journalPath)
            WriteJson $journalPath $prior
        }
        if($prior.schema-eq4 -and $prior.operation-ceq'install' -and $prior.phase-ceq'prepared'){
            CompleteReachReinstallPreparation $prior
            return
        }
        if($prior.schema-notin@(1,2,4) -or ($prior.schema-in@(2,4) -and $prior.operation-cne'install') -or $prior.phase-notin@('staged','stopping','switching','restored','committed','rolled_back','recovered')){throw 'Unsupported installation journal'}
        if($prior.phase -notin @('committed','rolled_back','recovered')) {Restore $prior;$prior.phase='recovered';WriteJson $journalPath $prior}
      }
    }
    if($MaintenanceOperation-ceq'uninstall'){$null=InvokeReachInstalledUninstall;exit 0}
    RecoverJournal
    # Recovery may have replaced the protected catalog while preparing a reinstall.
    $deployment=if([IO.File]::Exists($deploymentPath)){ReadJson $deploymentPath}else{$null}
    Directory $bin $true;Directory $versions $true
    $previous=if([IO.File]::Exists($manifestPath)){ReadJson $manifestPath}else{$null}
    $previousTombstone=$null
    if($null-ne$previous -and $previous.schema-eq3){
        $history=ReadJson $journalPath
        if($history.schema-ne4 -or $history.operation-cne'install' -or $null-ne$deployment.record -or
            $null-eq$history.previousTombstone -or -not(SameReachJson $previous $history.previousTombstone)){
            throw 'Uninstalled record has no trusted reinstall handoff'
        }
        AssertReachTombstone $previous $previous.deploymentGeneration $deployment.installationId $deployment.bindingOwner
        $previousTombstone=$previous;$previous=$null
    }
    $existingService=[ReachSetupNative]::Path()
    if($null-ne$previous){ValidateManifest $previous;if($existingService-cne$previous.servicePath){throw 'Actual service differs from the trusted installation record'};$BindingOwner=$previous.bindingOwner}
    elseif($null-ne$existingService){throw 'Existing service has no trusted installation record'}
    $ownerPath=Join-Path $dataParent 'Reach.installation.json'
    $ownerRecord=if([IO.File]::Exists($ownerPath)){ReadJson $ownerPath}else{$null}
    if($null-ne$ownerRecord){
        if($ownerRecord.schema-ne1 -or $ownerRecord.nodeStateSchema-ne1 -or $ownerRecord.bindingOwner-notmatch'^S-1-[0-9-]+$'){throw 'Unsupported retained installation owner'}
        if($null-ne$previous -and $previous.bindingOwner-cne$ownerRecord.bindingOwner){throw 'Retained owner differs from installed owner'}
        $BindingOwner=$ownerRecord.bindingOwner
    }else{
        $ownerRecord=@{schema=1;nodeStateSchema=1;bindingOwner=$BindingOwner;installationId=$null}
        WriteJson $ownerPath $ownerRecord
    }
    if($null-eq$deployment){
        $deployment=NewReachDeployment $root $state $BindingOwner
        if($null-ne$previous){ImportReachInstalledOwnership $deployment $previous;$deployment.record=$previous;$deployment.recordSha256=Hash ([IO.File]::ReadAllBytes($manifestPath));$deployment.cliOwned=$true}
        elseif(Test-Path -LiteralPath $cli){throw 'Existing CLI has no trusted installation record'}
        if([IO.File]::Exists($journalPath)){
            $history=ReadJson $journalPath
            foreach($record in @($history.previous,$history.target)){if($null-ne$record){ImportReachInstalledOwnership $deployment $record}}
        }
        $deployment.installationId=$ownerRecord.installationId
        SaveReachDeployment $deployment
    }else{
        if($deployment.bindingOwner-cne$BindingOwner -or ($null-ne$previous)-ne($null-ne$deployment.record)){throw 'Current installation differs from tracked deployment'}
        if($null-ne$previous -and ((Hash ([IO.File]::ReadAllBytes($manifestPath)))-cne$deployment.recordSha256)){throw 'Installation record changed outside tracked deployment'}
    }
    $previousDeployment=$deployment|ConvertTo-Json -Depth 12 -Compress|ConvertFrom-Json
    if($CompletePackage){$versionRoot=StageCompletePayload $package $PayloadSha $PayloadManifestSha}
    else{$versionRoot=StageNodePayload}
    $nodePath=Join-Path $versionRoot 'reach.exe'
    $next=@{schema=1;version='0.1.0';nodeStateSchema=1;sha256=$NodeSha;nodePath=$nodePath;bindingOwner=$BindingOwner;servicePath=('"'+$nodePath+'" --state-dir "'+$state+'" service --binding-owner '+$BindingOwner);pathOwnership=$null}
    if($null-ne$previous -and $previous.pathOwnership){$next.pathOwnership=$previous.pathOwnership}
    if($CompletePackage){$next.schema=2;$next.packageSha256=$PayloadSha;$next.payloadManifestSha256=$PayloadManifestSha;$next.desktopBundled=$true}
    $next.deploymentGeneration=[Guid]::NewGuid().ToString()
    ValidateManifest $next
    $entryChange=NewReachEntryChange $previousDeployment $next $RecoveryScriptBytes
    $transaction=@{schema=4;operation='install';phase='staged';previous=$previous;previousDeployment=$previousDeployment;previousTombstone=$previousTombstone;entryChange=$entryChange;previousRunning=($null-ne$previous -and (IsRunning));target=$next;originalProcess=$null;targetProcess=$null;pathChange=$null;startedAt=[DateTime]::UtcNow.ToString('o')}
    WriteJson $journalPath $transaction
    $deployment.cliOwned=$true;SaveReachDeployment $deployment
    try {
        $binding=$null
        if($null-ne$previous){
            StartService
            $transaction.phase='stopping';WriteJson $journalPath $transaction
            # An uncertain ACK is a failure, never permission to switch binaries.
            $process=CaptureProcess @($previous.nodePath)
            try {
                $transaction.originalProcess=ProcessRecord $process;WriteJson $journalPath $transaction
                $binding=Node $previous.nodePath 'maintenance-stop'
                if(-not $binding.maintenanceStopRequested){throw 'Maintenance stop was not acknowledged'}
                WaitStopped $process
            } finally {if($process){$process.Dispose()}}
        }
        $transaction.phase='switching';WriteJson $journalPath $transaction
        [ReachSetupNative]::Set($next.servicePath)
        WriteFile $cli $NodePayload $true
        StartService
        $process=CaptureProcess @($nodePath)
        try {$transaction.targetProcess=ProcessRecord $process;WriteJson $journalPath $transaction}finally{if($process){$process.Dispose()}}
        $status=Node $nodePath 'status'
        if($ownerRecord.installationId -and $ownerRecord.installationId-cne$status.installationId){throw 'Retained installation identity changed'}
        $ownerRecord.installationId=$status.installationId;WriteJson $ownerPath $ownerRecord
        if($null-ne$binding -and ($status.installationId-cne$binding.installationId -or $status.epoch-ne$binding.epoch)){throw 'Original installation binding changed during update'}
        if([ReachSetupNative]::Path()-cne$next.servicePath){throw 'Service program verification failed'}
        $process=CaptureProcess @($nodePath)
        try {if($null-eq$process -or $process.Id-ne$status.host.pid){throw 'Running service PID differs from authenticated status'}}finally{if($process){$process.Dispose()}}
        # Record PATH intent before writing so interrupted updates can remove only this added entry.
        $transaction.pathChange=PlanPath
        WriteJson $journalPath $transaction
        ApplyPath $transaction.pathChange
        if($transaction.pathChange){$next.pathOwnership=$transaction.pathChange}
        WriteJson $journalPath $transaction
        PublishReachEntry $transaction.entryChange
        WriteJson $manifestPath $next
        $deployment.deploymentGeneration=$next.deploymentGeneration;$deployment.record=$next
        $deployment.recordSha256=Hash ([IO.File]::ReadAllBytes($manifestPath));$deployment.installationId=$status.installationId
        SetReachProperty $deployment 'recovery' $transaction.entryChange.target
        SaveReachDeployment $deployment
        WriteJson (Join-Path $root 'last-install-result.json') @{validationPassed=$true;requiresCommittedJournal=$true;sha256=$NodeSha;packageSha256=$(if($CompletePackage){$PayloadSha}else{$null});installationId=$status.installationId;epoch=$status.epoch;servicePid=$status.host.pid;time=[DateTime]::UtcNow.ToString('o');desktopBundled=[bool]$CompletePackage}
        $transaction.phase='committed';$transaction.installationId=$status.installationId;$transaction.epoch=$status.epoch;WriteJson $journalPath $transaction
    }catch{
        $original=$_.Exception.Message
        if($transaction.phase-eq'committed'){throw "Installation commit status requires checking the journal; no automatic rollback was attempted: $original"}
        try {Restore $transaction;$transaction.phase='rolled_back';WriteJson $journalPath $transaction}catch{throw "Install failed: $original; rollback requires attention: $($_.Exception.Message)"}
        throw "Install failed and previous program restored: $original"
    }
    exit 0
}catch{
    [Console]::Error.WriteLine($_.Exception.Message)
    if($ShowMaintenanceError){Add-Type -AssemblyName System.Windows.Forms;[void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'Reach uninstall failed')}
    exit 1
}finally{
    foreach($resource in @($payloadArchive,$payloadStream,$uninstallParent,$environment,$installLock,$externalLock)){if($null-ne$resource){$resource.Dispose()}}
}
