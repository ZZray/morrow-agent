# Copyright (c) Ray Zhang. Historical schema4 install-only writer barrier fixture.
# Exact functions from install.ps1 SHA256 f221fdc37835b3be9a400d7e0cc2fcc236ed2374438a99895272b55ba59fdfd6 (08a3 installer).
function RecoverJournal {
      if([IO.File]::Exists($journalPath)){
        $prior=ReadJson $journalPath
        if($prior.schema-notin@(1,2,4) -or ($prior.schema-in@(2,4) -and $prior.operation-cne'install') -or $prior.phase-notin@('staged','stopping','switching','restored','committed','rolled_back','recovered')){throw 'Unsupported installation journal'}
        if($prior.phase -notin @('committed','rolled_back','recovered')) {Restore $prior;$prior.phase='recovered';WriteJson $journalPath $prior}
      }
    }
function ValidateManifestIdentity($record) {
        if($record.schema-notin@(1,2) -or $record.version-ne'0.1.0' -or $record.nodeStateSchema-ne1 -or $record.sha256-notmatch'^[0-9a-f]{64}$' -or $record.bindingOwner-notmatch'^S-1-[0-9-]+$'){throw 'Unsupported existing installation record'}
        $versionKey=$record.sha256.Substring(0,16)
        if($record.schema-eq2){
            if($record.packageSha256-notmatch'^[0-9a-f]{64}$' -or $record.payloadManifestSha256-notmatch'^[0-9a-f]{64}$' -or $record.desktopBundled-isnot[bool] -or -not $record.desktopBundled){throw 'Unsupported complete installation record'}
            $versionKey=$record.packageSha256
        }
        $expected=Join-Path (Join-Path $versions ($record.version+'-'+$versionKey)) 'reach.exe'
        if($record.nodePath-cne$expected -or $record.servicePath-cne('"'+$expected+'" --state-dir "'+$state+'" service --binding-owner '+$record.bindingOwner)){throw 'Existing installation path mismatch'}
        # Identity checks remain possible when a failed candidate lost a file.
        # The caller must validate bytes before starting a version.
        CheckPath $versions
        if([IO.Directory]::Exists((Split-Path $expected))){CheckPath (Split-Path $expected)}
        if([IO.File]::Exists($expected)){CheckPath $expected}
    }
