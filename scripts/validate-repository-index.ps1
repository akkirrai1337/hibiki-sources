function Assert-RepositoryIndex {
    param([object]$Index)

    if ($null -eq $Index -or $Index.apiVersion -isnot [int] -or $Index.apiVersion -ne 1 -or $null -eq $Index.sources) {
        throw "Repository index has an invalid envelope"
    }
    $sources = @($Index.sources)
    $sourceIds = @($sources | ForEach-Object {
        if ($null -eq $_ -or $_ -is [string]) { throw "Repository index contains an invalid source manifest" }
        Assert-PackageManifest $_
        $_.sourceId
    })
    $hasBlankId = @($sourceIds | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0
    $hasDuplicateId = @($sourceIds | Sort-Object -Unique).Count -ne $sourceIds.Count
    if ($hasBlankId -or $hasDuplicateId) {
        throw "Repository index contains blank or duplicate sourceId values"
    }
}
