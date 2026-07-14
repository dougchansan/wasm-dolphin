// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  launchWithWindowsCpuAffinity,
  parseWindowsCpuAffinityMask,
} from "../tools/windows-process-affinity.mjs";

test("CPU affinity is default-off and rejects invalid or unsupported masks", () => {
  assert.deepEqual(parseWindowsCpuAffinityMask("", "win32"), {
    enabled: false,
    requestedMask: null,
  });
  assert.deepEqual(parseWindowsCpuAffinityMask("0x00ff", "win32"), {
    enabled: true,
    requestedMask: "0xff",
  });
  assert.deepEqual(parseWindowsCpuAffinityMask("255", "win32"), {
    enabled: true,
    requestedMask: "0xff",
  });
  assert.throws(() => parseWindowsCpuAffinityMask("0", "win32"), /between 1/);
  assert.throws(() => parseWindowsCpuAffinityMask("ff", "win32"), /Invalid/);
  assert.throws(() => parseWindowsCpuAffinityMask("0x1", "linux"), /only on Windows/);
});

test("default-off launch does not inspect or mutate process affinity", async () => {
  const launched = await launchWithWindowsCpuAffinity(
    async () => "launched",
    parseWindowsCpuAffinityMask("", "win32"),
    {
      platform: "win32",
      processId: 42,
      runPowerShell: async () => assert.fail("default-off must not invoke PowerShell"),
    }
  );
  assert.equal(launched.value, "launched");
  assert.deepEqual(launched.cpuAffinity, {
    enabled: false,
    requested: null,
    snapshot: null,
    applied: null,
    restored: null,
  });
});

test("browser launch inherits the requested mask and restores the benchmark parent", async () => {
  let currentMask = "0xffff";
  const transitions = [];
  const runPowerShell = async (operation, details) => {
    transitions.push([operation, { ...details }]);
    if (operation === "set") currentMask = details.mask;
    return currentMask;
  };
  const launched = await launchWithWindowsCpuAffinity(
    async () => {
      assert.equal(currentMask, "0xff");
      return { browser: "sentinel" };
    },
    parseWindowsCpuAffinityMask("0xff", "win32"),
    { platform: "win32", processId: 42, runPowerShell }
  );

  assert.equal(launched.value.browser, "sentinel");
  assert.deepEqual(launched.cpuAffinity, {
    enabled: true,
    requested: { processId: 42, mask: "0xff" },
    snapshot: { processId: 42, mask: "0xffff" },
    applied: { processId: 42, mask: "0xff" },
    restored: { processId: 42, mask: "0xffff" },
  });
  assert.deepEqual(transitions.map(([operation]) => operation), ["read", "set", "set"]);
});

test("browser launch restores the parent after failure and fails closed on a mismatched mask", async () => {
  let currentMask = "0xffff";
  await assert.rejects(
    launchWithWindowsCpuAffinity(
      async () => { throw new Error("launch failed"); },
      parseWindowsCpuAffinityMask("0xff", "win32"),
      {
        platform: "win32",
        processId: 42,
        runPowerShell: async (operation, details) => {
          if (operation === "set") currentMask = details.mask;
          return currentMask;
        },
      }
    ),
    /launch failed/
  );
  assert.equal(currentMask, "0xffff");

  await assert.rejects(
    launchWithWindowsCpuAffinity(
      async () => assert.fail("launch must not run under the wrong affinity"),
      parseWindowsCpuAffinityMask("0xff", "win32"),
      {
        platform: "win32",
        processId: 42,
        runPowerShell: async (operation, details) => operation === "read" ? "0xffff" : "0xf",
      }
    ),
    /was not applied/
  );
});

test("performance report and manifest retain affinity transition evidence", async () => {
  const gate = await readFile(
    new URL("../tools/perf-regression-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(gate, /process\.env\.PERF_CPU_AFFINITY_MASK/);
  assert.match(gate, /manifest\.browser\.cpuAffinity = browserLaunch\.cpuAffinity/);
  assert.match(gate, /summary\.browserCpuAffinity = browserLaunch\?\.cpuAffinity/);
  assert.match(gate, /browserCpuAffinity:\s*\{\s*requestedMask:/);
});
