param(
  [string]$PythonVersion = "3.11.15",
  [string]$FfmpegBin = "",
  [switch]$IncludeMultiAgent
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$uv = (Get-Command uv -ErrorAction Stop).Source

function Initialize-Venv {
  param([string]$Path, [string]$Version, [string]$Requirements)
  if (-not (Test-Path -LiteralPath $Path)) {
    & $uv venv $Path --python $Version
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed: $Path" }
  }
  $python = Join-Path $Path "Scripts\python.exe"
  & $uv pip install --python $python --requirement $Requirements
  if ($LASTEXITCODE -ne 0) { throw "uv pip install failed: $Requirements" }
  return $python
}

$runtimePython = Initialize-Venv -Path (Join-Path $projectRoot ".runtime") -Version $PythonVersion -Requirements (Join-Path $projectRoot "requirements-runtime.lock.txt")
$exporterPython = Initialize-Venv -Path (Join-Path $projectRoot ".runtime-exporters") -Version $PythonVersion -Requirements (Join-Path $projectRoot "requirements-exporters.lock.txt")

if ($IncludeMultiAgent) {
  $multiPython = Initialize-Venv -Path (Join-Path $projectRoot ".runtime-multi-agent") -Version "3.13.9" -Requirements (Join-Path $projectRoot "requirements-multi-agent.lock.txt")
  & $uv pip freeze --python $multiPython | Set-Content -Encoding UTF8 (Join-Path $projectRoot "requirements-multi-agent.resolved.local.txt")
}

if (-not $FfmpegBin) {
  $ffmpegCommand = Get-Command ffmpeg -ErrorAction Stop
  $FfmpegBin = Split-Path -Parent $ffmpegCommand.Source
}
$ffmpegSource = Join-Path $FfmpegBin "ffmpeg.exe"
$ffprobeSource = Join-Path $FfmpegBin "ffprobe.exe"
if (-not (Test-Path -LiteralPath $ffmpegSource) -or -not (Test-Path -LiteralPath $ffprobeSource)) {
  throw "FfmpegBin must contain ffmpeg.exe and ffprobe.exe: $FfmpegBin"
}
$ffmpegTarget = Join-Path $projectRoot ".runtime\ffmpeg\bin"
New-Item -ItemType Directory -Force -Path $ffmpegTarget | Out-Null
Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $ffmpegTarget "ffmpeg.exe") -Force
Copy-Item -LiteralPath $ffprobeSource -Destination (Join-Path $ffmpegTarget "ffprobe.exe") -Force

& $uv pip freeze --python $runtimePython | Set-Content -Encoding UTF8 (Join-Path $projectRoot "requirements-runtime.resolved.local.txt")
& $uv pip freeze --python $exporterPython | Set-Content -Encoding UTF8 (Join-Path $projectRoot "requirements-exporters.resolved.local.txt")

Write-Output "Runtime ready: $runtimePython"
Write-Output "Exporter runtime ready: $exporterPython"
Write-Output "FFmpeg ready: $ffmpegTarget"
