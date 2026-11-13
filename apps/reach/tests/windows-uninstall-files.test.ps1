# Copyright (c) Ray Zhang. Actual isolated file/registry effects; no service or production ACL changes.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../packaging/windows/payload.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/uninstall-files.ps1')
function CheckPath([string]$Path){$item=Get-Item -LiteralPath $Path -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Reparse refused by test host'}}
function Assert([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Refused([scriptblock]$Action,[string]$Pattern){$failed=$false;try{&$Action|Out-Null}catch{$failed=$true;Assert ($_.Exception.Message-match$Pattern) $_.Exception.Message};Assert $failed "Expected $Pattern"}
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidence=Join-Path $project ('work/uninstall-files-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($evidence)
$script:cases=0
function Case([string]$Name,[scriptblock]$Action){&$Action;$script:cases++;Write-Output "PASS $Name"}
function Fixture {
    $root=Join-Path $evidence ([Guid]::NewGuid().ToString('N'))
    $owned=@('bin/reach.exe','versions/reviewed/python/python.exe','versions/reviewed/python/config.toml')
    $retained=@('install.lock','install.json')
    foreach($path in ($owned+$retained)){$full=Join-Path $root $path;$null=[IO.Directory]::CreateDirectory((Split-Path $full));[IO.File]::WriteAllText($full,$path)}
    return @{root=$root;owned=$owned;retained=$retained}
}
Case 'known program files removed and only declared metadata retained' {
    $f=Fixture;$plan=NewReachDeletionPlan $f.root $f.owned $f.retained
    InvokeReachDeletionPlan $plan $f.root
    Assert (@(Get-ChildItem -LiteralPath $f.root -File).Count-eq2) 'Unexpected remaining file set'
    foreach($path in $f.retained){Assert ([IO.File]::ReadAllText((Join-Path $f.root $path))-ceq$path) 'Retained metadata changed'}
}
Case 'partial deletion resumes from the persisted plan without needing the old payload' {
    $f=Fixture;$plan=NewReachDeletionPlan $f.root $f.owned $f.retained
    $saved=Join-Path $evidence 'interrupted-plan.json';[IO.File]::WriteAllText($saved,($plan|ConvertTo-Json -Depth 8))
    [IO.File]::Delete((Join-Path $f.root $f.owned[0]))
    $resumed=Get-Content -LiteralPath $saved -Raw|ConvertFrom-Json
    InvokeReachDeletionPlan $resumed $f.root;InvokeReachDeletionPlan $resumed $f.root
    Assert (-not(Test-Path -LiteralPath (Join-Path $f.root 'versions'))) 'Owned version directory remains'
}
Case 'missing file at planning is tolerated, but a later replacement is refused' {
    $f=Fixture;$file=Join-Path $f.root $f.owned[0];[IO.File]::Delete($file);$plan=NewReachDeletionPlan $f.root $f.owned $f.retained
    [IO.File]::WriteAllText($file,'another program');Refused {InvokeReachDeletionPlan $plan $f.root} 'Unexpected replacement'
    Assert ([IO.File]::ReadAllText($file)-ceq'another program') 'Replacement was deleted'
}
Case 'unknown file or empty directory blocks planning before any deletion' {
    foreach($directory in @($false,$true)){
        $f=Fixture;$extra=Join-Path $f.root 'user-content'
        if($directory){$null=[IO.Directory]::CreateDirectory($extra)}else{[IO.File]::WriteAllText($extra,'keep')}
        Refused {NewReachDeletionPlan $f.root $f.owned $f.retained} 'Unrecognized'
        Assert (Test-Path -LiteralPath (Join-Path $f.root $f.owned[0])) 'Planning deleted a file'
    }
}
Case 'changed owned bytes are not silently deleted on retry' {
    $f=Fixture;$plan=NewReachDeletionPlan $f.root $f.owned $f.retained;$file=Join-Path $f.root $f.owned[0];[IO.File]::WriteAllText($file,'changed')
    Refused {InvokeReachDeletionPlan $plan $f.root} 'changed after';Assert (Test-Path -LiteralPath $file) 'Changed file deleted'
}
Case 'unknown content appearing after planning is retained instead of recursive removal' {
    $f=Fixture;$plan=NewReachDeletionPlan $f.root $f.owned $f.retained;$extra=Join-Path $f.root 'versions/reviewed/python/keep.txt';[IO.File]::WriteAllText($extra,'keep')
    Refused {InvokeReachDeletionPlan $plan $f.root} 'Unrecognized';Assert ([IO.File]::ReadAllText($extra)-ceq'keep') 'Unknown content deleted'
}
Case 'root and retained directory additions are detected before any removal on retry' {
    foreach($extraPath in @('keep.txt','empty','retained/keep.txt')){
        $f=Fixture
        $f.retained+=@('retained/metadata.json');$null=[IO.Directory]::CreateDirectory((Join-Path $f.root 'retained'))
        [IO.File]::WriteAllText((Join-Path $f.root 'retained/metadata.json'),'metadata')
        $plan=NewReachDeletionPlan $f.root $f.owned $f.retained;$extra=Join-Path $f.root $extraPath
        if($extraPath-ceq'empty'){$null=[IO.Directory]::CreateDirectory($extra)}else{[IO.File]::WriteAllText($extra,'keep')}
        Refused {InvokeReachDeletionPlan $plan $f.root} 'Unrecognized'
        Assert ((Test-Path -LiteralPath $extra) -and (Test-Path -LiteralPath (Join-Path $f.root $f.owned[0]))) 'Retry changed files before complete inventory'
    }
}
Case 'tampered journal cannot add, omit, or duplicate directory ownership' {
    foreach($mode in @('add','omit','duplicate')){
        $f=Fixture;$plan=NewReachDeletionPlan $f.root $f.owned $f.retained
        if($mode-ceq'add'){$null=[IO.Directory]::CreateDirectory((Join-Path $f.root 'unknown'));$plan.directories+=@('unknown')}
        elseif($mode-ceq'omit'){$plan.directories=@($plan.directories|Where-Object{$_-cne'bin'})}
        else{$plan.directories+=@('BIN')}
        Refused {InvokeReachDeletionPlan $plan $f.root} 'directory set differs|Duplicate removal directory'
        Assert (Test-Path -LiteralPath (Join-Path $f.root $f.owned[0])) 'Malformed journal removed a file'
    }
}
Case 'journal root changes and traversal are rejected' {
    $f=Fixture;$plan=NewReachDeletionPlan $f.root $f.owned $f.retained
    Refused {InvokeReachDeletionPlan $plan $evidence} 'Invalid removal journal'
    $plan.files[0].path='../outside';Refused {InvokeReachDeletionPlan $plan $f.root} 'Invalid package'
}
Case 'duplicate aliases and overlap with retained metadata are rejected' {
    $f=Fixture;Refused {NewReachDeletionPlan $f.root ($f.owned+@('BIN/REACH.EXE')) $f.retained} 'Duplicate'
    Refused {NewReachDeletionPlan $f.root ($f.owned+@('install.lock')) $f.retained} 'retained file'
}
Case 'locked owned file fails visibly and later retry succeeds' {
    $f=Fixture;$plan=NewReachDeletionPlan $f.root $f.owned $f.retained;$file=Join-Path $f.root $f.owned[0]
    $handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{Refused {InvokeReachDeletionPlan $plan $f.root} 'used|使用|访问|access';Assert (Test-Path -LiteralPath $file) 'Locked file disappeared'}finally{$handle.Dispose()}
    InvokeReachDeletionPlan $plan $f.root
}
$registryPath='Software\RY\ReachUninstallTests\'+[Guid]::NewGuid().ToString('N')
$environment=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
function PathSnapshot {$exists=$environment.GetValueNames()-contains'Path';return @{exists=$exists;kind=$(if($exists){[int]$environment.GetValueKind('Path')}else{2});raw=[string]$environment.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}
function NotifyEnvironment {}
try{
    Case 'owned unchanged PATH is restored exactly including type and delimiters' {
        $before=@{exists=$true;kind=2;raw='%SystemRoot%\System32;;C:\other;'};$after=$before.raw+';C:\Program Files\RY\Reach\bin'
        $environment.SetValue('Path',$after,[Microsoft.Win32.RegistryValueKind]::ExpandString)
        $result=RemoveReachOwnedPath @{applied=$true;before=$before;after=$after} 'C:\Program Files\RY\Reach\bin';$now=PathSnapshot
        Assert ($result.changed -and $now.raw-ceq$before.raw -and $now.kind-eq2) 'PATH changed outside owned addition'
    }
    Case 'preexisting or uncertain PATH additions remain untouched' {
        $environment.SetValue('Path','C:\user-owned',[Microsoft.Win32.RegistryValueKind]::String)
        Assert ((RemoveReachOwnedPath $null).disposition-ceq'not_owned') 'Unowned PATH inferred'
        Assert ((RemoveReachOwnedPath @{applied=$false}).disposition-ceq'not_owned') 'Uncertain write inferred'
        Assert ((PathSnapshot).raw-ceq'C:\user-owned') 'Unowned PATH changed'
    }
    Case 'concurrent PATH edits and registry kind are preserved with an explicit result' {
        $ownership=@{applied=$true;before=@{exists=$true;kind=2;raw='C:\before'};after='C:\before;C:\Reach'}
        $environment.SetValue('Path','C:\before;C:\Reach;C:\later',[Microsoft.Win32.RegistryValueKind]::String)
        $result=RemoveReachOwnedPath $ownership 'C:\Reach';$now=PathSnapshot
        Assert ($result.disposition-ceq'retained_ambiguous' -and $now.raw-ceq'C:\before;C:\Reach;C:\later' -and $now.kind-eq1) 'Concurrent PATH edit lost'
    }
    Case 'first installation restores absent PATH and repeated removal is harmless' {
        $ownership=@{applied=$true;before=@{exists=$false;kind=2;raw=''};after='C:\Reach'}
        $environment.SetValue('Path','C:\Reach',[Microsoft.Win32.RegistryValueKind]::ExpandString)
        Assert ((RemoveReachOwnedPath $ownership 'C:\Reach').changed) 'Owned PATH not removed'
        Assert (-not(PathSnapshot).exists) 'Missing PATH was converted to empty value'
        Assert ((RemoveReachOwnedPath $ownership 'C:\Reach').disposition-ceq'already_restored') 'Repeated PATH removal not idempotent'
    }
    Case 'malformed PATH ownership types and unrelated additions cannot authorize registry writes' {
        foreach($mode in @('applied-string','exists-string','kind-string','raw-null','after-null','unrelated-addition','absent-with-raw')){
            $ownership=@{applied=$true;before=@{exists=$true;kind=2;raw='C:\before'};after='C:\before;C:\Reach'}
            switch($mode){
                'applied-string'{$ownership.applied='false'}
                'exists-string'{$ownership.before.exists='false'}
                'kind-string'{$ownership.before.kind='2'}
                'raw-null'{$ownership.before.raw=$null}
                'after-null'{$ownership.after=$null}
                'unrelated-addition'{$ownership.after='C:\before;C:\unrelated'}
                'absent-with-raw'{$ownership.before.exists=$false}
            }
            $environment.SetValue('Path','C:\before;C:\Reach',[Microsoft.Win32.RegistryValueKind]::ExpandString)
            Refused {RemoveReachOwnedPath $ownership 'C:\Reach'} 'PATH ownership'
            Assert ((PathSnapshot).raw-ceq'C:\before;C:\Reach') 'Malformed ownership changed PATH'
        }
    }
}finally{$environment.Dispose();[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryPath,$false)}
Write-Output "RESULT $script:cases passed; ordinary file and HKCU effects, no production service/ACL; evidence=$evidence"
