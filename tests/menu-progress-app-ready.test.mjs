import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../tools/menu-progress-validate.mjs", import.meta.url), "utf8");

test("menu-progress waits for app listeners before uploading the ROM", () => {
  const navigation = source.indexOf("await page.goto(");
  const ready = source.indexOf("await waitForAppReady(page)", navigation);
  const upload = source.indexOf('await page.setInputFiles("#romInput", romPath)', navigation);
  assert.ok(ready > navigation && upload > ready);
});

test("app readiness waits through bootstrap and accepts the initialized status", async () => {
  const match = source.match(/async function waitForAppReady\(page[\s\S]*?\n\}/);
  assert.ok(match, "readiness helper must exist");
  const waitForAppReady = vm.runInNewContext(`(${match[0]})`);
  let attempts = 0;
  let waits = 0;
  const statuses = ["Booting", "", "Ready"];
  const page = {
    async evaluate(callback) {
      const status = statuses[attempts++];
      return vm.runInNewContext(`(${callback})()`, {
        document: {
          querySelector: (selector) => selector === "#romInput" ? {} : { textContent: status },
        },
      });
    },
    async waitForTimeout(milliseconds) {
      assert.equal(milliseconds, 250);
      waits++;
    },
  };
  assert.equal(await waitForAppReady(page, 1), true);
  assert.equal(attempts, 3);
  assert.equal(waits, 2);

  page.evaluate = async () => { throw new Error("page is still navigating"); };
  waits = 0;
  assert.equal(await waitForAppReady(page, 1), false);
  assert.equal(waits, 4, "startup polling must remain bounded");
});

for (const harness of ["menu-progress-validate.mjs", "boot-matrix.mjs"]) {
  const harnessSource = await readFile(new URL(`../tools/${harness}`, import.meta.url), "utf8");
  const match = harnessSource.match(/async function waitForMount\(page[\s\S]*?\n\}/);
  assert.ok(match, `${harness} mount helper must exist`);
  const waitForMount = vm.runInNewContext(`(${match[0]})`);

  test(`${harness} reports adapter refusal immediately instead of timing out`, async () => {
    const status = "Dolphin adapter fallback: Core WASM SHA-256 mismatch: expected old, got new";
    const page = {
      async evaluate() { return { coreMode: "Demo", mountNote: "", status }; },
      async waitForTimeout() { assert.fail("known boot refusal must not wait for a mount"); },
    };
    await assert.rejects(waitForMount(page, 1), /Mount failed: Dolphin adapter fallback: Core WASM SHA-256 mismatch/);
  });

  test(`${harness} ignores optional JIT prewarm failures while the core mounts`, async () => {
    let evaluations = 0;
    let waits = 0;
    const page = {
      async evaluate() {
        return evaluations++ === 0
          ? { coreMode: "Demo", mountNote: "", status: "jit-cache: prewarm failed" }
          : { coreMode: "Dolphin", mountNote: "Dolphin core active", status: "Running" };
      },
      async waitForTimeout(milliseconds) { assert.equal(milliseconds, 1000); waits++; },
    };
    await waitForMount(page, 1);
    assert.equal(waits, 1);
    assert.equal(evaluations, 2);
  });
}
