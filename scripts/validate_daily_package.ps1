param(
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root "runs\$Date"
$growthDir = Join-Path $runDir 'growth'
$errors = [System.Collections.Generic.List[string]]::new()

$requiredFiles = @('00_daily_progress.md','01_candidates.md','02_main_package.md','03_sources.csv','04_review_checklist.md')
foreach($file in $requiredFiles){
    if(-not (Test-Path -LiteralPath (Join-Path $growthDir $file))){ $errors.Add("缺少成长型文件：growth/$file") }
}

$progressPath = Join-Path $growthDir '00_daily_progress.md'
if(Test-Path -LiteralPath $progressPath){
    $text = Get-Content -LiteralPath $progressPath -Raw -Encoding utf8
    foreach($heading in @('## 1. 昨日挑战与今日验证','## 2. 当天真实Codex任务','## 4. 真实错误、失败和返工','## 5. 可公开证据清单','## 6. 真实粉丝问题','## 8. 今日证据卡','## 9. 隐私、版权和公开边界')){
        if(-not $text.Contains($heading)){ $errors.Add("真实进展记录缺少章节：$heading") }
    }
}

$candidatePath = Join-Path $growthDir '01_candidates.md'
if(Test-Path -LiteralPath $candidatePath){
    $text = Get-Content -LiteralPath $candidatePath -Raw -Encoding utf8
    foreach($label in @('今日进度型','今日踩坑型','成果展示型','AI热点亲测型')){
        if(-not $text.Contains($label)){ $errors.Add("候选文件缺少固定方向：$label") }
    }
    if($text -notmatch '成长反思|真实粉丝共创型|真实问题共创型'){ $errors.Add('候选文件缺少成长反思或真实问题共创方向') }
    $numberedRows = ([regex]::Matches($text,'(?m)^\|\s*[1-5]\s*\|')).Count
    if($numberedRows -gt 5){ $errors.Add("候选方向超过5个：$numberedRows") }
    foreach($label in @('主选题：','备选1：','备选2：','空缺方向及原因：')){
        if(-not $text.Contains($label)){ $errors.Add("候选文件缺少推荐字段：$label") }
    }
}

$packagePath = Join-Path $growthDir '02_main_package.md'
if(Test-Path -LiteralPath $packagePath){
    $text = Get-Content -LiteralPath $packagePath -Raw -Encoding utf8
    $fullHeading = if([datetime]$Date -ge [datetime]'2026-07-21'){'## 7. 2—3分钟完整版口播稿'}else{'## 7. 45—90秒完整版口播稿'}
    $shortHeading = if([datetime]$Date -ge [datetime]'2026-07-21'){'## 8. 60—90秒衍生短版'}else{'## 8. 30—45秒精简稿'}
    $headings = @(
        '## 1. 今日真实进展摘要','## 2. 可公开证据清单','## 3. 最多5个候选选题','## 4. 主选题和2个备选',
        '## 6. 一句话观众收益',$fullHeading,$shortHeading,
        '## 9. 5个标题','## 10. 3套封面方案','## 11. 拍摄和B-roll清单','## 12. 平台发布文案',
        '## 13. 实际使用的热点和资料来源','## 14. 事实、隐私、版权和夸张表达检查','## 15. 明日挑战或下一集悬念','## 16. 发布后需要回填的数据'
    )
    foreach($heading in $headings){ if(-not $text.Contains($heading)){ $errors.Add("素材包缺少章节：$heading") } }
    if($text -notmatch '## 5\. 本集在(?:30天)?成长故事中的位置'){ $errors.Add('素材包缺少章节：## 5. 本集在成长故事中的位置') }
    $scriptText = if($text -match '(?s)## 7\. (?:45—90秒|2—3分钟)完整版口播稿(.*?)## 9\. 5个标题'){ $Matches[1] }else{ '' }
    foreach($banned in @('今天来分享一下','你怎么看','欢迎评论区留言','记得点赞关注','点赞收藏转发')){
        if($scriptText.Contains($banned)){ $errors.Add("口播稿包含空泛或机械表达：$banned") }
    }
    if([datetime]$Date -ge [datetime]'2026-07-17'){
        foreach($required in @('观众代入点','观众最小任务','评论问题','持续关注理由','轻松点')){
            if(-not $text.Contains($required)){ $errors.Add("素材包缺少观众互动设计：$required") }
        }
    }
    if([datetime]$Date -ge [datetime]'2026-07-21'){
        foreach($required in @('同题视频研究','来源ID','全文核验','禁止复制')){
            if(-not $text.Contains($required)){ $errors.Add("素材包缺少同题视频研究字段：$required") }
        }
        $compactScript = [regex]::Replace($scriptText,'[\s，。！？、；：,.!?;:‘’“”"''（）()《》【】\[\]—…·]','')
        if($compactScript.Length -lt 550 -or $compactScript.Length -gt 950){ $errors.Add("2—3分钟完整版有效字符应为550—950，当前为$($compactScript.Length)") }
    }
    if($text -match '粉丝问题我来实测' -and $text -notmatch '未收到|没有真实粉丝问题|不适用'){
        $progress = if(Test-Path $progressPath){ Get-Content -LiteralPath $progressPath -Raw -Encoding utf8 }else{''}
        if($progress -notmatch '是否收到：\s*是'){ $errors.Add('使用了粉丝共创栏目，但进展记录未证明收到真实问题') }
    }
}

$legacyDir = Join-Path $root 'runs\2026-07-15'
foreach($legacyFile in @('01_candidates.md','02_main_package.md','03_sources.csv','04_review_checklist.md')){
    if(-not (Test-Path -LiteralPath (Join-Path $legacyDir $legacyFile))){ $errors.Add("旧Day 1基线资料缺失：$legacyFile") }
}
$legacyMarker = Join-Path $legacyDir 'LEGACY_BASELINE.md'
if(-not (Test-Path -LiteralPath $legacyMarker)){ $errors.Add('旧Day 1尚未标记为旧定位基线样本') }

if($errors.Count -gt 0){
    Write-Host 'VALIDATION FAILED' -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "- $_" -ForegroundColor Red }
    exit 1
}

Write-Host "VALIDATION PASSED: $growthDir" -ForegroundColor Green
