# Copyright (c) Ray Zhang. Pure removal planning; the host supplies trusted ACL and PATH access.
# These functions never stop services, infer ownership from directory names, or remove state.
function ReachRemovalRoot([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    if($Path-notmatch'^[A-Za-z]:[\\/]' -or $full.Length-lt4){throw 'Removal requires an absolute product directory'}
    return $full
}
function ReachRemovalFile([string]$Root,[string]$Relative) {
    [void](ReachRelativePath $Relative)
    $full=[IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if(-not $full.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Removal path escaped the product directory'}
    return $full
}
function ReachRemovalHash([string]$Path) {
    $file=Get-Item -LiteralPath $Path -Force
    if($file.PSIsContainer){throw 'Expected an owned file, found a directory'}
    $stream=[IO.File]::OpenRead($Path)
    try{return ReachHashStream $stream $file.Length}finally{$stream.Dispose()}
}
function NewReachDeletionPlan([string]$Root,[string[]]$OwnedFiles,[string[]]$RetainedFiles) {
    $base=ReachRemovalRoot $Root;CheckPath $base
    $owned=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $retained=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $directories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($collection in @(@{paths=$OwnedFiles;set=$owned},@{paths=$RetainedFiles;set=$retained})){
        foreach($relative in $collection.paths){
            [void](ReachRemovalFile $base $relative)
            if(-not $collection.set.Add($relative)){throw 'Duplicate removal ownership entry'}
            $parts=$relative.Split('/')
            for($i=1;$i-lt$parts.Length;$i++){[void]$directories.Add(($parts[0..($i-1)]-join'/'))}
        }
    }
    foreach($relative in $owned){if($retained.Contains($relative)){throw 'A retained file cannot be removed'}}
    $queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($base)
    while($queue.Count){
        $directory=$queue.Dequeue()
        foreach($item in (Get-ChildItem -LiteralPath $directory -Force)){
            CheckPath $item.FullName
            $relative=$item.FullName.Substring($base.Length+1).Replace('\','/')
            if($item.PSIsContainer){
                if(-not $directories.Contains($relative)){throw "Unrecognized directory prevents removal: $relative"}
                $queue.Enqueue($item.FullName)
            }elseif(-not $owned.Contains($relative) -and -not $retained.Contains($relative)){
                throw "Unrecognized file prevents removal: $relative"
            }
        }
    }
    $files=@()
    foreach($relative in ($owned|Sort-Object)){
        $full=ReachRemovalFile $base $relative
        if([IO.File]::Exists($full)){
            CheckPath $full;$info=Get-Item -LiteralPath $full -Force
            $files+=@{path=$relative;existed=$true;bytes=$info.Length;sha256=(ReachRemovalHash $full)}
        }else{$files+=@{path=$relative;existed=$false;bytes=0;sha256=$null}}
    }
    return @{schema=1;root=$base;files=$files;retainedFiles=@($RetainedFiles);directories=@($directories|Sort-Object)}
}
function AssertReachDeletionPlan($Plan,[string]$ExpectedRoot) {
    $base=ReachRemovalRoot $ExpectedRoot
    if($Plan.schema-ne1 -or $Plan.root-cne$base -or $Plan.files-isnot[array] -or $Plan.retainedFiles-isnot[array] -or $Plan.directories-isnot[array]){throw 'Invalid removal journal plan'}
    CheckPath $base
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $retained=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $expectedDirectories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($relative in $Plan.retainedFiles){[void](ReachRemovalFile $base $relative);if(-not $retained.Add($relative)){throw 'Duplicate retained path'}}
    foreach($file in $Plan.files){
        [void](ReachRemovalFile $base $file.path)
        if(-not $seen.Add($file.path) -or $retained.Contains($file.path) -or $file.existed-isnot[bool]){throw 'Invalid removal file identity'}
        if($file.existed -and (($file.bytes-isnot[int] -and $file.bytes-isnot[long]) -or $file.bytes-lt0 -or $file.sha256-notmatch'^[0-9a-f]{64}$')){throw 'Invalid removal file digest'}
        if(-not $file.existed -and ($file.bytes-ne0 -or $null-ne$file.sha256)){throw 'Invalid missing removal file identity'}
    }
    foreach($relative in (@($seen)+@($retained))){
        $parts=$relative.Split('/')
        for($i=1;$i-lt$parts.Length;$i++){[void]$expectedDirectories.Add(($parts[0..($i-1)]-join'/'))}
    }
    foreach($relative in $expectedDirectories){if($seen.Contains($relative) -or $retained.Contains($relative)){throw 'Removal file and directory conflict'}}
    $declaredDirectories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($relative in $Plan.directories){
        [void](ReachRemovalFile $base $relative)
        if(-not $declaredDirectories.Add($relative)){throw 'Duplicate removal directory'}
    }
    if(-not $expectedDirectories.SetEquals($declaredDirectories)){throw 'Removal directory set differs from owned and retained file parents'}
    return $base
}
function AssertReachRemovalInventory($Plan,[string]$Root) {
    $allowedFiles=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($file in $Plan.files){[void]$allowedFiles.Add($file.path)}
    foreach($relative in $Plan.retainedFiles){[void]$allowedFiles.Add($relative)}
    $allowedDirectories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($relative in $Plan.directories){[void]$allowedDirectories.Add($relative)}
    $queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($Root)
    while($queue.Count){
        $directory=$queue.Dequeue();CheckPath $directory
        foreach($item in (Get-ChildItem -LiteralPath $directory -Force)){
            CheckPath $item.FullName
            $relative=$item.FullName.Substring($Root.Length+1).Replace('\','/')
            if($item.PSIsContainer){
                if(-not $allowedDirectories.Contains($relative)){throw "Unrecognized directory prevents removal: $relative"}
                $queue.Enqueue($item.FullName)
            }elseif(-not $allowedFiles.Contains($relative)){throw "Unrecognized file prevents removal: $relative"}
        }
    }
}
function InvokeReachDeletionPlan($Plan,[string]$ExpectedRoot) {
    $base=AssertReachDeletionPlan $Plan $ExpectedRoot
    AssertReachRemovalInventory $Plan $base
    # The caller persists the whole plan while holding both maintenance locks.
    # Missing files are expected after interruption; changed/new files are not.
    foreach($file in $Plan.files){
        $path=ReachRemovalFile $base $file.path
        $parent=[IO.Path]::GetDirectoryName($path)
        while($parent.Length-gt$base.Length){if(Test-Path -LiteralPath $parent){CheckPath $parent};$parent=[IO.Path]::GetDirectoryName($parent)}
        if(Test-Path -LiteralPath $path){
            CheckPath $path
            if(-not $file.existed -or (Get-Item -LiteralPath $path -Force).PSIsContainer){throw 'Unexpected replacement at an owned file path'}
            $info=Get-Item -LiteralPath $path -Force
            if($info.Length-ne$file.bytes -or (ReachRemovalHash $path)-cne$file.sha256){throw "Owned file changed after removal was planned: $($file.path)"}
            [IO.File]::Delete($path)
        }
    }
    $retainedParents=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($relative in $Plan.retainedFiles){$parts=$relative.Split('/');for($i=1;$i-lt$parts.Length;$i++){[void]$retainedParents.Add(($parts[0..($i-1)]-join'/'))}}
    foreach($relative in ($Plan.directories|Sort-Object Length -Descending)){
        if($retainedParents.Contains($relative)){continue}
        $path=ReachRemovalFile $base $relative
        if(Test-Path -LiteralPath $path){
            CheckPath $path
            if(@([IO.Directory]::GetFileSystemEntries($path)).Count){throw "Unrecognized remaining content prevents directory removal: $relative"}
            # Never recursive: an unexpected entry cannot be swept into removal.
            [IO.Directory]::Delete($path,$false)
        }
    }
    # Retained installation metadata and the canonical legacy lock remain in root.
    foreach($file in $Plan.files){if(Test-Path -LiteralPath (ReachRemovalFile $base $file.path)){throw 'Owned program file still exists'}}
    AssertReachRemovalInventory $Plan $base
}
function RemoveReachOwnedPath($Ownership,[string]$ExpectedBinPath) {
    if($null-eq$Ownership){return @{changed=$false;disposition='not_owned'}}
    if($Ownership.applied-isnot[bool]){throw 'Invalid PATH ownership applied flag'}
    if(-not $Ownership.applied){return @{changed=$false;disposition='not_owned'}}
    $ownedBin=ReachRemovalRoot $ExpectedBinPath
    if($ownedBin-cne$ExpectedBinPath -or $Ownership.before.exists-isnot[bool] -or $Ownership.before.kind-isnot[int] -or
        $Ownership.before.kind-notin@(1,2) -or $Ownership.before.raw-isnot[string] -or $Ownership.after-isnot[string] -or
        (-not $Ownership.before.exists -and $Ownership.before.raw-cne'')){throw 'Invalid PATH ownership record'}
    $expectedAfter=if($Ownership.before.raw.Length){$Ownership.before.raw+';'+$ownedBin}else{$ownedBin}
    if($Ownership.after-cne$expectedAfter){throw 'PATH ownership does not describe this installation addition'}
    $now=PathSnapshot
    if($now.exists-eq$Ownership.before.exists -and $now.kind-eq$Ownership.before.kind -and $now.raw-ceq$Ownership.before.raw){return @{changed=$false;disposition='already_restored'}}
    if($now.exists -and $now.kind-eq$Ownership.before.kind -and $now.raw-ceq$Ownership.after){
        if($Ownership.before.exists){$environment.SetValue('Path',$Ownership.before.raw,[Microsoft.Win32.RegistryValueKind]$Ownership.before.kind)}else{$environment.DeleteValue('Path',$false)}
        NotifyEnvironment
        return @{changed=$true;disposition='removed'}
    }
    # A later external edit makes attribution ambiguous; preserve it byte-for-byte.
    return @{changed=$false;disposition='retained_ambiguous'}
}
