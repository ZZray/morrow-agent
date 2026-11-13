# Copyright (c) Ray Zhang. Audit the actual independent workspaces, without changing policies or locks.
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(Test-Path -LiteralPath $Destination){throw 'Use a new dependency-audit destination'}
$destinationPath=[IO.Path]::GetFullPath($Destination);$null=[IO.Directory]::CreateDirectory($destinationPath)
function AuditHash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function AssertReachPinnedAgentSources($Metadata,[bool]$RequireAgent=$false){
    $expected='git+https://github.com/bigfish1913/pi-rust.git?rev=8ec462672d90e62712d96074638efef89436cebe#8ec462672d90e62712d96074638efef89436cebe'
    $git=@($Metadata.packages|Where-Object {$null-ne$_.source -and $_.source.StartsWith('git+')})
    foreach($package in $git){if($package.source-cne$expected -or $package.name-cnotin@('rpi-agent','rpi-ai','rpi-telemetry') -or $package.version-cne'0.3.23'){throw 'Agent dependency differs from the reviewed fixed upstream'}}
    if($RequireAgent -and (($git.Count-ne3) -or ((@($git|ForEach-Object{$_.name}|Sort-Object)-join',')-cne'rpi-agent,rpi-ai,rpi-telemetry'))){throw 'Agent workspace lost its exact fixed upstream package set'}
}
$records=@()
foreach($entry in @(
    @('node','Cargo.toml','deny.toml','Cargo.lock'),
    @('desktop','desktop/Cargo.toml','desktop/deny.toml','desktop/Cargo.lock'),
    @('setup','packaging/windows/setup/Cargo.toml','deny.toml','packaging/windows/setup/Cargo.lock'),
    # The Morrow runtime packages share the parent repository's workspace lock.
    @('agent','../../crates/morrow-agent-jsonl/Cargo.toml','../../crates/morrow-agent-core/deny.toml','../../Cargo.lock')
)){
    $name=$entry[0];$manifest=Join-Path $project $entry[1];$policy=Join-Path $project $entry[2];$lock=Join-Path $project $entry[3]
    $before=AuditHash $lock;$policySha=AuditHash $policy;$manifestSha=AuditHash $manifest
    $metadataPath=Join-Path $destinationPath ($name+'-metadata.json');$auditLog=Join-Path $destinationPath ($name+'-deny.log')
    & cargo metadata --manifest-path $manifest --locked --offline --all-features --format-version 1 > $metadataPath
    if($LASTEXITCODE-ne0){throw "Locked dependency resolution failed: $name"}
    $metadata=Get-Content -LiteralPath $metadataPath -Raw|ConvertFrom-Json
    AssertReachPinnedAgentSources $metadata ($name-in@('desktop','agent'))
    & cargo deny --manifest-path $manifest --config $policy --all-features --locked --offline check *> $auditLog
    if($LASTEXITCODE-ne0){throw "Dependency audit failed: $name; see $auditLog"}
    if((AuditHash $lock)-cne$before -or (AuditHash $policy)-cne$policySha -or (AuditHash $manifest)-cne$manifestSha){throw 'Dependency audit input changed'}
    $records+=@{workspace=$name;manifest=[IO.Path]::GetFullPath($manifest);manifestSha256=$manifestSha;lock=[IO.Path]::GetFullPath($lock);lockSha256=$before;policy=[IO.Path]::GetFullPath($policy);policySha256=$policySha;metadataSha256=(AuditHash $metadataPath);auditLogSha256=(AuditHash $auditLog);packages=@($metadata.packages).Count}
}
[IO.File]::WriteAllText((Join-Path $destinationPath 'audit.json'),(@{schema=1;network=$false;policiesChanged=$false;upstreamRevision='8ec462672d90e62712d96074638efef89436cebe';workspaces=$records}|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
Write-Output ('PASS '+$records.Count+' independent workspace dependency audits')
