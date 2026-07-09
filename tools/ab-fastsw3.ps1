# fastsw tuned-raster A/B: fastsw=2 (row-dup) vs fastsw=3 (LERP reconstruct) vs fastsw=1 (floor).
# Demo/attract intro (no savestate) = deterministic full-motion, SPEED=1 so visualFps is the felt metric.
# Captures post-warmup mean visualFps + coreFps + gameSpeed; harness auto-saves tNNN screenshots for quality compare.
$ErrorActionPreference="Continue"
$root="C:\Users\douglaswhittingham\wasm-dolphin"; $dur=50
$rom="F:/Emulation/super-smash-bros.-melee-usa-en-ja-rev-2.nkit_202203/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).nkit.iso"
$conds=@(@{name="fsw1";fastsw="1"},@{name="fsw2";fastsw="2"},@{name="fsw3";fastsw="3"})
function Kill-DebugChrome { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'chrome-debug' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function PostWarmupVisual($outDir){ $sj=Join-Path $outDir "samples.json"; if(-not(Test-Path $sj)){return $null}; try{$s=Get-Content $sj -Raw|ConvertFrom-Json}catch{return $null}; $vf=@(); $cf=@(); $gs=@(); foreach($x in $s){ $v=[double]$x.visualFps; if($v -gt 0){$vf+=$v; $cf+=[double]$x.coreFps; $gs+=[double]($x.gameSpeed -replace '%','')} }; if($vf.Count -lt 6){return $null}; $skip=[math]::Floor($vf.Count*0.4); $vw=$vf[$skip..($vf.Count-1)]; $cw=$cf[$skip..($cf.Count-1)]; $gw=$gs[$skip..($gs.Count-1)]; [pscustomobject]@{ visual=[math]::Round(($vw|Measure-Object -Average).Average,1); visualMax=($vw|Measure-Object -Maximum).Maximum; core=[math]::Round(($cw|Measure-Object -Average).Average,1); speed=[math]::Round(($gw|Measure-Object -Average).Average,1); n=$vw.Count } }
$results=@()
foreach($c in $conds){
  Kill-DebugChrome
  $tag="fsw3ab_$($c.name)"; $outDir=Join-Path $root ".omx\menu-progress\$tag"
  $env:ROM=$rom; $env:VIDEO="software"; $env:PRESENTER="webgpu"; $env:SPEED="1"; $env:DURATION="$dur"
  $env:BASE_URL="http://127.0.0.1:8091/"; $env:HEADED="1"; $env:FASTSW=$c.fastsw
  $env:SAVE_STATE_URL="/__battle.sav"; $env:SAVE_STATE_AT="35"
  $log=Join-Path $root ".omx\$tag.log"
  $p=Start-Process -FilePath "node" -ArgumentList "tools/menu-progress-validate.mjs","--out-dir",".omx/menu-progress/$tag" -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  if(-not $p.WaitForExit(180000)){ try{$p.Kill()}catch{} }
  Start-Sleep -Seconds 2
  $m=PostWarmupVisual $outDir
  $results+=[pscustomobject]@{cond=$c.name;fastsw=$c.fastsw;metrics=$m}
  $line = if($m){ "$(Get-Date -Format HH:mm:ss)  $($c.name) fastsw=$($c.fastsw) -> visual=$($m.visual) (max $($m.visualMax)) core=$($m.core) speed=$($m.speed)% n=$($m.n)" } else { "$(Get-Date -Format HH:mm:ss)  $($c.name) NO DATA" }
  $line | Tee-Object -Append -FilePath (Join-Path $root ".omx\fsw3-ab-progress.log")
}
Kill-DebugChrome
$sb=New-Object System.Text.StringBuilder
[void]$sb.AppendLine("=== fastsw tuned-raster A/B (demo intro, SPEED=1, post-warmup mean visualFps) ===")
foreach($r in $results){ if($r.metrics){ [void]$sb.AppendLine(("{0,-5} fastsw={1}  visual={2,5} (max {3})  core={4,5}  speed={5,5}%  n={6}" -f $r.cond,$r.fastsw,$r.metrics.visual,$r.metrics.visualMax,$r.metrics.core,$r.metrics.speed,$r.metrics.n)) } else { [void]$sb.AppendLine(("{0,-5} NO DATA" -f $r.cond)) } }
[void]$sb.AppendLine("(baseline reference: fastsw=1 ~22 visual, fastsw=2 ~40 visual, core ~62)")
$sb.ToString()|Out-File -Encoding utf8 (Join-Path $root ".omx\fsw3-ab-summary.txt")
$sb.ToString()
"DONE"|Out-File -Append -Encoding utf8 (Join-Path $root ".omx\fsw3-ab-progress.log")
