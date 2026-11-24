# Copyright (c) Ray Zhang. Build a reviewable, self-contained Node installer candidate.
param(
    [Parameter(Mandatory=$true)][string]$NodeBinary,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][string]$OpenSshArchive,
    [ValidatePattern('^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$')][string]$Version='0.1.0'
)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot 'pe.ps1')
$node=(Resolve-Path -LiteralPath $NodeBinary).Path
$sha=(Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
if($sha-ne$ExpectedSha256.ToLowerInvariant()){throw 'The reviewed Node binary has changed'}
$bytes=[IO.File]::ReadAllBytes($node)
if($bytes.Length-lt256 -or $bytes[0]-ne77 -or $bytes[1]-ne90){throw 'Node is not a Windows PE image'}
$pe=[BitConverter]::ToInt32($bytes,60)
if($pe-lt64 -or $pe+6-ge$bytes.Length -or [BitConverter]::ToUInt16($bytes,$pe+4)-ne0x8664){throw 'This package requires a Windows x64 Node'}
$nodeImports=@(GetReachPeImports $node);AssertReachRuntimeBundled $nodeImports
$reportedVersion=(& $node --version | Out-String).Trim()
if($LASTEXITCODE-ne0 -or $reportedVersion-cne"ryreach $Version"){throw 'Node and installer version differ'}
$output=Join-Path $project ('outputs/windows-node-'+$sha.Substring(0,16))
$null=[IO.Directory]::CreateDirectory($output)
$openSshPayload=& (Join-Path $PSScriptRoot 'prepare-openssh.ps1') -Archive $OpenSshArchive -Destination (Join-Path $output 'openssh-vendor.zip')
$packages=@{}
$priorRustflags=$env:RUSTFLAGS;$priorEncodedRustflags=$env:CARGO_ENCODED_RUSTFLAGS
$priorOpenSsh=$env:REACH_SETUP_OPENSSH
$priorVersion=$env:REACH_RELEASE_VERSION
Push-Location $project
try {
    foreach($manifest in @('Cargo.toml','packaging/windows/setup/Cargo.toml')){
        $metadata=(& cargo metadata --manifest-path $manifest --locked --offline --format-version 1 --filter-platform x86_64-pc-windows-msvc | ConvertFrom-Json)
        if($LASTEXITCODE-ne0){throw "Dependency inventory failed for $manifest"}
        $reachable=@{};$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($metadata.resolve.root)
        $nodes=@{};foreach($item in $metadata.resolve.nodes){$nodes[$item.id]=$item}
        while($queue.Count){$id=$queue.Dequeue();if($reachable.ContainsKey($id)){continue};$reachable[$id]=$true;foreach($dependency in $nodes[$id].deps){$queue.Enqueue($dependency.pkg)}}
        foreach($package in $metadata.packages){if($reachable.ContainsKey($package.id) -and $null-ne$package.source){$packages[$package.id]=$package}}
    }
    $notices=[Text.StringBuilder]::new()
    [void]$notices.AppendLine('Reach Node and Reach Setup - third-party notices')
    [void]$notices.AppendLine('Copyright (c) Ray Zhang. This candidate does not include the desktop backend.')
    $sysroot=(& rustc --print sysroot | Out-String).Trim()
    if($LASTEXITCODE-ne0){throw 'Rust runtime provenance unavailable'}
    $runtimeDocs=Join-Path $sysroot 'share/doc/rust'
    $runtimeFiles=@('COPYRIGHT-library.html','licenses/Apache-2.0.txt','licenses/MIT.txt','licenses/LLVM-exception.txt','licenses/BSD-2-Clause.txt','licenses/ISC.txt','licenses/Unicode-3.0.txt')
    [void]$notices.AppendLine("`n=== Rust standard library and runtime: original copyright documentation ===")
    foreach($relative in $runtimeFiles){
        $file=Join-Path $runtimeDocs $relative
        if(-not [IO.File]::Exists($file)){throw "Rust runtime notice missing: $relative"}
        [void]$notices.AppendLine("--- $relative ---");[void]$notices.AppendLine([IO.File]::ReadAllText($file))
    }
    $inventory=@()
    foreach($package in ($packages.Values|Sort-Object name,version)){
        $directory=Split-Path $package.manifest_path
        $files=@(Get-ChildItem -LiteralPath $directory -File -Recurse | Where-Object {$_.Name-match'^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)([.\-_]|$)'})
        if($package.license_file){$explicit=Join-Path $directory $package.license_file;if($files.FullName-notcontains$explicit){$files+=Get-Item -LiteralPath $explicit}}
        if($files.Count-eq0){throw "Missing license text: $($package.name) $($package.version)"}
        [void]$notices.AppendLine("`n=== $($package.name) $($package.version) | $($package.license) ===")
        $licenseFiles=@()
        foreach($file in ($files|Sort-Object FullName -Unique)){
            $relative=$file.FullName.Substring($directory.Length).TrimStart('\','/')
            [void]$notices.AppendLine("--- $relative ---")
            [void]$notices.AppendLine([IO.File]::ReadAllText($file.FullName))
            $licenseFiles+=@{path=$relative;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
        $inventory+=@{name=$package.name;version=$package.version;license=$package.license;source=$package.source;files=$licenseFiles}
    }
    [void]$notices.AppendLine("`nSQLite bundled C library: dedicated to the public domain; see https://sqlite.org/copyright.html. No SQLCipher backend is enabled.")
    $noticesPath=Join-Path $output 'THIRD_PARTY_NOTICES.txt'
    [IO.File]::WriteAllText($noticesPath,$notices.ToString(),[Text.UTF8Encoding]::new($false))
    $inventory|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $output 'dependency-inventory.json') -Encoding utf8
    $env:REACH_SETUP_KIND='node'
    $env:REACH_RELEASE_VERSION=$Version
    $env:REACH_SETUP_OPENSSH=$openSshPayload
    $env:REACH_SETUP_NODE=$node;$env:REACH_SETUP_SHA=$sha;$env:REACH_SETUP_NOTICES=$noticesPath
    $env:CARGO_TARGET_DIR=if($env:REACH_SETUP_TARGET_DIR){[IO.Path]::GetFullPath($env:REACH_SETUP_TARGET_DIR)}else{Join-Path $project 'work/setup-target'}
    $scriptPath=Join-Path $PSScriptRoot 'install.ps1'
    $scriptSha=(Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $noticesSha=(Get-FileHash -LiteralPath $noticesPath -Algorithm SHA256).Hash.ToLowerInvariant()
    # Setup itself must start before any installed application/runtime exists.
    $env:RUSTFLAGS='-C target-feature=+crt-static';$env:CARGO_ENCODED_RUSTFLAGS=$null
    & cargo build --manifest-path packaging/windows/setup/Cargo.toml --target x86_64-pc-windows-msvc --release --locked
    if($LASTEXITCODE-ne0){throw 'Setup compilation failed'}
    $built=Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release/ry-reach-setup.exe'
    $setupImports=@(GetReachPeImports $built);AssertReachRuntimeBundled $setupImports
    $setupSha=(Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash.ToLowerInvariant()
    $installer=Join-Path $output ('Reach-Node-Setup-'+$Version+'-preview-'+$setupSha.Substring(0,16)+'.exe')
    Copy-Item -LiteralPath $built -Destination $installer -Force
    $inspect=(& $installer --inspect | Out-String)
    if($LASTEXITCODE-ne0 -or -not $inspect.Contains('node_sha256='+$sha) -or -not $inspect.Contains('script_sha256='+$scriptSha) -or -not $inspect.Contains('notices_sha256='+$noticesSha)){throw 'Embedded package inspection failed'}
    if(-not $inspect.Contains('openssh_sha256=23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5') -or
        -not $inspect.Contains('ssh_preparation_sha256='+(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'ssh.ps1')).Hash.ToLowerInvariant())){throw 'Embedded OpenSSH inspection failed'}
    if((Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()-cne$scriptSha -or (Get-FileHash -LiteralPath $noticesPath -Algorithm SHA256).Hash.ToLowerInvariant()-cne$noticesSha){throw 'Embedded source changed during build'}
    [IO.File]::WriteAllText((Join-Path $output 'inspect.txt'),$inspect,[Text.UTF8Encoding]::new($false))
    $record=@{schema=1;version=$Version;kind='node-installer-preview';architecture='x86_64-pc-windows-msvc';desktopBundled=$false;installationTested=$false;codeSigned=$false;nodeSha256=$sha;nodeImports=$nodeImports;setupImports=$setupImports;installerName=[IO.Path]::GetFileName($installer);installerSha256=$setupSha;scriptSha256=$scriptSha;noticesSha256=$noticesSha;dependencyCount=$inventory.Count}
    $record.openSshSha256=(Get-FileHash -LiteralPath $openSshPayload -Algorithm SHA256).Hash.ToLowerInvariant()
    $record|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $output 'package.json') -Encoding utf8
    Write-Output $installer
    Write-Output $inspect
}finally{$env:RUSTFLAGS=$priorRustflags;$env:CARGO_ENCODED_RUSTFLAGS=$priorEncodedRustflags;$env:REACH_SETUP_OPENSSH=$priorOpenSsh;$env:REACH_RELEASE_VERSION=$priorVersion;Pop-Location}
