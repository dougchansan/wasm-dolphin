import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  installWgpuDiagnosticLogFilter,
  isDroppableWgpuDiagnosticLog,
} from "../src/diagnostic-log-filter.js";
import { requestedWgpuDiagnosticQuiet } from "../src/wgpu-replay-diagnostics.js";

test("quiet WGPU diagnostics drop only known non-error hot-path logs", () => {
  assert.equal(requestedWgpuDiagnosticQuiet("?wgpudiagquiet=1"), true);
  assert.equal(requestedWgpuDiagnosticQuiet("?wgpudiagquiet=0"), false);
  assert.equal(isDroppableWgpuDiagnosticLog("[s28ah-ps] n=1"), true);
  assert.equal(isDroppableWgpuDiagnosticLog("[s27-decode] chunks=4"), true);
  assert.equal(isDroppableWgpuDiagnosticLog("[webgpu-DIAG-vs] id=7"), true);
  assert.equal(isDroppableWgpuDiagnosticLog("[webgpu-shader] ok=4 fail=0"), true);
  assert.equal(isDroppableWgpuDiagnosticLog("[webgpu-shader] ok=4 fail=1"), false);
  assert.equal(isDroppableWgpuDiagnosticLog("[webgpu-exec] VALIDATION: bad"), false);
  assert.equal(isDroppableWgpuDiagnosticLog("ordinary status"), false);
});

test("the filter is reversible and reports exact suppressed tags", () => {
  const forwarded = [];
  const fakeConsole = { log: (...args) => forwarded.push(args) };
  const originalLog = fakeConsole.log;
  const filter = installWgpuDiagnosticLogFilter({ consoleObject: fakeConsole, enabled: true });

  fakeConsole.log("[s28ah-ps] n=1");
  fakeConsole.log("[s28ah-ps] n=2");
  fakeConsole.log("[s27-decode] chunks=4");
  fakeConsole.log("[webgpu-shader] ok=4 fail=1");
  fakeConsole.log("ordinary status", 7);

  assert.deepEqual(forwarded, [
    ["[webgpu-shader] ok=4 fail=1"],
    ["ordinary status", 7],
  ]);
  assert.deepEqual(filter.snapshot(), {
    schema: "wasm-dolphin.wgpu-diagnostic-log-filter.v1",
    enabled: true,
    droppedCount: 3,
    droppedByTag: {
      "s27-decode": 1,
      "s28ah-ps": 2,
    },
  });

  filter.restore();
  assert.equal(fakeConsole.log, originalLog);
});

test("disabled filtering leaves console identity and output unchanged", () => {
  const forwarded = [];
  const fakeConsole = { log: (...args) => forwarded.push(args) };
  const originalLog = fakeConsole.log;
  const filter = installWgpuDiagnosticLogFilter({ consoleObject: fakeConsole, enabled: false });

  fakeConsole.log("[s28ah-ps] n=1");
  assert.equal(fakeConsole.log, originalLog);
  assert.deepEqual(forwarded, [["[s28ah-ps] n=1"]]);
  assert.equal(filter.snapshot().droppedCount, 0);
});

test("wgpudiagquiet is explicit, worker-plumbed, and benchmark-visible", async () => {
  const [host, adapter, worker, diagnostics, gate] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../src/wgpu-replay-diagnostics.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(diagnostics, /get\("wgpudiagquiet"\) === "1"/);
  assert.match(host, /wgpuDiagnosticQuiet: this\.wgpuDiagnosticQuiet/);
  assert.match(adapter, /wgpuDiagnosticQuiet: this\.wgpuDiagnosticQuiet/);
  assert.match(worker, /installWgpuDiagnosticLogFilter\(\{[\s\S]*?enabled: wgpuDiagnosticQuiet/);
  assert.match(worker, /diagnosticLogFilter: wgpuDiagnosticLogFilter\.snapshot\(\)/);
  assert.match(gate, /"wgpudiagquiet"/);
});
