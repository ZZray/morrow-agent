# Copyright (c) Ray Zhang. Exercise actual ZIP validation in Windows PowerShell 5.1.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
. (Join-Path $PSScriptRoot '../packaging/windows/payload.ps1')
function Assert([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Bytes([string]$Text){return ,([Text.UTF8Encoding]::new($false).GetBytes($Text))}
function Digest([byte[]]$Data){$stream=[IO.MemoryStream]::new($Data,$false);try{return ReachHashStream $stream $Data.Length}finally{$stream.Dispose()}}
function Fixture {
    $items=[ordered]@{
        'reach.exe'=(Bytes 'MZ-node');'desktop/reach-desktop.exe'=(Bytes 'MZ-helper')
        'desktop/python/python.exe'=(Bytes 'MZ-python');'desktop/python/python314._pth'=(Bytes "python314.zip`n.`n")
        'desktop/python/reach-provenance/files.json'=(Bytes '[]');'desktop/config.toml'=(Bytes 'fixture=true')
        'THIRD_PARTY_NOTICES.txt'=(Bytes 'fixture notices')
        'desktop-runtime.json'=(Bytes '{"helper":"desktop/reach-desktop.exe","python":"desktop/python/python.exe","config":"desktop/config.toml"}')
    }
    $manifest=@{schema=1;product='Reach';version='0.1.0';architecture='x86_64-pc-windows-msvc';desktopBundled=$true
        nodeSha256=(Digest $items['reach.exe']);helperSha256=(Digest $items['desktop/reach-desktop.exe'])
        runtimeManifestSha256=(Digest $items['desktop/python/reach-provenance/files.json']);files=@()}
    foreach($name in $items.Keys){$manifest.files+=@{path=$name;bytes=$items[$name].Length;sha256=(Digest $items[$name])}}
    return @{items=$items;manifest=$manifest;extras=@();attributes=@{}}
}
function Zip($Fixture) {
    $memory=[IO.MemoryStream]::new();$archive=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Create,$true)
    try {
        $entries=@();foreach($name in $Fixture.items.Keys){$entries+=@{path=$name;data=$Fixture.items[$name]}}
        $entries+=@{path='payload-manifest.json';data=(Bytes ($Fixture.manifest|ConvertTo-Json -Depth 8 -Compress))}
        $entries+=$Fixture.extras
        foreach($file in $entries){
            $entry=$archive.CreateEntry($file.path)
            if($Fixture.attributes.ContainsKey($file.path)){$entry.ExternalAttributes=$Fixture.attributes[$file.path]}
            $stream=$entry.Open();try{$stream.Write($file.data,0,$file.data.Length)}finally{$stream.Dispose()}
        }
    }finally{$archive.Dispose()}
    try{return ,$memory.ToArray()}finally{$memory.Dispose()}
}
function AgentFixture {
    $f=Fixture;$f.manifest.schema=2;$f.manifest.agentBundled=$true
    $f.items['agent/morrow-agent-jsonl.exe']=Bytes 'MZ-agent'
    $f.manifest.agentSha256=Digest $f.items['agent/morrow-agent-jsonl.exe']
    $f.items['agent-runtime.json']=Bytes ('{"sidecar":"agent/morrow-agent-jsonl.exe","sha256":"'+$f.manifest.agentSha256+'","inspectionLeaseVersion":1}')
    foreach($name in @('agent/morrow-agent-jsonl.exe','agent-runtime.json')){$f.manifest.files+=@{path=$name;bytes=$f.items[$name].Length;sha256=(Digest $f.items[$name])}}
    return $f
}
function AgentConfig($Fixture,[string]$Text){
    $Fixture.items['agent-runtime.json']=Bytes $Text
    $record=$Fixture.manifest.files|Where-Object path -eq 'agent-runtime.json';$record.bytes=$Fixture.items['agent-runtime.json'].Length;$record.sha256=Digest $Fixture.items['agent-runtime.json']
}
function ReadZip([byte[]]$Data) {
    $stream=[IO.MemoryStream]::new($Data,$false);$archive=$null
    try{$archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read,$true);return ReadReachPayload $archive}finally{if($archive){$archive.Dispose()};$stream.Dispose()}
}
$script:cases=0
function Case([string]$Name,[scriptblock]$Action){& $Action;$script:cases++;Write-Output "PASS $Name"}
function Refused([scriptblock]$Action,[string]$Pattern){$failed=$false;try{&$Action|Out-Null}catch{$failed=$true;Assert ($_.Exception.Message-match$Pattern) "Unexpected failure: $($_.Exception.Message)"};Assert $failed "Expected rejection: $Pattern"}
Case 'complete ZIP verifies actual bytes, role digests and runtime config' {
    $fixture=Fixture;$data=Zip $fixture;$result=ReadZip $data
    Assert ($result.declared.Count-eq8 -and $result.manifest.desktopBundled) 'Incomplete verified result'
    Assert ((Digest $result.manifestBytes)-ceq(Digest (Bytes ($fixture.manifest|ConvertTo-Json -Depth 8 -Compress)))) 'Manifest bytes changed'
}
Case 'changed payload bytes rejected' {$f=Fixture;$f.items['reach.exe']=Bytes 'bad-node';Refused {ReadZip (Zip $f)} 'differs|digest mismatch'}
Case 'wrong digest rejected' {$f=Fixture;$f.manifest.files[0].sha256='0'*64;Refused {ReadZip (Zip $f)} 'digest mismatch'}
Case 'wrong expanded size rejected' {$f=Fixture;$f.manifest.files[0].bytes++;Refused {ReadZip (Zip $f)} 'differs'}
Case 'undeclared extra file rejected' {$f=Fixture;$f.items['extra.txt']=Bytes 'extra';Refused {ReadZip (Zip $f)} 'set differs'}
Case 'missing component rejected even with matching declared set' {
    $f=Fixture;$f.items.Remove('desktop/python/python.exe');$f.manifest.files=@($f.manifest.files|Where-Object path -ne 'desktop/python/python.exe')
    Refused {ReadZip (Zip $f)} 'Required complete package file missing'
}
Case 'all role digest identities checked' {
    foreach($key in @('nodeSha256','helperSha256','runtimeManifestSha256')){$f=Fixture;$f.manifest[$key]='0'*64;Refused {ReadZip (Zip $f)} 'identity mismatch'}
}
Case 'duplicate archive names and case aliases rejected' {
    foreach($name in @('reach.exe','Reach.exe')){$f=Fixture;$f.extras=@(@{path=$name;data=(Bytes 'alias')});Refused {ReadZip (Zip $f)} 'Duplicate'}
}
Case 'manifest duplicates and case mismatch rejected' {
    $f=Fixture;$f.manifest.files[1]=$f.manifest.files[0];Refused {ReadZip (Zip $f)} 'entry set'
    $f=Fixture;$f.manifest.files[0].path='Reach.exe';Refused {ReadZip (Zip $f)} 'differs'
}
Case 'file-directory collisions rejected before extraction' {$f=Fixture;$f.extras=@(@{path='desktop';data=(Bytes 'file')});Refused {ReadZip (Zip $f)} 'directory conflict'}
Case 'Windows path aliases, traversal, ADS and device names refused' {
    foreach($name in @('../escape','/absolute','C:/drive','a\b','a//b','a/./b','a/../b','a/file:ads','a/name.','a/name ','NUL','con.txt','a/LPT1.py',('a/COM'+[char]0xb9+'.dll'),'a/*.txt',"a/`nfile",'a/')){
        Refused {ReachRelativePath $name} 'Invalid package'
        $f=Fixture;$f.extras=@(@{path=$name;data=(Bytes 'invalid')});Refused {ReadZip (Zip $f)} 'Invalid package|Illegal characters in path'
    }
}
Case 'symlink and directory attributes refused' {
    foreach($attr in @(-1577058304,0x10,0x400)){$f=Fixture;$f.attributes['reach.exe']=$attr;Refused {ReadZip (Zip $f)} 'Special package'}
}
Case 'unsupported schema, string boolean and fractional bytes refused' {
    $f=Fixture;$f.manifest.schema=3;Refused {ReadZip (Zip $f)} 'Unsupported'
    $f=Fixture;$f.manifest.desktopBundled='true';Refused {ReadZip (Zip $f)} 'Unsupported'
    $f=Fixture;$f.manifest.files[0].bytes=1.5;Refused {ReadZip (Zip $f)} 'declared package size'
}
Case 'runtime paths and unknown fields refused despite correct file hash' {
    foreach($text in @('{"helper":"../helper.exe","python":"desktop/python/python.exe","config":"desktop/config.toml"}','{"helper":"desktop/reach-desktop.exe","python":"desktop/python/python.exe","config":"desktop/config.toml","extra":true}')){
        $f=Fixture;$f.items['desktop-runtime.json']=Bytes $text;$record=$f.manifest.files|Where-Object path -eq 'desktop-runtime.json';$record.bytes=$f.items['desktop-runtime.json'].Length;$record.sha256=Digest $f.items['desktop-runtime.json']
        Refused {ReadZip (Zip $f)} 'runtime paths'
    }
}
Case 'truncated ZIP refused' {$data=Zip (Fixture);Refused {ReadZip $data[0..($data.Length-30)]} 'Central Directory|central directory|end|corrupt|损坏|目录'}
Case 'actual stream underflow and overflow refused' {
    foreach($size in @(2,4)){$stream=[IO.MemoryStream]::new((Bytes 'abc'),$false);try{Refused {ReachHashStream $stream $size} 'exceeds|truncated'}finally{$stream.Dispose()}}
}
Case 'schema2 binds Agent config and actual sidecar bytes as a complete component' {
    $f=AgentFixture;$result=ReadZip (Zip $f);Assert ($result.manifest.schema-eq2 -and $result.declared.Count-eq10 -and $result.manifest.agentBundled) 'Packaged Agent was omitted'
}
Case 'schema2 cannot omit Agent files, declarations or boolean identity' {
    foreach($name in @('agent-runtime.json','agent/morrow-agent-jsonl.exe')){$f=AgentFixture;$f.items.Remove($name);$f.manifest.files=@($f.manifest.files|Where-Object path -ne $name);Refused {ReadZip (Zip $f)} 'Agent component'}
    foreach($value in @($false,'true')){$f=AgentFixture;$f.manifest.agentBundled=$value;Refused {ReadZip (Zip $f)} 'Agent is required'}
    $f=AgentFixture;$f.manifest.agentSha256='0'*64;Refused {ReadZip (Zip $f)} 'Agent component'
}
Case 'Agent config cannot redirect, change digest, omit lease or change field types' {
    foreach($variant in @('path','sha','lease','string-lease','missing-lease','unknown')){
        $f=AgentFixture;$config=@{sidecar='agent/morrow-agent-jsonl.exe';sha256=$f.manifest.agentSha256;inspectionLeaseVersion=1}
        switch($variant){'path'{$config.sidecar='../external.exe'}'sha'{$config.sha256='0'*64}'lease'{$config.inspectionLeaseVersion=2}'string-lease'{$config.inspectionLeaseVersion='1'}'missing-lease'{$config.Remove('inspectionLeaseVersion')}'unknown'{$config.extra=$true}}
        AgentConfig $f ($config|ConvertTo-Json -Compress);Refused {ReadZip (Zip $f)} 'Agent runtime config'
    }
}
Case 'legacy schema cannot hide Agent fields or files through a version downgrade' {
    $f=AgentFixture;$f.manifest.schema=1;Refused {ReadZip (Zip $f)} 'Legacy package'
    $f=AgentFixture;$f.manifest.schema=1;$f.manifest.Remove('agentSha256');$f.manifest.Remove('agentBundled');Refused {ReadZip (Zip $f)} 'Legacy package'
}
Case 'installed schema2 verifies Agent identity and rejects missing or changed files' {
    $f=AgentFixture;$root=[IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '../work') ('payload-agent-'+[Guid]::NewGuid().ToString('N'))));$null=[IO.Directory]::CreateDirectory($root)
    foreach($name in $f.items.Keys){$path=Join-Path $root $name;$null=[IO.Directory]::CreateDirectory((Split-Path $path));[IO.File]::WriteAllBytes($path,$f.items[$name])}
    $manifestBytes=Bytes ($f.manifest|ConvertTo-Json -Compress -Depth 8);[IO.File]::WriteAllBytes((Join-Path $root 'payload-manifest.json'),$manifestBytes)
    function CheckPath([string]$Path){if((Get-Item -LiteralPath $Path -Force).Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'Test rejects reparse paths'}}
    $manifest=ReadReachInstalledPayload $root (Digest $manifestBytes);Assert ($manifest.agentBundled -and $manifest.schema-eq2) 'Installed Agent is absent'
    [IO.File]::WriteAllText((Join-Path $root 'agent-runtime.json'),'changed');Refused {ReadReachInstalledPayload $root (Digest $manifestBytes)} 'size mismatch|digest mismatch'
    [IO.File]::WriteAllBytes((Join-Path $root 'agent-runtime.json'),$f.items['agent-runtime.json']);[IO.File]::Delete((Join-Path $root 'agent/morrow-agent-jsonl.exe'));Refused {ReadReachInstalledPayload $root (Digest $manifestBytes)} 'file set differs'
}
Write-Output "PASS $script:cases payload cases; PowerShell $($PSVersionTable.PSVersion)"
