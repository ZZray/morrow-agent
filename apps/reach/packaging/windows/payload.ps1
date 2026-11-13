# Copyright (c) Ray Zhang. Pure package checks shared by the embedded installer and its tests.
# Compatible with Windows PowerShell 5.1; this file performs no installation on load.
function ReachHashStream([IO.Stream]$Stream,[long]$ExpectedBytes) {
    $algorithm=[Security.Cryptography.SHA256]::Create()
    $buffer=[byte[]]::new(65536)
    [long]$total=0
    try {
        while(($read=$Stream.Read($buffer,0,$buffer.Length))-gt0){
            $total+=$read
            if($total-gt$ExpectedBytes){throw 'Package entry exceeds its declared size'}
            [void]$algorithm.TransformBlock($buffer,0,$read,$null,0)
        }
        if($total-ne$ExpectedBytes){throw 'Package entry is truncated'}
        [void]$algorithm.TransformFinalBlock([byte[]]@(),0,0)
        return ([BitConverter]::ToString($algorithm.Hash)).Replace('-','').ToLowerInvariant()
    }finally{$algorithm.Dispose()}
}
function ReachRelativePath([string]$Path) {
    if([string]::IsNullOrEmpty($Path) -or $Path.Length-gt240 -or $Path.Contains('\') -or $Path.Contains(':') -or $Path.StartsWith('/') -or $Path.EndsWith('/')){throw 'Invalid package relative path'}
    foreach($part in $Path.Split('/')){
        if($part -in @('','.','..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars())-ge0 -or $part-match'^(?i:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)'){throw 'Invalid package path component'}
    }
    return $Path
}
function ReadReachEntry([IO.Compression.ZipArchiveEntry]$Entry,[long]$Limit) {
    if($Entry.Length-gt$Limit){throw 'Package metadata exceeds the bound'}
    $entryStream=$Entry.Open();$memory=[IO.MemoryStream]::new();$buffer=[byte[]]::new(65536)
    try {
        while(($read=$entryStream.Read($buffer,0,$buffer.Length))-gt0){
            if($memory.Length+$read-gt$Entry.Length -or $memory.Length+$read-gt$Limit){throw 'Package metadata exceeds its declared size'}
            $memory.Write($buffer,0,$read)
        }
        if($memory.Length-ne$Entry.Length){throw 'Package metadata is truncated'}
        return ,$memory.ToArray()
    }finally{$entryStream.Dispose();$memory.Dispose()}
}
function AssertReachRuntimeConfig($Config) {
    if($null-eq$Config -or @($Config.PSObject.Properties).Count-ne3 -or $Config.helper-cne'desktop/reach-desktop.exe' -or $Config.python-cne'desktop/python/python.exe' -or $Config.config-cne'desktop/config.toml'){
        throw 'Desktop runtime paths must refer to this complete version'
    }
}
function AssertReachManifestHeader($Manifest) {
    if($Manifest.schema-isnot[int] -or $Manifest.schema-notin@(1,2) -or $Manifest.product-cne'Reach' -or $Manifest.version-cne'0.1.0' -or $Manifest.architecture-cne'x86_64-pc-windows-msvc' -or $Manifest.desktopBundled-isnot[bool] -or $Manifest.desktopBundled-ne$true -or $Manifest.files-isnot[array]){throw 'Unsupported complete package manifest'}
    foreach($digest in @($Manifest.nodeSha256,$Manifest.helperSha256,$Manifest.runtimeManifestSha256)){
        if($digest-notmatch'^[0-9a-f]{64}$'){throw 'Invalid package component digest'}
    }
    if($Manifest.schema-eq2 -and ($Manifest.agentBundled-isnot[bool] -or -not $Manifest.agentBundled -or $Manifest.agentSha256-isnot[string] -or $Manifest.agentSha256-cnotmatch'^[0-9a-f]{64}$')){throw 'Agent is required by complete package schema 2'}
}
function AssertReachAgentPackage($Manifest,$Declared,$Config) {
    if($Manifest.schema-eq1){
        if($null-ne$Manifest.PSObject.Properties['agentBundled'] -or $null-ne$Manifest.PSObject.Properties['agentSha256']){throw 'Legacy package cannot declare Agent fields'}
        foreach($name in $Declared.Keys){if($name-ieq'agent-runtime.json' -or $name.StartsWith('agent/',[StringComparison]::OrdinalIgnoreCase)){throw 'Legacy package cannot contain Agent files'}}
        return
    }
    if(-not $Declared.ContainsKey('agent/morrow-agent-jsonl.exe') -or $Declared['agent/morrow-agent-jsonl.exe'].sha256-cne$Manifest.agentSha256 -or -not $Declared.ContainsKey('agent-runtime.json')){throw 'Agent component identity mismatch'}
    if($null-eq$Config -or @($Config.PSObject.Properties).Count-ne3 -or $Config.sidecar-cne'agent/morrow-agent-jsonl.exe' -or $Config.sha256-cne$Manifest.agentSha256 -or $Config.inspectionLeaseVersion-isnot[int] -or $Config.inspectionLeaseVersion-ne1){throw 'Agent runtime config must bind the packaged sidecar and inspection lease'}
}
function ReadReachPayload([IO.Compression.ZipArchive]$Archive) {
    if($Archive.Entries.Count-lt5 -or $Archive.Entries.Count-gt20000){throw 'Unexpected package file count'}
    $entries=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($entry in $Archive.Entries){
        $name=ReachRelativePath $entry.FullName
        if($entries.ContainsKey($name)){throw 'Duplicate package entry'}
        # Unix symlink and other special entries are not valid installed files.
        $kind=($entry.ExternalAttributes-shr16)-band0xf000
        if($kind-notin@(0,0x8000) -or ($entry.ExternalAttributes-band0x410)-ne0){throw 'Special package entry refused'}
        if($entry.Length-lt0 -or $entry.Length-gt536870912){throw 'Package entry size exceeds the bound'}
        $entries.Add($name,$entry)
    }
    foreach($name in $entries.Keys){
        $parts=$name.Split('/')
        for($i=1;$i-lt$parts.Length;$i++){
            if($entries.ContainsKey(($parts[0..($i-1)]-join'/'))){throw 'Package file and directory conflict'}
        }
    }
    if(-not $entries.ContainsKey('payload-manifest.json')){throw 'Package manifest missing'}
    $manifestEntry=$entries['payload-manifest.json']
    if($manifestEntry.Length-gt16777216){throw 'Package manifest too large'}
    $manifestBytes=ReadReachEntry $manifestEntry 16777216
    $raw=[Text.UTF8Encoding]::new($false,$true).GetString($manifestBytes)
    $manifest=$raw|ConvertFrom-Json
    AssertReachManifestHeader $manifest
    if($manifest.files.Count-ne($entries.Count-1)){throw 'Package entry set differs from manifest'}
    $declared=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total=0
    foreach($file in $manifest.files){
        $name=ReachRelativePath ([string]$file.path)
        if($name-ceq'payload-manifest.json' -or $declared.ContainsKey($name) -or -not $entries.ContainsKey($name)){throw 'Manifest entry set is invalid'}
        if($file.bytes-isnot[long] -and $file.bytes-isnot[int]){throw 'Invalid declared package size'}
        if($file.bytes-lt0 -or $file.bytes-gt536870912 -or $file.sha256-notmatch'^[0-9a-f]{64}$'){throw 'Invalid declared package file'}
        $entry=$entries[$name]
        if($entry.FullName-cne$name -or $entry.Length-ne$file.bytes){throw 'Archive entry differs from manifest'}
        $total+=$file.bytes
        if($total-gt2147483648){throw 'Expanded package is too large'}
        $entryStream=$entry.Open()
        try {if((ReachHashStream $entryStream $file.bytes)-cne$file.sha256){throw "Package file digest mismatch: $name"}}finally{$entryStream.Dispose()}
        $declared.Add($name,$file)
    }
    $required=@{'reach.exe'=$manifest.nodeSha256;'desktop/reach-desktop.exe'=$manifest.helperSha256;'desktop/python/reach-provenance/files.json'=$manifest.runtimeManifestSha256}
    foreach($name in $required.Keys){if(-not $declared.ContainsKey($name) -or $declared[$name].sha256-cne$required[$name]){throw 'Required component identity mismatch'}}
    foreach($name in @('desktop-runtime.json','desktop/python/python.exe','desktop/python/python314._pth','desktop/config.toml','THIRD_PARTY_NOTICES.txt')){
        if(-not $declared.ContainsKey($name)){throw "Required complete package file missing: $name"}
    }
    $configBytes=ReadReachEntry $entries['desktop-runtime.json'] 16384
    AssertReachRuntimeConfig ([Text.UTF8Encoding]::new($false,$true).GetString($configBytes)|ConvertFrom-Json)
    $agentConfig=$null
    if($manifest.schema-eq2 -and $entries.ContainsKey('agent-runtime.json')){$agentConfig=[Text.UTF8Encoding]::new($false,$true).GetString((ReadReachEntry $entries['agent-runtime.json'] 16384))|ConvertFrom-Json}
    AssertReachAgentPackage $manifest $declared $agentConfig
    return @{manifest=$manifest;entries=$entries;declared=$declared;manifestBytes=$manifestBytes;totalBytes=$total}
}
# CheckPath is supplied by the installer: owner/DACL/reparse checks precede traversal.
function ReadReachInstalledPayload([string]$Root,[string]$ManifestSha) {
    CheckPath $Root
    $manifestPath=Join-Path $Root 'payload-manifest.json';CheckPath $manifestPath
    $info=Get-Item -LiteralPath $manifestPath
    if($info.Length-gt16777216){throw 'Installed package manifest too large'}
    $raw=[IO.File]::ReadAllBytes($manifestPath);$stream=[IO.MemoryStream]::new($raw,$false)
    try{if((ReachHashStream $stream $raw.Length)-cne$ManifestSha){throw 'Installed manifest digest mismatch'}}finally{$stream.Dispose()}
    $manifest=[Text.UTF8Encoding]::new($false,$true).GetString($raw)|ConvertFrom-Json
    AssertReachManifestHeader $manifest
    if($manifest.files.Count-lt8 -or $manifest.files.Count-gt19999){throw 'Invalid installed file count'}
    $files=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($Root)
    while($queue.Count){
        $directory=$queue.Dequeue()
        foreach($item in (Get-ChildItem -LiteralPath $directory -Force)){
            CheckPath $item.FullName
            if($item.PSIsContainer){$queue.Enqueue($item.FullName);continue}
            $relative=$item.FullName.Substring($Root.TrimEnd('\').Length+1).Replace('\','/')
            [void](ReachRelativePath $relative)
            $files.Add($relative,$item)
            if($files.Count-gt20000){throw 'Installed file set exceeds the bound'}
        }
    }
    if($files.Count-ne($manifest.files.Count+1)){throw 'Installed package file set differs'}
    $declared=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total=0
    foreach($file in $manifest.files){
        $relative=ReachRelativePath ([string]$file.path)
        if($relative-ieq'payload-manifest.json' -or $declared.ContainsKey($relative) -or -not $files.ContainsKey($relative)){throw 'Installed manifest entry set is invalid'}
        if(($file.bytes-isnot[long] -and $file.bytes-isnot[int]) -or $file.bytes-lt0 -or $file.bytes-gt536870912 -or $file.sha256-notmatch'^[0-9a-f]{64}$'){throw 'Invalid installed file metadata'}
        $item=$files[$relative]
        if($item.Length-ne$file.bytes){throw 'Installed package file size mismatch'}
        $total+=$file.bytes;if($total-gt2147483648){throw 'Installed package too large'}
        $stream=[IO.File]::OpenRead($item.FullName)
        try{if((ReachHashStream $stream $file.bytes)-cne$file.sha256){throw "Installed file digest mismatch: $relative"}}finally{$stream.Dispose()}
        $declared.Add($relative,$file)
    }
    foreach($pair in @(@('reach.exe',$manifest.nodeSha256),@('desktop/reach-desktop.exe',$manifest.helperSha256),@('desktop/python/reach-provenance/files.json',$manifest.runtimeManifestSha256))){
        if(-not $declared.ContainsKey($pair[0]) -or $declared[$pair[0]].sha256-cne$pair[1]){throw 'Installed component identity mismatch'}
    }
    foreach($name in @('desktop-runtime.json','desktop/python/python.exe','desktop/python/python314._pth','desktop/config.toml','THIRD_PARTY_NOTICES.txt')){if(-not $declared.ContainsKey($name)){throw 'Installed component missing'}}
    AssertReachRuntimeConfig ([IO.File]::ReadAllText((Join-Path $Root 'desktop-runtime.json'))|ConvertFrom-Json)
    $agentConfig=$null
    if($manifest.schema-eq2 -and $files.ContainsKey('agent-runtime.json')){if($files['agent-runtime.json'].Length-gt16384){throw 'Agent runtime config exceeds the bound'};$agentConfig=[IO.File]::ReadAllText((Join-Path $Root 'agent-runtime.json'))|ConvertFrom-Json}
    AssertReachAgentPackage $manifest $declared $agentConfig
    return $manifest
}
