# Copyright (c) Ray Zhang. Shared OpenSSH preparation and binding-owner identity.
# The offline payload and endpoint lookup follow Starferry's reviewed Windows adapter.
function ResolveReachSshAccount([string]$OwnerSid) {
    if ($OwnerSid -notmatch '^S-1-[0-9-]+$' -or $OwnerSid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) {
        throw 'SSH requires the installation binding owner, not a Windows service account'
    }
    $account = [Security.Principal.SecurityIdentifier]::new($OwnerSid).Translate([Security.Principal.NTAccount]).Value
    $parts = $account.Split('\',2)
    $user = if ($parts.Length -eq 2 -and $parts[0] -ieq $env:COMPUTERNAME) { $parts[1] } else { $account }
    $profile = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$OwnerSid" -ErrorAction SilentlyContinue
    $homePath = if ($profile) { [Environment]::ExpandEnvironmentVariables($profile.ProfileImagePath) } else { '' }
    return @{user=$user.ToLowerInvariant(); sid=$OwnerSid; profile=$homePath}
}

function GetReachSshCommand {
    $service = Get-CimInstance Win32_Service -Filter "Name='sshd'"
    if (-not $service) { return $null }
    $path = $service.PathName.Trim()
    if ($path -match '^"([^"]+)"\s*(.*)$') { $exe=$Matches[1]; $tail=$Matches[2] }
    elseif ($path -match '^(\S+\.exe)\s*(.*)$') { $exe=$Matches[1]; $tail=$Matches[2] }
    else { throw 'Cannot determine the existing sshd executable path' }
    $configArgs = @()
    if ($tail) {
        if ($tail -match '^-f\s+"([^"]+)"$' -or $tail -match '^-f\s+([^\s"]+)$') { $configArgs=@('-f',$Matches[1]) }
        else { throw 'Existing sshd service arguments require manual configuration' }
    }
    return @{exe=$exe; configArgs=$configArgs; service=$service}
}

function ResolveReachSshTarget([string]$OwnerSid, $Command) {
    $account = ResolveReachSshAccount $OwnerSid
    if ($account.user.Length -gt 128 -or $account.user -match '[,=\x00-\x1f"]') { throw 'Invalid SSH login user' }
    $configArgs=$Command.configArgs
    $settings = @(& $Command.exe -T @configArgs -C "user=$($account.user),host=127.0.0.1,addr=127.0.0.1,laddr=127.0.0.1,lport=22" 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot evaluate sshd configuration for the installation binding owner' }
    if ($settings -contains 'usedns yes') { throw 'UseDNS-dependent SSH matching requires manual configuration' }
    $keys = @($settings | Where-Object { $_ -like 'authorizedkeysfile *' })
    if ($keys.Count -ne 1) { throw 'Cannot determine AuthorizedKeysFile' }
    $paths = @([regex]::Matches($keys[0].Substring(19), '"([^"]+)"|(\S+)') | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } })
    if ($paths.Count -eq 0 -or $paths[0] -eq 'none') { throw 'Disabled AuthorizedKeysFile requires manual configuration' }
    # OpenSSH checks every configured file. Manage the first and leave the others intact.
    $keyPath = $paths[0].Replace('__PROGRAMDATA__',$env:ProgramData).Replace('%u',$account.user).Replace('%h',$account.profile).Replace('/','\')
    if ($keyPath.Contains('%')) { throw 'Unsupported AuthorizedKeysFile expansion' }
    if (-not [IO.Path]::IsPathRooted($keyPath)) {
        if (-not $account.profile) { throw 'SSH login user has no initialized Windows profile' }
        $keyPath=Join-Path $account.profile $keyPath
    }
    if ($paths[0].Contains('%h') -and -not $account.profile) { throw 'SSH login user has no initialized Windows profile' }
    $keyPath=[IO.Path]::GetFullPath($keyPath)
    $hostKey=$null
    foreach ($setting in $settings) {
        if ($setting -like 'hostkey *') {
            $hostFile=$setting.Substring(8).Trim('"').Replace('__PROGRAMDATA__',$env:ProgramData).Replace('/','\')
            if ([IO.File]::Exists($hostFile+'.pub')) {
                $candidate=[IO.File]::ReadAllText($hostFile+'.pub').Trim()
                if ($candidate -like 'ssh-ed25519 *') { $hostKey=$candidate; break }
            }
        }
    }
    if (-not $hostKey) { throw 'No configured Ed25519 host public key file found' }
    return @{user=$account.user; sid=$account.sid; authorizedKeysPath=$keyPath; hostKey=$hostKey; sharedAdminKeys=($keyPath -ieq (Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'))}
}

function InitializeReachSshKeys($Target) {
    $path=$Target.authorizedKeysPath
    $parent=Split-Path -Parent $path
    $cursor=$path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SSH authorization path contains a reparse point' }
        }
        $next=Split-Path -Parent $cursor
        if ($next -eq $cursor) { break }
        $cursor=$next
    }
    $allowed=@('S-1-5-18','S-1-5-32-544')
    if (-not $Target.sharedAdminKeys) { $allowed+=@($Target.sid) }
    foreach ($entry in @(@{path=$parent;directory=$true},@{path=$path;directory=$false})) {
        if (Test-Path -LiteralPath $entry.path) { continue }
        if ($entry.directory) { $null=New-Item -ItemType Directory -Path $entry.path -Force }
        else { [IO.File]::WriteAllBytes($entry.path,[byte[]]@()) }
        $acl=if ($entry.directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
        $acl.SetAccessRuleProtection($true,$false)
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        foreach ($sid in $allowed) {
            $identity=[Security.Principal.SecurityIdentifier]::new($sid)
            $rule=if ($entry.directory) { [Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow') }
                else { [Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow') }
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $entry.path -AclObject $acl
    }
    $existing=Get-Acl -LiteralPath $path
    foreach ($rule in $existing.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'Existing authorized_keys permissions require manual review' }
    }
}

function InvokeReachSshProgram([string]$Executable,[string[]]$Arguments,[string]$Failure,[int[]]$AllowedExitCodes=@(0)) {
    & $Executable @Arguments | Out-Null
    if ($LASTEXITCODE -notin $AllowedExitCodes) { throw "$Failure (exit code $LASTEXITCODE)" }
}

function WaitReachSshListener([int]$TimeoutSeconds=6,[string]$RecoverableExecutable) {
    # Win32 OpenSSH reports SERVICE_RUNNING before the server binds its sockets.
    $clock=[Diagnostics.Stopwatch]::StartNew()
    do {
        $command=GetReachSshCommand
        $state=if ($command) { $command.service.State } else { 'Missing' }
        $serviceProcessId=if ($command) { [int]$command.service.ProcessId } else { 0 }
        $exitCode=if ($command) { [int]$command.service.ExitCode } else { 0 }
        $owners=@()
        $probeError=$null
        try {
            $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop)
            $owners=@($listeners |
                Where-Object { $_.LocalPort -eq 22 } |
                Select-Object -ExpandProperty OwningProcess -Unique)
        } catch {
            $probeError=$_.Exception.Message
        }
        if ($state -eq 'Running' -and $serviceProcessId -gt 0 -and $owners -contains $serviceProcessId) { return $command }
        if ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) { Start-Sleep -Milliseconds 250 }
    } while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds)

    $status="state=$state, service PID=$serviceProcessId, exit code=$exitCode"
    if ($probeError) { throw "Could not query TCP port 22 ($status): $probeError" }
    if ($state -ne 'Running' -or $serviceProcessId -le 0) { throw "sshd is not running with a valid PID ($status)" }
    if ($owners.Count) { throw "TCP port 22 is listening under another process ($status, listener PIDs=$($owners -join ', '))" }
    if ($RecoverableExecutable -and $command.exe -ieq $RecoverableExecutable -and $command.service.StartName -ieq 'LocalSystem' -and
        -not $command.configArgs.Count -and -not ($listeners | Where-Object OwningProcess -eq $serviceProcessId)) {
        $command.restartRequired=$true
        return $command
    }
    throw "sshd did not listen on TCP port 22 within $TimeoutSeconds seconds ($status)"
}

# Shared OpenSSH files stay outside the Reach installation journal.
# A new file becomes visible only after its contents and ACL are ready.
function WriteReachSshPrerequisite([string]$Path,[byte[]]$Bytes,[bool]$Public) {
    $parent=[IO.Path]::GetDirectoryName($Path)
    CheckPath $parent
    $temporary=Join-Path $parent ('.reach-ssh-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    $file=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(Security $false $Public))
    try {
        try { $file.Write($Bytes,0,$Bytes.Length); $file.Flush($true) }
        finally { $file.Dispose() }
        [IO.File]::Move($temporary,$Path)
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
    CheckPath $Path
}

function RepairReachSshHostKeyPermissions([string]$SshData) {
    CheckPath $SshData
    $allowed=@('S-1-5-18','S-1-5-32-544')
    foreach ($name in @('ssh_host_rsa_key','ssh_host_ecdsa_key','ssh_host_ed25519_key')) {
        $path=Join-Path $SshData $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $item=Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsupported SSH host key path: $path" }
        $acl=Get-Acl -LiteralPath $path
        $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
        $foreignAccess=$rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed }
        $readRules=$rules | Where-Object { ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0 }
        $readers=@($readRules | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Value })
        $trustedDeny=$readRules | Where-Object { $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -in $allowed }
        if ($owner -notin $allowed -or $foreignAccess -or $trustedDeny -or ($allowed | Where-Object { $_ -notin $readers })) {
            Set-Acl -LiteralPath $path -AclObject (Security $false $false)
            CheckPath $path
        }
    }
}

function StopReachUnboundSshd($Command,$Service) {
    $serviceProcessId=[int]$Command.service.ProcessId
    $process=Get-Process -Id $serviceProcessId -ErrorAction Stop
    $current=GetReachSshCommand
    if ($process.Path -ine $Command.exe -or $current.exe -ine $Command.exe -or $current.service.ProcessId -ne $serviceProcessId -or
        $current.service.State -ne 'Running' -or $current.service.StartName -ine 'LocalSystem' -or $current.configArgs.Count) {
        throw 'Bundled sshd changed before recovery'
    }
    $connections=Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $serviceProcessId -or ($_.LocalPort -eq 22 -and $_.State -eq 'Listen') }
    $children=Get-CimInstance Win32_Process -Filter "ParentProcessId=$serviceProcessId" -ErrorAction Stop
    if ($connections -or $children) { throw 'Bundled sshd or TCP port 22 became active before recovery' }
    InvokeReachSshProgram (Join-Path $env:SystemRoot 'System32\sc.exe') @('stop','sshd') 'Cannot stop unbound bundled sshd' @(0,109,1062)
    $Service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15))
    if (-not $process.WaitForExit(8000)) { throw "Earlier bundled sshd process $serviceProcessId did not exit" }
}

function AssertReachOfflineSshArchive([byte[]]$Archive) {
    if ((Hash $Archive) -cne '23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5') { throw 'Offline OpenSSH payload hash mismatch' }
}

function EnsureReachSshd([byte[]]$Archive,[string]$ProgramParent,[string]$DataAnchor) {
    $command=GetReachSshCommand
    $destination=Join-Path $ProgramParent 'OpenSSH-10.0.0.0p2'
    $bundledSshd=Join-Path $destination 'sshd.exe'
    $sshData=Join-Path $DataAnchor 'ssh'
    if (-not $command) {
        AssertReachOfflineSshArchive $Archive
        Add-Type -AssemblyName System.IO.Compression
        $stream=[IO.MemoryStream]::new($Archive,$false)
        $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read,$false)
        try {
            Directory $destination $true
            foreach ($entry in $zip.Entries) {
                $name=$entry.FullName.Replace('\','/')
                if ($name.EndsWith('/')) { continue }
                if (-not $name.StartsWith('OpenSSH-Win64/',[StringComparison]::Ordinal)) { throw 'Unexpected OpenSSH archive root' }
                $relative=$name.Substring(14)
                if (-not $relative -or $relative.Contains(':') -or $relative.Split('/') -contains '..') { throw 'Unexpected OpenSSH archive path' }
                $parent=$destination
                $parts=$relative.Split('/')
                for ($index=0; $index -lt $parts.Length-1; $index++) {
                    $parent=Join-Path $parent $parts[$index]
                    Directory $parent $true
                }
                $target=Join-Path $destination $relative
                $input=$entry.Open(); $output=[IO.MemoryStream]::new()
                try { $input.CopyTo($output); $bytes=$output.ToArray() } finally { $output.Dispose(); $input.Dispose() }
                if ([IO.File]::Exists($target)) {
                    CheckPath $target
                    if ((Hash ([IO.File]::ReadAllBytes($target))) -cne (Hash $bytes)) { throw 'Existing shared OpenSSH payload differs' }
                } else { WriteReachSshPrerequisite $target $bytes $true }
            }
        } finally { $zip.Dispose(); $stream.Dispose() }
        if (-not (Test-Path -LiteralPath $sshData)) { Directory $sshData $false } else { CheckPath $sshData }
        $config=Join-Path $sshData 'sshd_config'
        if ([IO.File]::Exists($config)) { CheckPath $config }
        else { WriteReachSshPrerequisite $config ([IO.File]::ReadAllBytes((Join-Path $destination 'sshd_config_default'))) $false }
        InvokeReachSshProgram (Join-Path $destination 'ssh-keygen.exe') @('-A') 'OpenSSH host key generation failed'
        RepairReachSshHostKeyPermissions $sshData
        InvokeReachSshProgram $bundledSshd @('-t') 'OpenSSH configuration check failed'
        # Register only sshd. The vendor install script also replaces ssh-agent.
        New-Service -Name sshd -DisplayName 'OpenSSH SSH Server' -BinaryPathName ('"'+$bundledSshd+'"') -StartupType Automatic | Out-Null
        $command=GetReachSshCommand
    } elseif ($command.exe -ieq $bundledSshd -and $command.service.StartName -ieq 'LocalSystem' -and -not $command.configArgs.Count) {
        RepairReachSshHostKeyPermissions $sshData
    }
    if ($command.exe -ieq $bundledSshd -and $command.service.StartName -ieq 'LocalSystem' -and -not $command.configArgs.Count) {
        InvokeReachSshProgram (Join-Path $env:SystemRoot 'System32\sc.exe') @('privs','sshd','SeAssignPrimaryTokenPrivilege/SeTcbPrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege') 'Cannot set shared sshd service privileges'
        Set-Service -Name sshd -StartupType Automatic
    }
    $configArgs=$command.configArgs
    InvokeReachSshProgram $command.exe (@('-t')+$configArgs) 'Existing sshd configuration is invalid'
    $service=Get-Service -Name sshd
    if ($service.Status -eq 'Running') {
        $ready=WaitReachSshListener -RecoverableExecutable $bundledSshd
        if (-not $ready.restartRequired) { return $ready }
        StopReachUnboundSshd $ready $service
    }
    Start-Service -Name sshd
    $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
    return WaitReachSshListener
}
