param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$required = @('00_evidence.md','01_topic_research.md','02_content_package.md','03_review_checklist.md')
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path $file))) { throw "缺少文件：$file" }
}
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Path '02_content_package.md')
foreach ($section in @('## 1. 唯一核心问题与目标用户','## 3. 可交付资产','## 4. 结构与时长','## 6. 正式口播稿','## 10. 发布前检查')) {
    if (-not $package.Contains($section)) { throw "素材包缺少章节：$section" }
}
if ($package -match '30天|成长天数|Day \{\{') { throw '素材包仍包含已废止的30天或Day规划' }
Write-Output "VALIDATION PASSED: $Path"
