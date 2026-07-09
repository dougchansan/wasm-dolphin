# Fastmem-hoist A/B: default (regcache on, no hoist) vs fmh (?fastmemhoist=1).
# SPEED=unlimited. Captures fmhfire fast:F to confirm the hoist fires.
$ErrorActionPreference="Continue"
$root="C:\Users\douglaswhittingham\wasm-dolphin"; $dur=45; $trials=4
$rom="F:/Emulation/super-smash-bros.-melee-usa-en-ja-rev-2.nkit_202203/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).nkit.iso"
$conds=@(@{name="def";fmh=$null},@{name="fmh";fmh="1"})
function Kill-DebugChrome { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'chrome-debug' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function PostWarmupAvg($outDir){ $sj=Join-Path $outDir "samples.json"; if(-not(Test-Path $sj)){return $null}; try{$s=Get-Content $sj -Raw|ConvertFrom-Json}catch{return $null}; $gs=@(); foreach($x in $s){$v=[double]($x.gameSpeed -replace '%','');if($v -gt 0){$gs+=$v}}; if($gs.Count -lt 6){return $null}; $skip=[math]::Floor($gs.Count*0.4); $win=$gs[$skip..($gs.Count-1)]; [math]::Round(($win|Measure-Object -Average).Average,2) }
function FmhFire($tag){ $lg=Join-Path $root ".omx\$tag.log"; if(-not(Test-Path $lg)){return "?"}; $m=Select-String -Path $lg -Pattern 'fmhfire groups:(\d+) fast:(\d+) slow:(\d+)' -AllMatches | Select-Object -Last 1; if($m){ $g=$m.Matches[0].Groups; return "g$($g[1].Value)/fast$($g[2].Value)/slow$($g[3].Value)" }; return "none" }
$results=@()
foreach($c in $conds){ for($t=1;$t -le $trials;$t++){
  Kill-DebugChrome
  $tag="fmh_$($c.name)_$t"; $outDir=Join-Path $root ".omx\menu-progress\$tag"
  $env:ROM=$rom; $env:SAVE_STATE_URL="/__battle.sav"; $env:SAVE_STATE_AT="35"; $env:VIDEO="software"; $env:PRESENTER="webgpu"
  $env:FORCEJIT="1"; $env:JITWARMUP="700"; $env:DURATION="$dur"; $env:BASE_URL="http://127.0.0.1:8082/"; $env:HEADED="1"; $env:SPEED="unlimited"
  Remove-Item Env:FASTMEMHOIST -ErrorAction SilentlyContinue; Remove-Item Env:BLOCKMERGE -ErrorAction SilentlyContinue; Remove-Item Env:REGALLOC -ErrorAction SilentlyContinue
  if($c.fmh){ $env:FASTMEMHOIST=$c.fmh }
  $log=Join-Path $root ".omx\$tag.log"
  $p=Start-Process -FilePath "node" -ArgumentList "tools/menu-progress-validate.mjs","--out-dir",".omx/menu-progress/$tag" -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  if(-not $p.WaitForExit(240000)){ try{$p.Kill()}catch{} }
  Start-Sleep -Seconds 1
  $avg=PostWarmupAvg $outDir; $fire=FmhFire $tag
  $results+=[pscustomobject]@{cond=$c.name;trial=$t;gameSpeed=$avg;fire=$fire}
  "$(Get-Date -Format HH:mm:ss)  $($c.name) t$t -> gameSpeed=$avg% fire=$fire" | Out-File -Append -Encoding utf8 (Join-Path $root ".omx\fmh-ab-progress.log")
}}
Kill-DebugChrome
$results|ConvertTo-Json -Depth 4|Out-File -Encoding utf8 (Join-Path $root ".omx\fmh-ab-results.json")
$sb=New-Object System.Text.StringBuilder
[void]$sb.AppendLine("=== Fastmem-hoist A/B (SPEED=unlimited, post-warmup gameSpeed%) ===")
foreach($c in $conds){ $vals=($results|Where-Object{$_.cond -eq $c.name -and $_.gameSpeed -ne $null}).gameSpeed; $fires=($results|Where-Object{$_.cond -eq $c.name}).fire; if($vals.Count -gt 0){ $m=[math]::Round(($vals|Measure-Object -Average).Average,2); [void]$sb.AppendLine(("{0,-4} mean={1,7} min={2,7} max={3,7} trials=[{4}] fire=[{5}]" -f $c.name,$m,($vals|Measure-Object -Minimum).Minimum,($vals|Measure-Object -Maximum).Maximum,($vals -join ", "),($fires -join " | "))) } else { [void]$sb.AppendLine(("{0,-4} NO DATA" -f $c.name)) } }
$sb.ToString()|Out-File -Encoding utf8 (Join-Path $root ".omx\fmh-ab-summary.txt")
"DONE"|Out-File -Append -Encoding utf8 (Join-Path $root ".omx\fmh-ab-progress.log")
