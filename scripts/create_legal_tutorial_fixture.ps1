param(
  [Parameter(Mandatory = $true)]
  [string]$Output
)

$ErrorActionPreference = "Stop"
$outputRoot = [System.IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$scene1 = Join-Path $outputRoot "scene-caption.mp4"
$scene2 = Join-Path $outputRoot "scene-motion.mp4"
$scene3 = Join-Path $outputRoot "scene-sound.mp4"
$tutorial = Join-Path $outputRoot "tutorial.mp4"

ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "color=c=0x0055FF:s=1280x720:r=30:d=3" `
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" `
  -vf "drawbox=x=90:y=110:w=1100:h=500:color=0x06131F@0.68:t=fill,drawbox=x=130:y=310:w=470:h=90:color=0xFFB347@1:t=fill,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='01  CAPTION POP':fontcolor=white:fontsize=64:x=140:y=145,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='Emphasize one spoken keyword':fontcolor=white:fontsize=34:x=140:y=465" `
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $scene1

ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "color=c=0xFFCC00:s=1280x720:r=30:d=3" `
  -f lavfi -i "sine=frequency=554:sample_rate=48000:duration=3" `
  -vf "drawbox=x=90:y=110:w=1100:h=500:color=0x091326@0.68:t=fill,drawbox=x=680:y=250:w=430:h=220:color=0x4FE0C1@1:t=fill,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='02  ELEMENT SLIDE':fontcolor=white:fontsize=64:x=140:y=145,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='Reveal evidence after the claim':fontcolor=white:fontsize=34:x=140:y=510" `
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $scene2

ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "color=c=0xB00050:s=1280x720:r=30:d=3" `
  -f lavfi -i "sine=frequency=659:sample_rate=48000:duration=3" `
  -vf "drawbox=x=90:y=110:w=1100:h=500:color=0x160B20@0.68:t=fill,drawbox=x=175:y=285:w=40:h=150:color=0xFF6F61@1:t=fill,drawbox=x=235:y=250:w=40:h=220:color=0xFFB347@1:t=fill,drawbox=x=295:y=315:w=40:h=90:color=0x4FE0C1@1:t=fill,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='03  SOUND CUE':fontcolor=white:fontsize=64:x=140:y=145,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='One cue on one semantic beat':fontcolor=white:fontsize=34:x=140:y=510" `
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $scene3

ffmpeg -y -hide_banner -loglevel error `
  -i $scene1 -i $scene2 -i $scene3 `
  -filter_complex "[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]" `
  -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart $tutorial

$transcript = @{
  model = "self-authored-sidecar-v1"
  language = "en"
  segments = @(
    @{ start = 0.0; end = 3.0; text = "First, make one spoken keyword pop without covering the speaker." },
    @{ start = 3.0; end = 6.0; text = "Second, slide the evidence card in only after the claim." },
    @{ start = 6.0; end = 9.0; text = "Third, place one licensed sound cue on one semantic beat." }
  )
}
$transcript | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $outputRoot "tutorial.transcript.json")

$techniques = @{
  techniques = @(
    @{
      id = "caption.pop.fixture.v1"
      domain = "caption"
      title = "Keyword caption pop"
      problem = "Emphasize one spoken keyword"
      primitive = "caption-pop"
      start = 0.3
      end = 2.6
      parameters = @{ durationMs = 320; scaleFrom = 0.88; scaleTo = 1.0 }
      applicability = @("spoken keyword emphasis")
      prohibitions = @("do not cover the speaker face")
      tags = @("caption", "keyword")
    },
    @{
      id = "motion.slide.fixture.v1"
      domain = "motion"
      title = "Evidence card slide"
      problem = "Reveal evidence after the spoken claim"
      primitive = "element-slide"
      start = 3.2
      end = 5.7
      parameters = @{ durationMs = 420; direction = "right" }
      applicability = @("evidence card reveal")
      prohibitions = @("no purposeless constant motion")
      tags = @("motion", "evidence")
    },
    @{
      id = "sound.cue.fixture.v1"
      domain = "sound"
      title = "Semantic sound cue"
      problem = "Reinforce one meaningful beat"
      primitive = "sfx-cue"
      start = 6.2
      end = 8.6
      parameters = @{ offsetMs = 0; targetPeakDb = -8 }
      applicability = @("one semantic beat")
      prohibitions = @("use licensed audio only", "do not mask speech")
      tags = @("sound", "semantic-beat")
    }
  )
}
$techniques | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $outputRoot "tutorial.techniques.json")

$manifest = @{
  schemaVersion = 1
  author = "Koubo local fixture"
  license = "self-created"
  purpose = "Deterministic legal tutorial ingestion and reconstruction test"
  sourceSha256 = (Get-FileHash -Algorithm SHA256 $tutorial).Hash.ToLowerInvariant()
  media = "tutorial.mp4"
  transcript = "tutorial.transcript.json"
  techniques = "tutorial.techniques.json"
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $outputRoot "fixture-manifest.json")

Remove-Item -LiteralPath $scene1, $scene2, $scene3 -Force
Write-Output $tutorial
