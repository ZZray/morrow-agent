# Copyright (c) Ray Zhang. Select the pinned vendor archive from Starferry's reviewed offline bundle.
param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$vendorSha='23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5'
$bundleSha='a31831bc07c26b88c7d5bf2fda108f14add3d90faea51002ec1a62de56c1b234'
$source=(Resolve-Path -LiteralPath $Archive).Path
$sha=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sha -eq $vendorSha) { $bytes=[IO.File]::ReadAllBytes($source) }
elseif ($sha -eq $bundleSha) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip=[IO.Compression.ZipFile]::OpenRead($source)
    try {
        $entry=$zip.GetEntry('OpenSSH-Win64-stable.zip')
        if (-not $entry) { throw 'Reviewed vendor archive is missing' }
        $input=$entry.Open(); $output=[IO.MemoryStream]::new()
        try { $input.CopyTo($output); $bytes=$output.ToArray() } finally { $output.Dispose(); $input.Dispose() }
    } finally { $zip.Dispose() }
} else { throw 'OpenSSH archive differs from the reviewed offline payload' }
$hasher=[Security.Cryptography.SHA256]::Create()
try { $actual=([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
if ($actual -cne $vendorSha) { throw 'Vendor OpenSSH archive hash mismatch' }
# The wrapper's unrelated authorized_keys and installation script are never packaged.
[IO.File]::WriteAllBytes($Destination,$bytes)
Write-Output ([IO.Path]::GetFullPath($Destination))
