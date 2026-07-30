param(
    [Parameter(Mandatory = $true)]
    [string]$VideoPath,
    [double[]]$Times = @(7.8, 16.06),
    [double]$MinimumNormalizedEntropy = 0.18,
    [double]$ExpectedDurationSeconds = 0,
    [double]$DurationToleranceSeconds = 0.3
)

$resolvedVideo = (Resolve-Path -LiteralPath $VideoPath -ErrorAction Stop).Path
$failures = @()

if ($ExpectedDurationSeconds -gt 0) {
    $durationText = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $resolvedVideo
    $duration = [double]::Parse(
        ($durationText | Select-Object -First 1).Trim(),
        [System.Globalization.CultureInfo]::InvariantCulture
    )
    [pscustomobject]@{
        DurationSeconds = [math]::Round($duration, 6)
        ExpectedDurationSeconds = $ExpectedDurationSeconds
        ToleranceSeconds = $DurationToleranceSeconds
        Passed = [math]::Abs($duration - $ExpectedDurationSeconds) -le $DurationToleranceSeconds
    }
    if ([math]::Abs($duration - $ExpectedDurationSeconds) -gt $DurationToleranceSeconds) {
        $failures += "duration=$duration"
    }
}

foreach ($time in $Times) {
    $output = & ffmpeg -hide_banner -ss $time -i $resolvedVideo -frames:v 1 `
        -vf 'crop=960:620:40:100,entropy=mode=normal,metadata=print' `
        -an -f null - 2>&1 | Out-String

    $match = [regex]::Match(
        $output,
        'lavfi\.entropy\.normalized_entropy\.normal\.Y=(?<value>[0-9.]+)'
    )

    if (-not $match.Success) {
        throw "Unable to read normalized luma entropy at ${time}s."
    }

    $entropy = [double]::Parse(
        $match.Groups['value'].Value,
        [System.Globalization.CultureInfo]::InvariantCulture
    )

    [pscustomobject]@{
        TimeSeconds = $time
        NormalizedLumaEntropy = [math]::Round($entropy, 6)
        Minimum = $MinimumNormalizedEntropy
        Passed = $entropy -ge $MinimumNormalizedEntropy
    }

    if ($entropy -lt $MinimumNormalizedEntropy) {
        $failures += "${time}s=$entropy"
    }
}

if ($failures.Count -gt 0) {
    throw "Motion sample QA failed: $($failures -join ', ')"
}
