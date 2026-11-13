# Copyright (c) Ray Zhang. Inventory original notices for all shipped Rust programs.
param([Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$Runtime)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(Test-Path -LiteralPath $Destination){throw 'Use a new notices destination'}
$packages=@{}
$supplements=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'notices/sources.json') -Raw|ConvertFrom-Json
Push-Location $project
try {
    foreach($manifest in @('Cargo.toml','desktop/Cargo.toml','packaging/windows/setup/Cargo.toml','../../crates/morrow-agent-jsonl/Cargo.toml')){
        $metadata=(& cargo metadata --manifest-path $manifest --locked --offline --format-version 1 --filter-platform x86_64-pc-windows-msvc | ConvertFrom-Json)
        if($LASTEXITCODE-ne0){throw "Dependency inventory failed: $manifest"}
        $reachable=@{};$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($metadata.resolve.root)
        $nodes=@{};foreach($item in $metadata.resolve.nodes){$nodes[$item.id]=$item}
        while($queue.Count){$id=$queue.Dequeue();if($reachable.ContainsKey($id)){continue};$reachable[$id]=$true;foreach($dependency in $nodes[$id].deps){$queue.Enqueue($dependency.pkg)}}
        foreach($package in $metadata.packages){if($reachable.ContainsKey($package.id) -and $null-ne$package.source){$packages[$package.id]=$package}}
    }
    $notices=[Text.StringBuilder]::new();[void]$notices.AppendLine('Reach Node, Desktop, Agent and Setup - original third-party notices')
    [void]$notices.AppendLine('Copyright (c) Ray Zhang. Dependency inventories include build-time packages; they are not a claim that every package is linked.')
    $sysroot=(& rustc --print sysroot | Out-String).Trim();if($LASTEXITCODE-ne0){throw 'Rust runtime provenance unavailable'}
    $runtimeDocs=Join-Path $sysroot 'share/doc/rust'
    foreach($relative in @('COPYRIGHT-library.html','licenses/Apache-2.0.txt','licenses/MIT.txt','licenses/LLVM-exception.txt','licenses/BSD-2-Clause.txt','licenses/ISC.txt','licenses/Unicode-3.0.txt')){
        $file=Join-Path $runtimeDocs $relative
        [void]$notices.AppendLine("`n=== Rust standard library: $relative ===");[void]$notices.AppendLine([IO.File]::ReadAllText($file))
    }
    $inventory=@()
    foreach($package in ($packages.Values|Sort-Object name,version)){
        $directory=Split-Path $package.manifest_path
        $files=@(Get-ChildItem -LiteralPath $directory -File -Recurse | Where-Object {$_.Name-match'^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)([.\-_]|$)'})
        if($package.license_file){$explicit=Join-Path $directory $package.license_file;if($files.FullName-notcontains$explicit){$files+=Get-Item -LiteralPath $explicit}}
        $supplement=@($supplements|Where-Object {$_.name-ceq$package.name -and $_.version-ceq$package.version})
        if($supplement.Count-gt1){throw 'Ambiguous Rust notice supplement'}
        $source=$null
        if($supplement.Count-eq1){
            $source=$supplement[0]
            if($package.source.StartsWith('git+') -and -not $package.source.EndsWith('#'+$source.revision)){throw 'Git notice source differs from dependency'}
            if($package.source.StartsWith('registry+')){
                $vcs=Get-Content -LiteralPath (Join-Path $directory '.cargo_vcs_info.json') -Raw|ConvertFrom-Json
                if($vcs.git.sha1-cne$source.revision){throw 'Registry notice source differs from published crate'}
            }
            foreach($original in $source.files){
                $file=Join-Path (Join-Path $PSScriptRoot 'notices') $original.path
                if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()-cne$original.sha256){throw 'Supplemental Rust notice changed'}
                [void]$notices.AppendLine("`n=== $($package.name) $($package.version) / $($original.sourcePath) ===")
                [void]$notices.AppendLine([IO.File]::ReadAllText($file))
            }
            if($source.licenseChoice){[void]$notices.AppendLine("Selected license: $($source.licenseChoice). $($source.note)")}
        }
        if($files.Count-eq0 -and $null-eq$source){throw "Missing license text: $($package.name) $($package.version)"}
        [void]$notices.AppendLine("`n=== $($package.name) $($package.version) | $($package.license) ===")
        $originals=@()
        foreach($file in ($files|Sort-Object FullName -Unique)){
            $relative=$file.FullName.Substring($directory.Length).TrimStart('\','/')
            [void]$notices.AppendLine("--- $relative ---");[void]$notices.AppendLine([IO.File]::ReadAllText($file.FullName))
            $originals+=@{path=$relative;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
        $inventory+=@{name=$package.name;version=$package.version;license=$package.license;source=$package.source;files=$originals;supplement=$source}
    }
    [void]$notices.AppendLine("`nSQLite bundled C library: dedicated to the public domain; see https://sqlite.org/copyright.html. No SQLCipher backend is enabled.")
    [void]$notices.AppendLine("`n=== Bundled Python and desktop runtime ===")
    [void]$notices.AppendLine([IO.File]::ReadAllText((Join-Path $Runtime 'reach-provenance/THIRD_PARTY_NOTICES.txt')))
    $target=[IO.Path]::GetFullPath($Destination);$null=[IO.Directory]::CreateDirectory((Split-Path $target))
    [IO.File]::WriteAllText($target,$notices.ToString(),[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText(($target+'.json'),($inventory|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Write-Output "Original Rust package notices: $($inventory.Count)"
}finally{Pop-Location}
