param(
    [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
    [int]$WindowHours = 48,
    [string[]]$Queries = @()
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root "runs\$Date"
$growthDir = Join-Path $runDir 'growth'
$rawDir = Join-Path $runDir 'raw'
& (Join-Path $PSScriptRoot 'new_daily_run.ps1') -Date $Date
New-Item -ItemType Directory -Force -Path $rawDir | Out-Null

$config = Get-Content -LiteralPath (Join-Path $root 'config\sources.json') -Raw -Encoding utf8 | ConvertFrom-Json
if($Queries.Count -eq 0){ $Queries = @($config.defaultQueries) }

$health = [System.Collections.Generic.List[string]]::new()
$health.Add("# AI热点辅助采集记录｜$Date")
$health.Add('')
$health.Add('- 用途：只为当天真实AI进展寻找相关切入点、亲测对象、标题和互动问题，不作为账号主线。')
$health.Add("- 检查时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$health.Add("- 查询词：$($Queries -join '；')")

function Invoke-Capture {
    param([string]$Name, [scriptblock]$Command, [string]$OutFile)
    try {
        $text = & $Command 2>&1 | Out-String
        $text | Set-Content -LiteralPath $OutFile -Encoding utf8
        $health.Add("- ${Name}：已执行，详见 raw/$([IO.Path]::GetFileName($OutFile))")
        return $true
    } catch {
        $_ | Out-String | Set-Content -LiteralPath $OutFile -Encoding utf8
        $health.Add("- ${Name}：失败，已降级；错误见 raw/$([IO.Path]::GetFileName($OutFile))")
        return $false
    }
}

Invoke-Capture 'Agent Reach' { agent-reach doctor --json } (Join-Path $rawDir 'agent_reach_doctor.json') | Out-Null
Invoke-Capture 'OpenCLI' { opencli doctor } (Join-Path $rawDir 'opencli_doctor.txt') | Out-Null

$opencliPs1 = 'H:\AgentReach\npm\opencli.ps1'
if(Test-Path -LiteralPath $opencliPs1){
    $i = 0
    foreach($query in $Queries){
        $i++
        $safe = ($query -replace '[^0-9A-Za-z\p{IsCJKUnifiedIdeographs}-]+','_').Trim('_')
        Invoke-Capture "小红书相关AI问题：$query" { & $opencliPs1 xiaohongshu search $query -f yaml } (Join-Path $rawDir ("growth_xhs_{0:D2}_{1}.yaml" -f $i,$safe)) | Out-Null
        Start-Sleep -Seconds 3
    }
}else{
    $health.Add('- 小红书：OpenCLI入口不存在，改用网页搜索；真实成长内容仍可继续。')
}

$agentPython = 'H:\AgentReach\uv\tools\agent-reach\Scripts\python.exe'
if(Test-Path -LiteralPath $agentPython){
    Invoke-Capture 'AI和科技RSS' {
        & $agentPython (Join-Path $PSScriptRoot 'rss_collect.py') --config (Join-Path $root 'config\sources.json') --output (Join-Path $rawDir 'growth_rss_items.json') --hours $WindowHours
    } (Join-Path $rawDir 'growth_rss_collect.log') | Out-Null
}else{
    $health.Add('- RSS：Agent Reach Python不存在，改用浏览器或网页搜索。')
}

$health.Add('- 抖音/微博：仅在与当天AI项目直接相关时由浏览器补充。')
$health.Add('- Jina与Exa当前不是主路径；外部渠道失败不影响真实进展型内容。')
$health.Add('- 采集结果必须经过相关性筛选和事实核验；没有相关热点时正常留空。')
$health | Set-Content -LiteralPath (Join-Path $growthDir '05_hotspot_support.md') -Encoding utf8

Write-Host "AI hotspot support collection finished: $growthDir"
