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

function InvokeReachSshProgram([string]$Executable,[string[]]$Arguments,[string]$Failure) {
    & $Executable @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function EnsureReachSshd([byte[]]$Archive) {
    $command=GetReachSshCommand
    $destination=Join-Path $env:ProgramFiles 'RY\OpenSSH-10.0.0.0p2'
    if (-not $command) {
        if ((Hash $Archive) -cne '23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5') { throw 'Offline OpenSSH payload hash mismatch' }
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
                } else { WriteFile $target $bytes $true }
            }
        } finally { $zip.Dispose(); $stream.Dispose() }
        $sshData=Join-Path $env:ProgramData 'ssh'
        if (-not (Test-Path -LiteralPath $sshData)) { Directory $sshData $false } else { CheckPath $sshData }
        $config=Join-Path $sshData 'sshd_config'
        if (-not [IO.File]::Exists($config)) { WriteFile $config ([IO.File]::ReadAllBytes((Join-Path $destination 'sshd_config_default'))) $false }
        InvokeReachSshProgram (Join-Path $destination 'ssh-keygen.exe') @('-A') 'OpenSSH host key generation failed'
        $exe=Join-Path $destination 'sshd.exe'
        InvokeReachSshProgram $exe @('-t') 'OpenSSH configuration check failed'
        # Register only sshd. The vendor install script also replaces ssh-agent.
        New-Service -Name sshd -DisplayName 'OpenSSH SSH Server' -BinaryPathName ('"'+$exe+'"') -StartupType Automatic | Out-Null
        $command=GetReachSshCommand
    }
    if ($command.exe -ieq (Join-Path $destination 'sshd.exe')) {
        InvokeReachSshProgram (Join-Path $env:SystemRoot 'System32\sc.exe') @('privs','sshd','SeAssignPrimaryTokenPrivilege/SeTcbPrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege') 'Cannot set shared sshd service privileges'
    }
    $configArgs=$command.configArgs
    InvokeReachSshProgram $command.exe (@('-t')+$configArgs) 'Existing sshd configuration is invalid'
    Set-Service -Name sshd -StartupType Automatic
    $service=Get-Service -Name sshd
    if ($service.Status -ne 'Running') { Start-Service -Name sshd }
    $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
    $command=GetReachSshCommand
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $command.service.ProcessId })
    if ($listeners.Count -eq 0) { throw 'sshd is not listening on port 22' }
    return $command
}
