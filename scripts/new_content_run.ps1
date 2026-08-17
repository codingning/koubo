param(
    [Parameter(Mandatory = $true)][string]$Slug,
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$safeSlug = ($Slug -replace '[^a-zA-Z0-9_-]', '-').Trim('-')
if (-not $safeSlug) { throw 'Slug不能为空' }
$runDir = Join-Path $root (Join-Path 'runs' (Join-Path $Date (Join-Path 'content' $safeSlug)))
if (Test-Path -LiteralPath $runDir) { throw "内容目录已存在：$runDir" }
New-Item -ItemType Directory -Path $runDir | Out-Null

$files = @{
    '00_evidence.md' = 'content_evidence.md'
    '01_topic_research.md' = 'topic_research.md'
    '02_content_package.md' = 'content_package.md'
    '03_review_checklist.md' = 'review_checklist.md'
}
foreach ($entry in $files.GetEnumerator()) {
    $source = Join-Path $root (Join-Path 'templates' $entry.Value)
    $target = Join-Path $runDir $entry.Key
    $text = (Get-Content -Raw -Encoding UTF8 -LiteralPath $source).Replace('{{DATE}}', $Date).Replace('{{CUTOFF}}', (Get-Date -Format 'yyyy-MM-dd HH:mm'))
    Set-Content -Encoding UTF8 -LiteralPath $target -Value $text
}
Write-Output $runDir
