param(
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
    [int]$Day = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root "runs\$Date"
$growthDir = Join-Path $runDir 'growth'
$rawDir = Join-Path $runDir 'raw'
New-Item -ItemType Directory -Force -Path $growthDir | Out-Null
New-Item -ItemType Directory -Force -Path $rawDir | Out-Null

if($Day -le 0){
    try { $Day = [Math]::Max(1, (([datetime]$Date) - ([datetime]'2026-07-15')).Days + 1) }
    catch { $Day = 1 }
}

$cutoff = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
$templates = @{
    '00_daily_progress.md' = 'daily_progress.md'
    '01_candidates.md' = 'daily_research.md'
    '02_main_package.md' = 'daily_content_package.md'
    '04_review_checklist.md' = 'review_checklist.md'
}

foreach($entry in $templates.GetEnumerator()){
    $target = Join-Path $growthDir $entry.Key
    if(-not (Test-Path -LiteralPath $target)){
        $content = Get-Content -LiteralPath (Join-Path $root "templates\$($entry.Value)") -Raw -Encoding utf8
        $content = $content.Replace('{{DATE}}',$Date).Replace('{{CUTOFF}}',$cutoff).Replace('{{DAY}}',[string]$Day)
        $content | Set-Content -LiteralPath $target -Encoding utf8
    }
}

$sourcesPath = Join-Path $growthDir '03_sources.csv'
if(-not (Test-Path -LiteralPath $sourcesPath)){
    'item,date,source_level,source_type,name,path_or_url,public_evidence,verification_status,privacy_or_copyright_notes' | Set-Content -LiteralPath $sourcesPath -Encoding utf8
}

Write-Host "Growth daily run ready without overwriting existing files: $growthDir"
