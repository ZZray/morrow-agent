# Copyright (c) Ray Zhang. Actual WinPS 5.1 FileStream/replace/flush; isolated ordinary-user ACL.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../packaging/windows/payload.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/ownership.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/maintenance-writes.ps1')
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../packaging/windows/install.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Hash','AcquireMaintenanceLock')){$definition=$ast.Find({param($a)$a-is[Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true);. ([ScriptBlock]::Create($definition.Extent.Text))}
function CheckPath([string]$Path){$item=Get-Item -LiteralPath $Path -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Reparse refused by test host'}}
function Security([bool]$Directory,[bool]$Public){$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($sid);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));return $acl}
function Assert([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Refused([scriptblock]$Action,[string]$Pattern){$failed=$false;try{&$Action|Out-Null}catch{$failed=$true;Assert ($_.Exception.Message-match$Pattern) $_.Exception.Message};Assert $failed "Expected $Pattern"}
function Bytes([string]$Text){return ,[Text.UTF8Encoding]::new($false).GetBytes($Text)}
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$evidence=Join-Path $project ('work/maintenance-writes-'+[Guid]::NewGuid().ToString('N'))
$root=Join-Path $evidence 'program';$dataParent=Join-Path $evidence 'data'
foreach($directory in @($root,$dataParent,(Join-Path $root 'bin'))){$null=[IO.Directory]::CreateDirectory($directory)}
$lockPath=Join-Path $root 'install.lock';$installLock=AcquireMaintenanceLock $lockPath
$script:cases=0
function Case([string]$Name,[scriptblock]$Action){&$Action;$script:cases++;Write-Output "PASS $Name"}
try{
    Case 'first metadata creation and atomic replacement record exact temporary ownership' {
        $target=Join-Path $root 'deployment.json'
        WriteReachAtomicFile $target (Bytes 'first')
        $log=ReadReachWriteIntents
        Assert ($log.entries.Count-eq1 -and $log.entries[0].target-ceq$target) 'Missing write attribution'
        Assert (-not[IO.File]::Exists($log.entries[0].temporary)) 'Published temp remains'
        WriteReachAtomicFile $target (Bytes 'second')
        Assert ([IO.File]::ReadAllText($target)-ceq'second' -and (ReadReachWriteIntents).entries.Count-eq1) 'Replacement or completed intent retirement failed'
    }
    Case 'two actual maintenance lock owners cannot overlap' {
        Refused {$other=AcquireMaintenanceLock $lockPath;$other.Dispose()} 'used|使用|访问|access'
    }
    Case 'failed replacement keeps original bytes and attributed temp recovers on restart' {
        $target=Join-Path $root 'deployment.json';$held=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try{Refused {WriteReachAtomicFile $target (Bytes 'candidate')} 'used|使用|访问|access|拒绝';Assert ([IO.File]::ReadAllText($target)-ceq'second') 'Failed replacement changed target'}finally{$held.Dispose()}
        $temporary=(ReadReachWriteIntents).entries[0].temporary;Assert ([IO.File]::Exists($temporary)) 'Failure left no recoverable temp'
        $installLock.Dispose();$script:installLock=AcquireMaintenanceLock $lockPath
        RecoverReachAtomicWrites
        Assert (-not[IO.File]::Exists($temporary) -and $installLock.Length-eq0 -and [IO.File]::ReadAllText($target)-ceq'second') 'Recovery changed target or lost temp identity'
    }
    Case 'partial payload after flushed intent is removed without requiring a complete digest' {
        $target=Join-Path $root 'install.json';$temporary=ReserveReachAtomicWrite $target (Bytes 'complete payload')
        [IO.File]::WriteAllText($temporary,'partial')
        $installLock.Dispose();$script:installLock=AcquireMaintenanceLock $lockPath;RecoverReachAtomicWrites
        Assert (-not[IO.File]::Exists($temporary) -and -not[IO.File]::Exists($target)) 'Partial bytes adopted or not recovered'
    }
    Case 'unknown legacy new-GUID temporary file is never inferred or removed' {
        $unknown=Join-Path $root ('install.json.new-'+[Guid]::NewGuid().ToString('N'));[IO.File]::WriteAllText($unknown,'unattributed')
        WriteReachAtomicFile (Join-Path $root 'install.json') (Bytes 'known');RecoverReachAtomicWrites
        Assert ([IO.File]::ReadAllText($unknown)-ceq'unattributed') 'Unknown legacy temporary file deleted'
    }
    Case 'partial header and incomplete trailing JSON do not authorize file removal' {
        foreach($text in @('RY.Reach.Wri',("RY.Reach.WriteIntents/1`n"+'{"temporary":"unflushed'))){
            $installLock.SetLength(0);$installLock.Position=0;$bytes=Bytes $text;$installLock.Write($bytes,0,$bytes.Length);$installLock.Flush($true)
            RecoverReachAtomicWrites;Assert ($installLock.Length-eq0) 'Incomplete append not retired'
        }
    }
    Case 'malformed complete entry or foreign lock bytes are rejected without truncation' {
        foreach($text in @('unrelated-lock-content',("RY.Reach.WriteIntents/1`n{}"+"`n"))){
            $installLock.SetLength(0);$installLock.Position=0;$bytes=Bytes $text;$installLock.Write($bytes,0,$bytes.Length);$installLock.Flush($true)
            Refused {RecoverReachAtomicWrites} 'Unrecognized|Invalid maintenance'
            Assert ($installLock.Length-eq$bytes.Length) 'Invalid lock was silently overwritten'
        }
        $installLock.SetLength(0);$installLock.Flush($true)
    }
    Case 'recovery cannot authorize arbitrary targets or mismatched temporary names' {
        $outside=Join-Path $dataParent 'node.sqlite';[IO.File]::WriteAllText($outside,'keep')
        foreach($mode in @('target','temporary','root')){
            $installLock.SetLength(0);$temporary=ReserveReachAtomicWrite (Join-Path $root 'install.json') (Bytes 'pending');$entry=(ReadReachWriteIntents).entries[0]
            switch($mode){'target'{$entry.target=$outside};'temporary'{$entry.temporary=$outside};'root'{$entry.root=$dataParent}}
            $bytes=Bytes ("RY.Reach.WriteIntents/1`n"+($entry|ConvertTo-Json -Compress)+"`n")
            $installLock.SetLength(0);$installLock.Position=0;$installLock.Write($bytes,0,$bytes.Length);$installLock.Flush($true)
            Refused {RecoverReachAtomicWrites} 'outside|Invalid'
            Assert ([IO.File]::ReadAllText($outside)-ceq'keep') 'Foreign file removed by tampered intent'
        }
        $installLock.SetLength(0);$installLock.Flush($true)
    }
    Case 'busy attributed temporary file keeps its journal until cleanup succeeds' {
        $temporary=ReserveReachAtomicWrite (Join-Path $root 'install.json') (Bytes 'pending');[IO.File]::WriteAllText($temporary,'partial')
        $held=[IO.File]::Open($temporary,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try{Refused {RecoverReachAtomicWrites} 'used|使用|访问|access';Assert ((ReadReachWriteIntents).entries.Count-eq1) 'Failure retired required attribution'}finally{$held.Dispose()}
        RecoverReachAtomicWrites;Assert ($installLock.Length-eq0) 'Successful cleanup did not retire attribution'
    }
    Case 'staged files use CreateNew and cannot overwrite an existing file' {
        $stage=Join-Path $root 'stage-fixture';$null=[IO.Directory]::CreateDirectory($stage);$target=Join-Path $stage 'reach.exe'
        WriteReachStagedFile $target (Bytes 'first')
        Refused {WriteReachStagedFile $target (Bytes 'replacement')} 'exists|存在'
        Assert ([IO.File]::ReadAllText($target)-ceq'first') 'Staged file was overwritten'
    }
}finally{$installLock.Dispose()}
Write-Output "RESULT $script:cases passed; actual FileStream/replace/flush and exclusive locks; test-user ACL, no system installation; evidence=$evidence"
