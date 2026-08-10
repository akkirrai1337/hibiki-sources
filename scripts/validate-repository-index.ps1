function Assert-RepositoryIndex {
    param([object]$Index)

    if ($null -eq $Index -or $Index.apiVersion -ne 1 -or $null -eq $Index.sources) {
        throw "Repository index has an invalid envelope"
    }
    $sources = @($Index.sources)
    $sourceIds = @($sources | ForEach-Object { [string]$_.sourceId })
    $hasBlankId = @($sourceIds | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0
    $hasDuplicateId = @($sourceIds | Sort-Object -Unique).Count -ne $sourceIds.Count
    if ($hasBlankId -or $hasDuplicateId) {
        throw "Repository index contains blank or duplicate sourceId values"
    }
}
