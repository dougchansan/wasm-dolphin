import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { server } from "../tools/serve.mjs";

test("bundled server serves assets without leaking local files", async (t) => {
  const site = mkdtempSync(join(process.cwd(), "serve-fixture-"));
  const outside = mkdtempSync(join(tmpdir(), "serve-outside-"));
  const base = `/${basename(site)}`;

  writeFileSync(join(site, "index.html"), "index");
  writeFileSync(join(site, "app.wasm"), "wasm");
  writeFileSync(join(site, ".env"), "private");
  mkdirSync(join(site, ".git"));
  writeFileSync(join(site, ".git", "config"), "private");
  writeFileSync(join(outside, "secret.txt"), "private");

  let symlinksAvailable = true;
  try {
    symlinkSync(join(outside, "secret.txt"), join(site, "outside-file"));
    symlinkSync(outside, join(site, "outside-dir"), "dir");
    symlinkSync(join(site, ".env"), join(site, "hidden-alias"));
    symlinkSync(join(site, "app.wasm"), join(site, "inside-link"));
    mkdirSync(join(site, "leaky-index"));
    symlinkSync(join(outside, "secret.txt"), join(site, "leaky-index", "index.html"));
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    symlinksAvailable = false;
  }

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(site, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const request = (path) => new Promise((resolve, reject) => {
    get({ hostname: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on("error", reject);
  });

  const asset = await request(`${base}/app.wasm?v=1`);
  assert.equal(asset.status, 200);
  assert.equal(asset.body, "wasm");
  assert.equal(asset.headers["content-type"], "application/wasm");
  assert.equal(asset.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(asset.headers["cross-origin-embedder-policy"], "require-corp");
  assert.equal((await request(`${base}/`)).body, "index");

  for (const path of [
    `${base}/.env`,
    `${base}/%2eenv`,
    `${base}/.git/config`,
    `${base}/%2e%2e${base}/app.wasm`,
    `${base}/%ZZ`,
    `${base}/%00`,
    ...(symlinksAvailable ? [
      `${base}/hidden-alias`,
      `${base}/outside-file`,
      `${base}/outside-dir/secret.txt`,
      `${base}/leaky-index/`,
    ] : []),
  ]) {
    assert.equal((await request(path)).status, 404, path);
  }
  if (symlinksAvailable) assert.equal((await request(`${base}/inside-link`)).body, "wasm");
});
