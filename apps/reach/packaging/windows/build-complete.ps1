# Copyright (c) Ray Zhang. Build and inspect a full candidate; does not install it.
param(
    [Parameter(Mandatory=$true)][string]$NodeBinary,
    [Parameter(Mandatory=$true)][string]$NodeSha256,
    [Parameter(Mandatory=$true)][string]$DesktopBinary,
    [Parameter(Mandatory=$true)][string]$DesktopSha256,
    [Parameter(Mandatory=$true)][string]$AgentBinary,
    [Parameter(Mandatory=$true)][string]$AgentSha256,
    [Parameter(Mandatory=$true)][string]$Runtime,
    [Parameter(Mandatory=$true)][string]$RuntimeManifestSha256,
    [Parameter(Mandatory=$true)][string]$BuildPython
)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot 'pe.ps1')
function Hash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
foreach($binary in @($NodeBinary,$DesktopBinary,$AgentBinary)){AssertReachRuntimeBundled @(GetReachPeImports $binary)}
if((Hash $NodeBinary)-cne$NodeSha256 -or (Hash $DesktopBinary)-cne$DesktopSha256 -or (Hash $AgentBinary)-cne$AgentSha256){throw 'Reviewed executable changed'}
$work=Join-Path $project ('work/full-package-'+[Guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($work)
& (Join-Path $PSScriptRoot 'audit-dependencies.ps1') -Destination (Join-Path $work 'dependency-audit')
$notices=Join-Path $work 'THIRD_PARTY_NOTICES.txt'
& (Join-Path $PSScriptRoot 'collect-notices.ps1') -Destination $notices -Runtime $Runtime
$payload=Join-Path $work 'payload.zip'
& $BuildPython -I -B (Join-Path $PSScriptRoot 'build-payload.py') --node $NodeBinary --node-sha $NodeSha256 --helper $DesktopBinary --helper-sha $DesktopSha256 --agent $AgentBinary --agent-sha $AgentSha256 --runtime $Runtime --runtime-sha $RuntimeManifestSha256 --notices $notices --destination $payload
if($LASTEXITCODE-ne0){throw 'Complete payload assembly failed'}
$receipt=Get-Content -LiteralPath (Join-Path $work 'payload.json') -Raw|ConvertFrom-Json
if($receipt.schema-ne2 -or $receipt.agentBundled-ne$true -or $receipt.agentSha256-cne$AgentSha256){throw 'Complete candidate must include the reviewed Agent'}
$sourceInputs=[ordered]@{}
foreach($relative in @('install.ps1','payload.ps1','ownership.ps1','maintenance-writes.ps1','maintenance-entry.ps1','uninstall-files.ps1','uninstall-transaction.ps1','uninstall-host.ps1','setup/src/main.rs','setup/build.rs','setup/Cargo.toml','setup/Cargo.lock','resources.rs','build-complete.ps1','audit-dependencies.ps1','collect-notices.ps1','notices/sources.json','build-payload.py','../../src/windows_identity.rs','../../assets/brand/reach.ico')){
    $sourceInputs[$relative]=Hash (Join-Path $PSScriptRoot $relative)
}
$sourceBytes=[Text.UTF8Encoding]::new($false).GetBytes(($sourceInputs|ConvertTo-Json -Compress));$sourceHasher=[Security.Cryptography.SHA256]::Create()
try{$sourceIdentity=([BitConverter]::ToString($sourceHasher.ComputeHash($sourceBytes))).Replace('-','').ToLowerInvariant()}finally{$sourceHasher.Dispose()}
$output=Join-Path $project ('outputs/windows-complete-'+$receipt.packageSha256.Substring(0,16)+'-'+$sourceIdentity.Substring(0,12))
if(Test-Path -LiteralPath $output){throw 'Preserve existing package outputs'}
$null=[IO.Directory]::CreateDirectory($output)
$prior=@{};foreach($name in @('CARGO_TARGET_DIR','CARGO_BUILD_JOBS','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','REACH_SETUP_KIND','REACH_SETUP_NODE','REACH_SETUP_SHA','REACH_SETUP_NOTICES','REACH_SETUP_MANIFEST_SHA','REACH_SETUP_COMPONENT_NODE_SHA','REACH_SETUP_AGENT_SHA')){$prior[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Push-Location $project
try {
    $env:REACH_SETUP_KIND='complete';$env:REACH_SETUP_NODE=$payload;$env:REACH_SETUP_SHA=$receipt.packageSha256
    $env:REACH_SETUP_NOTICES=$notices;$env:REACH_SETUP_MANIFEST_SHA=$receipt.payloadManifestSha256;$env:REACH_SETUP_COMPONENT_NODE_SHA=$receipt.nodeSha256
    $env:REACH_SETUP_AGENT_SHA=$AgentSha256
    $env:CARGO_TARGET_DIR='E:/usr/var/cache/rust-target/reach-static';$env:CARGO_BUILD_JOBS='1';$env:RUSTFLAGS='-C target-feature=+crt-static';$env:CARGO_ENCODED_RUSTFLAGS=$null
    $scriptSha=Hash (Join-Path $PSScriptRoot 'install.ps1');$checksSha=Hash (Join-Path $PSScriptRoot 'payload.ps1');$noticesSha=Hash $notices
    & cargo build --manifest-path packaging/windows/setup/Cargo.toml --target x86_64-pc-windows-msvc --release --locked --offline
    if($LASTEXITCODE-ne0){throw 'Complete installer compilation failed'}
    $built=Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release/ry-reach-setup.exe'
    $imports=@(GetReachPeImports $built);AssertReachRuntimeBundled $imports
    $setupSha=Hash $built;$installer=Join-Path $output ('Reach-Setup-0.1.0-preview-'+$setupSha.Substring(0,16)+'.exe')
    Copy-Item -LiteralPath $built -Destination $installer
    $inspect=(& $installer --inspect | Out-String);if($LASTEXITCODE-ne0){throw 'Complete installer inspect failed'}
    foreach($pair in @(@('payload_sha256',$receipt.packageSha256),@('node_sha256',$NodeSha256),@('payload_manifest_sha256',$receipt.payloadManifestSha256),@('script_sha256',$scriptSha),@('payload_checks_sha256',$checksSha),@('notices_sha256',$noticesSha),@('desktop_bundled','true'),@('agent_bundled','true'),@('agent_sha256',$AgentSha256),@('ownership_sha256',$sourceInputs['ownership.ps1']),@('maintenance_writes_sha256',$sourceInputs['maintenance-writes.ps1']))){if(-not $inspect.Contains(($pair[0]+'='+$pair[1]))){throw "Embedded identity differs: $($pair[0])"}}
    foreach($module in @('maintenance-entry','uninstall-files','uninstall-transaction','uninstall-host')){if(-not $inspect.Contains(($module.Replace('-','_')+'_sha256='+$sourceInputs[$module+'.ps1']))){throw "Embedded maintenance module differs: $module"}}
    $recoverySource="`$MaintenanceOperation='uninstall'`n"
    foreach($module in @('payload','ownership','maintenance-writes','maintenance-entry','uninstall-files','uninstall-transaction','uninstall-host','install')){$recoverySource+=[IO.File]::ReadAllText((Join-Path $PSScriptRoot ($module+'.ps1')))+"`n"}
    $recoveryHasher=[Security.Cryptography.SHA256]::Create()
    try{$recoverySha=([BitConverter]::ToString($recoveryHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($recoverySource)))).Replace('-','').ToLowerInvariant()}finally{$recoveryHasher.Dispose()}
    if(-not $inspect.Contains('recovery_script_sha256='+$recoverySha)){throw 'Embedded recovery entry differs from the shared source'}
    [IO.File]::WriteAllText((Join-Path $output 'inspect.txt'),$inspect,[Text.UTF8Encoding]::new($false))
    $verified=(& $installer --verify-payload | Out-String);if($LASTEXITCODE-ne0 -or -not $verified.Contains('verified_files='+$receipt.files)){throw "Embedded payload verification failed: $verified"}
    [IO.File]::WriteAllText((Join-Path $output 'verify-payload.txt'),$verified,[Text.UTF8Encoding]::new($false))
    if((Hash (Join-Path $PSScriptRoot 'install.ps1'))-cne$scriptSha -or (Hash (Join-Path $PSScriptRoot 'payload.ps1'))-cne$checksSha -or (Hash $payload)-cne$receipt.packageSha256){throw 'Build input changed during assembly'}
    foreach($relative in $sourceInputs.Keys){if((Hash (Join-Path $PSScriptRoot $relative))-cne$sourceInputs[$relative]){throw "Installer source changed during assembly: $relative"}}
    $audit=Get-Content -LiteralPath (Join-Path $work 'dependency-audit/audit.json') -Raw|ConvertFrom-Json
    foreach($item in $audit.workspaces){if((Hash $item.manifest)-cne$item.manifestSha256 -or (Hash $item.lock)-cne$item.lockSha256 -or (Hash $item.policy)-cne$item.policySha256){throw 'Audited dependency inputs changed during assembly'}}
    $record=@{schema=2;kind='complete-installer-preview';version='0.1.0';desktopBundled=$true;agentBundled=$true;agentSha256=$AgentSha256;installationTested=$false;codeSigned=$false;installerName=[IO.Path]::GetFileName($installer);installerSha256=$setupSha;payload=$receipt;scriptSha256=$scriptSha;payloadChecksSha256=$checksSha;noticesSha256=$noticesSha;dependencyAuditSha256=(Hash (Join-Path $work 'dependency-audit/audit.json'));setupImports=$imports;buildDirectory=$work;sourceIdentity=$sourceIdentity;sourceInputs=$sourceInputs}
    [IO.File]::WriteAllText((Join-Path $output 'package.json'),($record|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Write-Output $installer;Write-Output $verified
}finally{foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name],'Process')};Pop-Location}
