# Copyright (c) Ray Zhang. Account lookup, effective configuration and isolated payload checks.
param([string]$OpenSshArchive)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../packaging/windows/ssh.ps1')
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
        # Native tools, service control, ACL and port enumeration are explicit adapters.
        $env:ProgramFiles=Join-Path $root 'programs';$env:ProgramData=Join-Path $root 'data'
        $null=New-Item -ItemType Directory -Path $env:ProgramFiles,$env:ProgramData
        $script:fakeCommand=$null;$script:nativeCalls=@();$script:serviceCreations=0
        function Hash([byte[]]$Bytes) { $h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()} }
        function Directory([string]$Path,[bool]$Public) { $null=[IO.Directory]::CreateDirectory($Path) }
        function CheckPath([string]$Path) { Assert (Test-Path -LiteralPath $Path) 'Checked path missing' }
        function WriteFile([string]$Path,[byte[]]$Bytes,[bool]$Public) { [IO.File]::WriteAllBytes($Path,$Bytes) }
        function GetReachSshCommand { return $script:fakeCommand }
        function InvokeReachSshProgram([string]$Executable,[string[]]$Arguments,[string]$Failure) { $script:nativeCalls+=@{exe=$Executable;arguments=$Arguments} }
        function New-Service($Name,$DisplayName,$BinaryPathName,$StartupType) {
            $script:serviceCreations++
            $script:fakeCommand=@{exe=$BinaryPathName.Trim('"');configArgs=@();service=@{ProcessId=1234}}
        }
        function Set-Service($Name,$StartupType) { Assert ($StartupType -ceq 'Automatic') 'sshd autostart missing' }
        function Start-Service($Name) { $script:serviceStarted=$true }
        function Get-Service($Name) { $s=[pscustomobject]@{Status='Stopped'};$s|Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value {param($Status,$Timeout)};return $s }
        function Get-NetTCPConnection($State,$LocalPort,$ErrorAction) { return @{OwningProcess=1234} }
        $vendorBytes=[IO.File]::ReadAllBytes($payload)
        $installed=EnsureReachSshd $vendorBytes
        Assert ($script:serviceCreations -eq 1 -and $script:serviceStarted) 'Default sshd was not registered and started'
        Assert ([IO.File]::Exists($installed.exe)) 'Vendor executable was not staged'
        Assert ([IO.File]::Exists((Join-Path $env:ProgramData 'ssh\sshd_config'))) 'Default configuration was not prepared'
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
        $null=EnsureReachSshd $vendorBytes
        Assert ($script:serviceCreations -eq 1) 'Existing shared sshd was replaced'
        $script:fakeCommand=$null
        Refused { EnsureReachSshd ([byte[]]@(1,2,3)) } 'payload hash mismatch'
    }
    Write-Output 'PASS binding-owner identity, service-account rejection, user profile, custom -f/Match, admin/multiple keys, vendor provenance, native sshd -T and adapted clean install. SCM installation not exercised.'
} finally {
    $env:USERNAME=$originalUser
    $env:ProgramFiles=$originalProgramFiles
    $env:ProgramData=$originalProgramData
    # Only this uniquely generated test directory is removed.
    $resolvedRoot=[IO.Path]::GetFullPath($root)
    if (-not $resolvedRoot.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup path escaped TEMP' }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
