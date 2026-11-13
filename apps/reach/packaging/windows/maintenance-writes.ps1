# Copyright (c) Ray Zhang. Atomic metadata writes with explicit temporary-file attribution.
# The already-held canonical install.lock is an append-only intent log. No second
# journal owns installation phases; these entries only prove reserved temp paths.
function AssertReachWriteTarget([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path)
    $allowed=@((Join-Path $dataParent 'Reach.installation.json'),(Join-Path $dataParent 'Reach.maintenance/uninstall.ps1'),(Join-Path $root 'bin/reach.exe'))
    foreach($name in (ReachRetainedMetadata)){
        if($name-cne'install.lock'){$allowed+=@(Join-Path $root $name)}
    }
    if($full-cne$Path -or $full-cnotin$allowed){throw 'Atomic write target is outside owned maintenance paths'}
}
function ReadReachWriteIntents {
    if($installLock.Length-gt16777216){throw 'Maintenance write-intent log exceeds the bound'}
    $bytes=[byte[]]::new([int]$installLock.Length);$installLock.Position=0;$offset=0
    while($offset-lt$bytes.Length){$n=$installLock.Read($bytes,$offset,$bytes.Length-$offset);if($n-le0){throw 'Truncated maintenance write-intent stream'};$offset+=$n}
    $header=[Text.Encoding]::ASCII.GetBytes("RY.Reach.WriteIntents/1`n")
    for($i=0;$i-lt[Math]::Min($bytes.Length,$header.Length);$i++){if($bytes[$i]-ne$header[$i]){throw 'Unrecognized canonical installation lock contents'}}
    if($bytes.Length-lt$header.Length){return @{entries=@();validBytes=0;totalBytes=$bytes.Length}}
    $end=$bytes.Length
    while($end-gt0 -and $bytes[$end-1]-ne10){$end--}
    # No temp is created before its complete intent and newline are flushed.
    # A partial trailing append therefore grants no ownership and may be trimmed.
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes,$header.Length,$end-$header.Length)
    $entries=@();$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($line in $text.Split("`n")){
        if($line.Length-eq0){continue}
        $entry=$line|ConvertFrom-Json
        if($entry.schema-ne1 -or $entry.operation-cne'atomic-write' -or $entry.root-cne$root -or $entry.bytes-isnot[int] -or
            $entry.bytes-lt0 -or $entry.bytes-gt536870912 -or $entry.sha256-cnotmatch'^[0-9a-f]{64}$'){throw 'Invalid maintenance write intent'}
        AssertReachWriteTarget $entry.target
        if($entry.temporary-cnotmatch('^'+[regex]::Escape($entry.target)+'\.new-[0-9a-f]{32}$') -or -not $seen.Add($entry.temporary)){throw 'Invalid or duplicate temporary file attribution'}
        $entries+=@($entry)
    }
    return @{entries=$entries;validBytes=$end;totalBytes=$bytes.Length}
}
function RecoverReachAtomicWrites {
    $log=ReadReachWriteIntents
    foreach($entry in $log.entries){
        if(Test-Path -LiteralPath $entry.temporary){
            $parent=[IO.Path]::GetDirectoryName($entry.temporary)
            CheckPath $parent;CheckPath $entry.temporary
            if((Get-Item -LiteralPath $entry.temporary -Force).PSIsContainer){throw 'Reserved temporary file became a directory'}
            # It may be partially written. Ownership follows the flushed intent,
            # not a filename suffix or a successful content hash.
            [IO.File]::Delete($entry.temporary)
        }
    }
    # Every attributed temp is now absent. Retire their intents under the same
    # still-held lock, so completed writes do not consume an installation lifetime
    # quota. Interrupted retirement is safe: no temp still needs these records.
    foreach($entry in $log.entries){if(Test-Path -LiteralPath $entry.temporary){throw 'Attributed temporary file remains after recovery'}}
    $installLock.SetLength(0);$installLock.Flush($true);$installLock.Position=0
}
function ReserveReachAtomicWrite([string]$Path,[byte[]]$Bytes) {
    AssertReachWriteTarget $Path
    RecoverReachAtomicWrites
    if($installLock.Length-eq0){$header=[Text.Encoding]::ASCII.GetBytes("RY.Reach.WriteIntents/1`n");$installLock.Write($header,0,$header.Length);$installLock.Flush($true)}
    $temporary=$Path+'.new-'+[Guid]::NewGuid().ToString('N')
    if(Test-Path -LiteralPath $temporary){throw 'Unowned temporary write path already exists'}
    $entry=@{schema=1;operation='atomic-write';root=$root;target=$Path;temporary=$temporary;bytes=$Bytes.Length;sha256=(Hash $Bytes)}
    $line=[Text.UTF8Encoding]::new($false).GetBytes(($entry|ConvertTo-Json -Compress)+"`n")
    if($installLock.Length+$line.Length-gt16777216){throw 'Maintenance write-intent log exceeds the bound'}
    $installLock.Position=$installLock.Length;$installLock.Write($line,0,$line.Length);$installLock.Flush($true)
    return $temporary
}
function WriteReachAtomicFile([string]$Path,[byte[]]$Bytes,[bool]$Public=$false) {
    CheckPath ([IO.Path]::GetDirectoryName($Path))
    if(Test-Path -LiteralPath $Path){CheckPath $Path;if((Get-Item -LiteralPath $Path -Force).PSIsContainer){throw 'Atomic write target is a directory'}}
    $temporary=ReserveReachAtomicWrite $Path $Bytes
    $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(Security $false $Public))
    try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    # WinPS 5.1 coerces $null to an empty string for this overload. NullString
    # passes an actual CLR null (no backup), otherwise Replace rejects the path.
    if([IO.File]::Exists($Path)){[IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($temporary,$Path)}
    CheckPath $Path
}
function WriteReachStagedFile([string]$Path,[byte[]]$Bytes) {
    # This exact path was reserved in deployment.groups before stage creation.
    CheckPath ([IO.Path]::GetDirectoryName($Path))
    $stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(Security $false $true))
    try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    CheckPath $Path
}
