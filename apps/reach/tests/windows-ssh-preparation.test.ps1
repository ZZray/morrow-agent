# Copyright (c) Ray Zhang. Account lookup, effective configuration and isolated payload checks.
param([string]$OpenSshArchive)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../packaging/windows/ssh.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/ownership.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/maintenance-writes.ps1')
function Assert([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Refused([scriptblock]$Action,[string]$Pattern) {
    try { & $Action; throw 'Expected rejection was missing' } catch { if ($_.Exception.Message -notmatch $Pattern) { throw } }
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('reach-ssh-preparation-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($root)
$originalUser=$env:USERNAME
$originalProgramFiles=$env:ProgramFiles
$originalProgramData=$env:ProgramData
try {
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $original=ResolveReachSshAccount $sid
    $env:USERNAME='SYSTEM'
    $resolved=ResolveReachSshAccount $sid
    Assert ($resolved.user -ceq $original.user -and $resolved.sid -ceq $sid) 'Service environment changed the binding owner account'
    foreach ($serviceSid in @('S-1-5-18','S-1-5-19','S-1-5-20')) { Refused { ResolveReachSshAccount $serviceSid } 'installation binding owner' }

    $script:hostKeyPath=Join-Path $root 'ssh_host_ed25519_key'
    $public='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB'
    [IO.File]::WriteAllText($script:hostKeyPath+'.pub',$public)
    $script:keySetting='.ssh/authorized_keys'
    $script:testAccount=@{user='domain\operator';sid=$sid;profile=$root}
    function ResolveReachSshAccount([string]$OwnerSid) { return $script:testAccount }
    function TestReachSshd {
        $script:lastSshArguments=@($args)
        $global:LASTEXITCODE=0
        return @('usedns no',('authorizedkeysfile '+$script:keySetting),('hostkey '+$script:hostKeyPath))
    }
    $command=@{exe='TestReachSshd';configArgs=@('-f',(Join-Path $root 'custom-sshd.conf'))}
    $target=ResolveReachSshTarget $sid $command
    Assert ($target.user -ceq 'domain\operator') 'Domain account was lost'
    Assert ($target.authorizedKeysPath -ceq (Join-Path $root '.ssh\authorized_keys')) 'Non-admin key file used the service profile'
    Assert ($script:lastSshArguments -contains '-f' -and $script:lastSshArguments -contains $command.configArgs[1]) 'Custom service config was lost'
    Assert (($script:lastSshArguments -join ' ') -match 'user=domain\\operator,host=127.0.0.1,addr=127.0.0.1') 'Effective config did not use the tunnel endpoint'
    $script:keySetting='__PROGRAMDATA__/ssh/administrators_authorized_keys'
    $target=ResolveReachSshTarget $sid $command
    Assert $target.sharedAdminKeys 'Effective admin match was not honored'
    $script:keySetting='.ssh/a .ssh/b'
    $target=ResolveReachSshTarget $sid $command
    Assert ($target.authorizedKeysPath -ceq (Join-Path $root '.ssh\a')) 'Multiple key files did not preserve the first usable file'
    $script:keySetting='none'
    Refused { ResolveReachSshTarget $sid $command } 'Disabled AuthorizedKeysFile'
    $script:keySetting='%h/.ssh/authorized_keys';$script:testAccount.profile=''
    Refused { ResolveReachSshTarget $sid $command } 'no initialized Windows profile'

    if ($OpenSshArchive) {
        $payload=& (Join-Path $PSScriptRoot '../packaging/windows/prepare-openssh.ps1') -Archive $OpenSshArchive -Destination (Join-Path $root 'vendor.zip')
        Assert ((Get-FileHash -LiteralPath $payload).Hash -eq '23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5') 'Vendor archive identity mismatch'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip=[IO.Compression.ZipFile]::OpenRead($payload)
        try {
            Assert ($null -ne $zip.GetEntry('OpenSSH-Win64/LICENSE.txt')) 'Vendor license missing'
            Assert ($null -ne $zip.GetEntry('OpenSSH-Win64/NOTICE.txt')) 'Vendor notices missing'
            Assert ($null -eq $zip.GetEntry('authorized_keys')) 'Offline wrapper authorization was packaged'
        } finally { $zip.Dispose() }
        # Execute the missing-sshd path against actual vendor bytes and temporary files.
        # Native tools and service control have adapters. File writes use production functions.
        $env:ProgramFiles=Join-Path $root 'programs';$env:ProgramData=Join-Path $root 'data'
        $null=New-Item -ItemType Directory -Path $env:ProgramFiles,$env:ProgramData
        $dataParent=Join-Path $env:ProgramData 'RY'
        $programParent=Join-Path $env:ProgramFiles 'RY'
        $null=[IO.Directory]::CreateDirectory($programParent)
        $script:fakeCommand=$null;$script:nativeCalls=@();$script:serviceCreations=0
        $script:listenerQueries=0
        $script:listenerMode='delayed'
        $script:privateKeyAcls=@{};$script:aclRepairs=@();$script:stopCalls=0
        function Hash([byte[]]$Bytes) { $h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()} }
        function Directory([string]$Path,[bool]$Public) { $null=[IO.Directory]::CreateDirectory($Path) }
        function CheckPath([string]$Path) {
            $item=Get-Item -LiteralPath $Path -Force
            Assert (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Reparse path refused'
        }
        function Security([bool]$Directory,[bool]$Public) {
            $acl=[Security.AccessControl.FileSecurity]::new()
            $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl.SetOwner($identity)
            $acl.SetAccessRuleProtection($true,$false)
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'))
            return $acl
        }
        function WriteFile([string]$Path,[byte[]]$Bytes,[bool]$Public) { WriteReachAtomicFile $Path $Bytes $Public }
        function GetReachSshCommand { if ($script:fakeCommand) { return $script:fakeCommand.Clone() } }
        function Get-Acl($LiteralPath) {
            if ($script:privateKeyAcls.ContainsKey($LiteralPath)) { return $script:privateKeyAcls[$LiteralPath] }
            Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath
        }
        function Set-Acl($LiteralPath,$AclObject) {
            Assert ($script:privateKeyAcls.ContainsKey($LiteralPath)) 'The installer changed a non-host-key ACL'
            $script:aclRepairs+=@($LiteralPath)
            $secured=[Security.AccessControl.FileSecurity]::new()
            $secured.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
            $secured.SetAccessRuleProtection($true,$false)
            foreach ($principal in @('S-1-5-18','S-1-5-32-544')) {
                $identity=[Security.Principal.SecurityIdentifier]::new($principal)
                $secured.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'))
            }
            $script:privateKeyAcls[$LiteralPath]=$secured
        }
        function InvokeReachSshProgram([string]$Executable,[string[]]$Arguments,[string]$Failure,[int[]]$AllowedExitCodes=@(0)) {
            $script:nativeCalls+=@{exe=$Executable;arguments=$Arguments}
            if ($Arguments[0] -eq '-A') {
                foreach ($kind in @('rsa','ecdsa','ed25519')) {
                    $path=Join-Path $env:ProgramData "ssh\ssh_host_${kind}_key"
                    if ([IO.File]::Exists($path)) { continue }
                    [IO.File]::WriteAllText($path,"original private key fixture $kind")
                    $script:privateKeyAcls[$path]=Security $false $false
                }
            }
            if ($Arguments[0] -eq 'stop') {
                Assert ($AllowedExitCodes -contains 109) 'Broken-pipe stop did not check real exit state'
                $script:stopCalls++
                $script:fakeCommand.service.State='Stopped'
                $script:fakeCommand.service.ProcessId=0
            }
        }
        function New-Service($Name,$DisplayName,$BinaryPathName,$StartupType) {
            $script:serviceCreations++
            $script:fakeCommand=@{exe=$BinaryPathName.Trim('"');configArgs=@();service=@{State='Stopped';ProcessId=0;StartName='LocalSystem'}}
        }
        function Set-Service($Name,$StartupType) { Assert ($StartupType -ceq 'Automatic') 'sshd autostart missing' }
        function Start-Service($Name) {
            $script:serviceStarted=$true
            $script:fakeCommand.service.State='Running'
            $script:fakeCommand.service.ProcessId=1234+$script:stopCalls
            if ($script:listenerMode -eq 'unbound') { $script:listenerMode='ready' }
        }
        function Get-Service($Name) {
            $s=[pscustomobject]@{Status=$script:fakeCommand.service.State}
            $s|Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value {param($Status,$Timeout) Assert ($Status -eq $script:fakeCommand.service.State) "Expected service state $Status"}
            return $s
        }
        function Get-Process($Id,$ErrorAction) {
            Assert ($Id -eq $script:fakeCommand.service.ProcessId) 'Recovery inspected a different PID'
            $p=[pscustomobject]@{Path=$script:fakeCommand.exe}
            $p|Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($Timeout) return ($script:fakeCommand.service.State -eq 'Stopped')}
            return $p
        }
        function Get-CimInstance($ClassName,$Filter,$ErrorAction) {
            Assert ($ClassName -eq 'Win32_Process' -and $Filter -eq "ParentProcessId=$($script:fakeCommand.service.ProcessId)") 'Recovery inspected another process tree'
        }
        function Get-NetTCPConnection($State,$LocalPort,$ErrorAction) {
            $script:listenerQueries++
            switch ($script:listenerMode) {
                'foreign' { return [pscustomobject]@{LocalPort=22;OwningProcess=4567} }
                'other-port' { return [pscustomobject]@{LocalPort=2222;OwningProcess=1234} }
                'query-error' { throw 'fixture TCP query failed' }
                'unbound' { return }
                'ready' { return [pscustomobject]@{LocalPort=22;OwningProcess=$script:fakeCommand.service.ProcessId} }
            }
            if ($script:listenerQueries -gt 1) { return [pscustomobject]@{LocalPort=22;OwningProcess=1234} }
        }
        $vendorBytes=[IO.File]::ReadAllBytes($payload)
        $installed=EnsureReachSshd $vendorBytes $programParent $env:ProgramData
        Assert ($script:listenerQueries -eq 2) 'Installer did not wait for the delayed owned listener'
        Assert ($script:serviceCreations -eq 1 -and $script:serviceStarted) 'Default sshd was not registered and started'
        Assert ([IO.File]::Exists($installed.exe)) 'Vendor executable was not staged'
        Assert ($script:aclRepairs.Count -eq 3) 'Initial setup did not harden all three default private host keys'
        $privatePath=Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key'
        $privateHash=(Get-FileHash -LiteralPath $privatePath).Hash
        $config=Join-Path $env:ProgramData 'ssh\sshd_config'
        Assert ([IO.File]::Exists($config)) 'Default configuration was not prepared'
        Assert ((Hash ([IO.File]::ReadAllBytes($config))) -ceq (Hash ([IO.File]::ReadAllBytes((Join-Path (Split-Path $installed.exe) 'sshd_config_default'))))) 'Default configuration bytes changed'
        Assert ((Get-Acl -LiteralPath $config).AreAccessRulesProtected) 'Configuration did not retain its ACL'
        Refused { WriteFile $config ([byte[]]@(1,2,3)) $false } 'Atomic write target is outside owned maintenance paths'
        Refused { WriteReachSshPrerequisite $config ([byte[]]@(1,2,3)) $false } 'exists|存在'
        Assert (@(Get-ChildItem -LiteralPath $root -Recurse -Force -Filter '.reach-ssh-*.tmp').Count -eq 0) 'SSH write left temporary files'
        Assert ($script:nativeCalls.Count -eq 4) 'Expected keygen, config validation, privileges and final validation'
        $script:testAccount=@{user=$original.user;sid=$sid;profile=$root}
        $actualConfig=Join-Path $root 'effective-sshd.conf'
        $actualHostKey=Join-Path $root 'native_host_key'
        & (Join-Path (Split-Path $installed.exe) 'ssh-keygen.exe') -q -t ed25519 -f $actualHostKey -N '""'
        Assert ($LASTEXITCODE -eq 0) 'Native isolated host key generation failed'
        [IO.File]::WriteAllText($actualConfig,"HostKey $($actualHostKey.Replace('\','/'))`nAuthorizedKeysFile .ssh/first .ssh/second`nUseDNS no`n")
        $actualTarget=ResolveReachSshTarget $sid @{exe=$installed.exe;configArgs=@('-f',$actualConfig)}
        Assert ($actualTarget.authorizedKeysPath -ceq (Join-Path $root '.ssh\first')) 'Real sshd -T effective key path differed'
        Assert ($actualTarget.hostKey -ceq [IO.File]::ReadAllText($actualHostKey+'.pub').Trim()) 'Real sshd -T host key lookup differed'
        $null=EnsureReachSshd $vendorBytes $programParent $env:ProgramData
        Assert ($script:serviceCreations -eq 1 -and $script:stopCalls -eq 0 -and $script:aclRepairs.Count -eq 3) 'Healthy existing SSH service or keys were changed'
        $script:privateKeyAcls[$privatePath]=Security $false $false
        $script:listenerMode='unbound'
        $recovered=EnsureReachSshd $vendorBytes $programParent $env:ProgramData
        Assert ($script:stopCalls -eq 1 -and $recovered.service.ProcessId -eq 1235 -and $script:aclRepairs.Count -eq 4) 'Unbound bundled SSH service did not repair and recover'
        Assert ((Get-FileHash -LiteralPath $privatePath).Hash -eq $privateHash) 'Repair changed the original private key bytes'
        $script:privateKeyAcls[$privatePath]=Security $false $false
        $script:fakeCommand.exe=Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
        $null=EnsureReachSshd $vendorBytes $programParent $env:ProgramData
        Assert ($script:stopCalls -eq 1 -and $script:aclRepairs.Count -eq 4) 'External SSH service or its key was changed'
        $script:fakeCommand=$null
        [IO.File]::WriteAllText($config,'# Existing operator configuration')
        $null=EnsureReachSshd $vendorBytes $programParent $env:ProgramData
        Assert ([IO.File]::ReadAllText($config) -ceq '# Existing operator configuration') 'Retry replaced an existing SSH configuration'
        Assert ($script:serviceCreations -eq 2) 'Retry did not complete SSH service registration'
        $script:listenerMode='foreign'
        Refused { WaitReachSshListener 0 } 'another process.*listener PIDs=4567'
        $script:listenerMode='other-port'
        Refused { WaitReachSshListener 0 } 'did not listen on TCP port 22'
        $script:listenerMode='query-error'
        Refused { WaitReachSshListener 0 } 'Could not query TCP port 22.*fixture TCP query failed'
        $script:listenerMode='delayed'
        $script:fakeCommand.service.State='Stopped'
        $script:fakeCommand.service.ProcessId=0
        $script:fakeCommand.service.ExitCode=1067
        Refused { WaitReachSshListener 0 } 'state=Stopped, service PID=0, exit code=1067'
        $script:fakeCommand=$null
        Refused { EnsureReachSshd ([byte[]]@(1,2,3)) $programParent $env:ProgramData } 'payload hash mismatch'
    }
    Write-Output 'PASS vendor payload, native sshd -T, default key ACL repair and byte preservation, clean install and retry, managed service recovery, healthy and external reuse, listener diagnostics. SCM/ACL mutations use adapters.'
} finally {
    $env:USERNAME=$originalUser
    $env:ProgramFiles=$originalProgramFiles
    $env:ProgramData=$originalProgramData
    # Only this uniquely generated test directory is removed.
    $resolvedRoot=[IO.Path]::GetFullPath($root)
    if (-not $resolvedRoot.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup path escaped TEMP' }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
