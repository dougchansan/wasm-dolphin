// Reap Playwright-launched browsers orphaned by a previous run.
//
// Playwright's Chrome only exits cleanly if the harness reaches
// browser.close(). A run that is killed, times out, or throws early leaves the
// browser behind, and they accumulate. Eight leftovers were enough to make new
// runs fail with "Timed out waiting for Dolphin mount" -- which is a large part
// of this project's long-standing "flaky mount", alongside the JIT-cache status
// bug fixed separately.
//
// Sweeping at startup is self-healing: it does not matter how the previous run
// died. Signal handlers cannot do this reliably because browser.close() is
// async and the process may be SIGKILLed.
//
// Deliberately conservative:
//   - Only processes whose command line marks them as automation-launched
//     (playwright / --remote-debugging-port / --headless). A developer's own
//     Chrome has none of these and is never touched.
//   - Only those older than MIN_AGE_MINUTES, so a concurrently running sibling
//     harness is never killed. Legitimate runs finish well inside this.

import { execFileSync } from "node:child_process";

const MIN_AGE_MINUTES = 30;

export function reapStaleBrowsers({ quiet = false } = {}) {
  if (process.platform !== "win32") return 0;
  const ps = `
$cut = (Get-Date).AddMinutes(-${MIN_AGE_MINUTES})
$stale = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'playwright|--remote-debugging-port|--headless' } |
  Where-Object { $_.CreationDate -lt $cut }
$n = 0
foreach ($p in $stale) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $n++ } catch {} }
Write-Output $n
`.trim();
  try {
    const out = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }).toString().trim();
    const killed = Number.parseInt(out, 10) || 0;
    if (killed && !quiet)
      console.log(`[reap] killed ${killed} orphaned automation browser(s) from a previous run`);
    return killed;
  } catch {
    return 0;  // best-effort only; never block a run on cleanup
  }
}
