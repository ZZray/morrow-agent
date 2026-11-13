# Copyright (c) Ray Zhang. Read-only x64 PE import inventory for package validation.
function GetReachPeImports([string]$Path) {
    $image=[IO.File]::ReadAllBytes($Path)
    if($image.Length-lt256 -or $image[0]-ne77 -or $image[1]-ne90){throw 'Not a Windows PE image'}
    $pe=[BitConverter]::ToInt32($image,60)
    if($pe-lt64 -or $pe+264-ge$image.Length -or [BitConverter]::ToUInt32($image,$pe)-ne0x4550 -or [BitConverter]::ToUInt16($image,$pe+4)-ne0x8664){throw 'Not a Windows x64 PE image'}
    $optional=$pe+24
    if([BitConverter]::ToUInt16($image,$optional)-ne0x20b){throw 'Not a PE32+ image'}
    $sectionOffset=$optional+[BitConverter]::ToUInt16($image,$pe+20)
    $sections=@()
    for($index=0;$index-lt[BitConverter]::ToUInt16($image,$pe+6);$index++){
        $offset=$sectionOffset+40*$index
        $sections+=@{rva=[BitConverter]::ToUInt32($image,$offset+12);size=[Math]::Max([BitConverter]::ToUInt32($image,$offset+8),[BitConverter]::ToUInt32($image,$offset+16));offset=[BitConverter]::ToUInt32($image,$offset+20)}
    }
    function FileOffset([uint32]$Rva) {
        foreach($section in $sections){if($Rva-ge$section.rva -and $Rva-lt($section.rva+$section.size)){return [int]($section.offset+$Rva-$section.rva)}}
        throw 'Import address outside PE sections'
    }
    $importRva=[BitConverter]::ToUInt32($image,$optional+120)
    if($importRva-eq0){return @()}
    $offset=FileOffset $importRva;$names=@()
    for($count=0;$count-lt1024;$count++){
        $nameRva=[BitConverter]::ToUInt32($image,$offset+12)
        if($nameRva-eq0){return $names}
        $nameOffset=FileOffset $nameRva;$end=$nameOffset
        while($end-lt$image.Length -and $image[$end]-ne0){$end++}
        if($end-eq$image.Length){throw 'Unterminated import name'}
        $names+=[Text.Encoding]::ASCII.GetString($image,$nameOffset,$end-$nameOffset);$offset+=20
    }
    throw 'PE import table exceeds validation bound'
}
function AssertReachRuntimeBundled([string[]]$Imports) {
    $external=@($Imports|Where-Object{$_-match'^(vcruntime|msvcp|msvcr)[0-9].*\.dll$|^api-ms-win-crt-|^ucrtbase\.dll$'})
    if($external.Count){throw ('External VC runtime dependency in installer candidate: '+($external-join ', '))}
}
