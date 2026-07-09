# Clean uncapped A/B for JIT levers: base vs blockmerge vs regalloc vs both.
# Drives menu-progress-validate.mjs directly (full env), SPEED=unlimited so
# gameSpeed% reflects raw CPU throughput headroom (not pacing-capped).
$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = "node"
$dur  = 45
$trials = 3
$base = "http://127.0.0.1:8082/"
$rom  = "F:/Emulation/super-smash-bros.-melee-usa-en-ja-rev-2.nkit_202203/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).nkit.iso"

$conds = @(
  # regalloc is default-on; the no-regalloc baseline must explicitly use 0.
  @{ name="base"; bm=$null; ra="0" },
  @{ name="bm";   bm="1";   ra="0" },
  @{ name="ra";   bm=$null; ra="1"   },
  @{ name="both"; bm="1";   ra="1"   }
)

function Kill-DebugChrome {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match 'chrome-debug' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function PostWarmupAvg($outDir) {
  $sj = Join-Path $outDir "samples.json"
  if (-not (Test-Path $sj)) { return $null }
  try { $s = Get-Content $sj -Raw | ConvertFrom-Json } catch { return $null }
  $gs = @()
  foreach ($x in $s) { $v = [double]($x.gameSpeed -replace '%',''); if ($v -gt 0) { $gs += $v } }
  if ($gs.Count -lt 6) { return $null }
  # post-warmup: drop first 40% of nonzero samples
  $skip = [math]::Floor($gs.Count * 0.4)
  $win = $gs[$skip..($gs.Count-1)]
  [math]::Round(($win | Measure-Object -Average).Average, 2)
}

$results = @()
foreach ($c in $conds) {
  for ($t = 1; $t -le $trials; $t++) {
    Kill-DebugChrome
    $tag = "ab_$($c.name)_$t"
    $outDir = Join-Path $root ".omx\menu-progress\$tag"
    # full env (replicates _run-c1base defaults minus the lever deletes)
    $env:ROM = $rom
    $env:SAVE_STATE_URL = "/__battle.sav"; $env:SAVE_STATE_AT = "35"
    $env:VIDEO = "software"; $env:PRESENTER = "webgpu"
    $env:FORCEJIT = "1"; $env:JITWARMUP = "700"
    $env:DURATION = "$dur"; $env:BASE_URL = $base; $env:HEADED = "1"
    $env:SPEED = "unlimited"
    Remove-Item Env:BLOCKMERGE -ErrorAction SilentlyContinue
    Remove-Item Env:REGALLOC   -ErrorAction SilentlyContinue
    if ($c.bm) { $env:BLOCKMERGE = $c.bm }
    if ($c.ra) { $env:REGALLOC   = $c.ra }
    $log = Join-Path $root ".omx\$tag.log"
    $p = Start-Process -FilePath $node `
         -ArgumentList "tools/menu-progress-validate.mjs","--out-dir",".omx/menu-progress/$tag" `
         -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
         -PassThru -WindowStyle Hidden
    $exited = $p.WaitForExit(240000)
    if (-not $exited) { try { $p.Kill() } catch {} }
    Start-Sleep -Seconds 1
    $avg = PostWarmupAvg $outDir
    $results += [pscustomobject]@{ cond=$c.name; trial=$t; gameSpeed=$avg }
    "$(Get-Date -Format HH:mm:ss)  $($c.name) trial $t  -> gameSpeed=$avg%" |
      Out-File -Append -Encoding utf8 (Join-Path $root ".omx\ab-progress.log")
  }
}
Kill-DebugChrome
$results | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $root ".omx\ab-results.json")

# summary
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("=== JIT lever A/B (SPEED=unlimited, post-warmup gameSpeed%) ===")
foreach ($c in $conds) {
  $vals = ($results | Where-Object { $_.cond -eq $c.name -and $_.gameSpeed -ne $null }).gameSpeed
  if ($vals.Count -gt 0) {
    $m = [math]::Round(($vals | Measure-Object -Average).Average,2)
    $mn = ($vals | Measure-Object -Minimum).Minimum
    $mx = ($vals | Measure-Object -Maximum).Maximum
    [void]$sb.AppendLine(("{0,-6} mean={1,7}  min={2,7} max={3,7}  trials=[{4}]" -f $c.name,$m,$mn,$mx,($vals -join ", ")))
  } else {
    [void]$sb.AppendLine(("{0,-6} NO DATA" -f $c.name))
  }
}
$sb.ToString() | Out-File -Encoding utf8 (Join-Path $root ".omx\ab-summary.txt")
"DONE" | Out-File -Append -Encoding utf8 (Join-Path $root ".omx\ab-progress.log")
