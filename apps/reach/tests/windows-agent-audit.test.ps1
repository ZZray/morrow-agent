# Copyright (c) Ray Zhang. Test the actual audit source gate against saved real metadata and changed sources.
param([Parameter(Mandatory=$true)][string]$Metadata)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../packaging/windows/audit-dependencies.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors.Message-join'; ')}
$definition=$ast.Find({param($a)$a-is[Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-ceq'AssertReachPinnedAgentSources'},$true)
. ([ScriptBlock]::Create($definition.Extent.Text))
$original=Get-Content -LiteralPath $Metadata -Raw|ConvertFrom-Json
$git=@($original.packages|Where-Object {$null-ne$_.source -and $_.source.StartsWith('git+')})
function Fresh {return (@{packages=$git}|ConvertTo-Json -Depth 32|ConvertFrom-Json)}
$script:cases=0
function Case([string]$Name,[scriptblock]$Action){&$Action;$script:cases++;Write-Output ('PASS '+$Name)}
function Refused($Value){$rejected=$false;try{AssertReachPinnedAgentSources $Value $true}catch{$rejected=$_.Exception.Message-match'fixed upstream'};if(-not $rejected){throw 'Changed upstream was accepted'}}
Case 'actual JSONL metadata retains all three original pinned packages' {AssertReachPinnedAgentSources $original $true}
Case 'Agent audit lock matches the actual Morrow workspace root' {
    $entry=$ast.Find({param($a)$a-is[Management.Automation.Language.ArrayLiteralAst] -and $a.Elements.Count-eq4 -and $a.Elements[0].Value-ceq'agent'},$true)
    if($null-eq$entry){throw 'Agent audit lacks an explicit workspace lock'}
    $project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $configured=[IO.Path]::GetFullPath((Join-Path $project $entry.Elements[3].Value))
    $actual=[IO.Path]::GetFullPath((Join-Path $original.workspace_root 'Cargo.lock'))
    if($configured-cne$actual -or -not[IO.File]::Exists($actual)){throw 'Agent audit lock differs from Cargo workspace metadata'}
}
Case 'changed revision is refused even if still a fixed git revision' {$v=Fresh;$v.packages[0].source=$v.packages[0].source.Replace('8ec462672d90e62712d96074638efef89436cebe',('a'*40));Refused $v}
Case 'another repository cannot inherit the Lite policy allowlist' {$v=Fresh;$v.packages[0].source=$v.packages[0].source.Replace('pi-rust.git','another.git');Refused $v}
Case 'changed package version is refused' {$v=Fresh;$v.packages[0].version='0.3.24';Refused $v}
Case 'unexpected package cannot reuse the allowed git source' {$v=Fresh;$v.packages[0].name='new-unreviewed-package';Refused $v}
Case 'missing Agent graph is refused for the Agent workspace' {Refused @{packages=@()}}
Case 'Node and Setup may have no git source' {AssertReachPinnedAgentSources @{packages=@()} $false}
Write-Output "PASS $script:cases fixed-source audit cases"
