import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { decodeWgpuSamplerState } from "../src/wgpu-sampler-state.js";

test("legacy untagged samplers retain shared linear/repeat behavior", () => {
  for (const packed of [0, 0x7fffffff]) {
    assert.deepEqual(decodeWgpuSamplerState(packed), {
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      addressModeU: "repeat", addressModeV: "repeat",
    });
  }
});

test("tagged zero state means point/clamp sampling with mipmaps disabled", () => {
  assert.deepEqual(decodeWgpuSamplerState(0x80000000), {
    minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest",
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    lodMinClamp: 0, lodMaxClamp: 0, maxAnisotropy: 1,
  });
});

test("native packed fields preserve independent filters, wraps and fractional LOD clamps", () => {
  // Linear min/mip, point mag, mirror U/repeat V; LOD 1.5..7.25.
  assert.deepEqual(decodeWgpuSamplerState(0x83a0c035), {
    minFilter: "linear", magFilter: "nearest", mipmapFilter: "linear",
    addressModeU: "mirror-repeat", addressModeV: "repeat",
    lodMinClamp: 1.5, lodMaxClamp: 7.25, maxAnisotropy: 1,
  });
});

test("anisotropy remains within WebGPU limits and does not override point filters", () => {
  assert.equal(decodeWgpuSamplerState(0x80000107).maxAnisotropy, 4);
  assert.equal(decodeWgpuSamplerState(0x80000787).maxAnisotropy, 16);
  assert.equal(decodeWgpuSamplerState(0x83000103).maxAnisotropy, 1);
  assert.equal(decodeWgpuSamplerState(0x83000103).mipmapFilter, "nearest");
  assert.equal(decodeWgpuSamplerState(0x80000103).maxAnisotropy, 4);
  assert.equal(decodeWgpuSamplerState(0x80000103).mipmapFilter, "linear");
  assert.equal(decodeWgpuSamplerState(0x80000103).lodMaxClamp, 0);
});

test("all three GX wrap modes are independent per texture axis", () => {
  const wraps = ["clamp-to-edge", "repeat", "mirror-repeat"];
  for (let u = 0; u < 3; u++) {
    for (let v = 0; v < 3; v++) {
      const result = decodeWgpuSamplerState(0x80000000 | (u << 3) | (v << 5));
      assert.equal(result.addressModeU, wraps[u]);
      assert.equal(result.addressModeV, wraps[v]);
    }
  }
});

test("consumer retains descriptors and does not overwrite existing sampler identities", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const start = worker.indexOf("case WGPU_CMD_OP_CREATE_SAMPLER: {");
  const end = worker.indexOf("case WGPU_CMD_OP_CREATE_BIND_GROUP:", start);
  assert.ok(start >= 0 && end > start);
  const descriptors = [];
  const webGpuObjects = { samplers: new Map(), samplerDescriptors: new Map() };
  const records = new Uint32Array([10, 5, 0x80000000, 0, 0, 0, 0, 0,
    10, 6, 0x83a0c035, 0, 0, 0, 0, 0]);
  const replay = vm.runInNewContext(`(function (recWord) {
    switch (10) { ${worker.slice(start, end)} }
  })`, {
    WGPU_CMD_OP_CREATE_SAMPLER: 10, u32: records, webGpuObjects, decodeWgpuSamplerState,
    dev: { createSampler(descriptor) { descriptors.push(descriptor); return { descriptor }; } },
  });
  replay(0);
  replay(8);
  const first = webGpuObjects.samplers.get(5);
  records[2] = 0;
  replay(0);
  assert.equal(webGpuObjects.samplers.get(5), first);
  assert.equal(descriptors.length, 2);
  assert.equal(webGpuObjects.samplerDescriptors.get(5).minFilter, "nearest");
  assert.equal(webGpuObjects.samplerDescriptors.get(6).addressModeU, "mirror-repeat");
  assert.notEqual(webGpuObjects.samplers.get(5), webGpuObjects.samplers.get(6));
});
