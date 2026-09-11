# Sunshine background: uniform-source leak fixed

The white file-select background was caused by the WebGPU backend binding
ImGui utility data as GameCube pixel-shader constants. It was not a failed
beach draw: ordered GPU readbacks showed the complete beach immediately before
a full-screen composite overwrote it with white.

`OnScreenUI::DrawImGui` uploads a 16-byte viewport uniform before iterating
its draw lists. Empty lists therefore upload data without issuing a draw.
The backend treated any utility upload as a one-use flag for the next draw.
That flag survived the empty UI frame and redirected the next GX draw's
binding 0 away from its 1,536-byte pixel constants.

The failing capture identifies the exact owner: the selected offset contained
the fresh utility values `[2/640, 2/480, 0, 0]`. The larger shader binding also
exposed bytes left over beyond that short upload. In one capture, TEV register 1
read four `1065353216` integers—the bit pattern of float `1.0`. The composite
shader's color and alpha clamps consequently produced opaque white. Copies
and presentation faithfully displayed that result, so no GPU validation error
was generated. Different old contents explain the misleading intermittent
successful screenshots.

## Changes

- Pipeline objects now retain their `AbstractPipelineConfig`. `SetPipeline`
  selects the uniform domain from its declared usage: GX and GX Uber use pixel
  constants; utility pipelines use utility constants.
- Removed the upload-driven one-use flag. Zero utility draws cannot redirect
  later game draws, and several utility draws can reuse one uniform upload.
- A utility upload can initialize the uniform buffer before the first GX draw.
- Separately fixed retained VS/PS/GS slice expiration when optional content
  caching is disabled. A compiled ring-wrap regression reproduces that defect;
  fixing it alone did not resolve Sunshine's incorrect source selection.

Native changes are captured in patches 0063 and 0064. The built core, ABI pin,
source lock and vendor snapshot are updated together. The new core SHA-256 is
`1b99a62abb8c74b9f3cd215b1feca69bac1901b5045ac69e8837238d85d35a13`.

## Direct verification

The corrected first draw selects a fresh 1,536-byte ordinary Uniform upload,
with TEV register 1 `[0,0,0,0]`. All captured PS, VS, index and vertex bytes
match between CPU upload shadows and the GPU. The EFB RGB images before and
after the composite are byte-identical.

A 90-second replay of the same saved scene, with no gameplay input, no GPU
trace and optional UBO caching disabled, retains the complete beach at t40,
t71 and the final frame. The former core loses it within the same scene.
Both native regressions exercise actual production code: empty UI uploads,
repeated utility draws, pipeline transitions, initialization and epoch changes;
and retained uniforms across 84 ring wraps under 24 cache/fast/dense scenarios.

Two independent 75-second cold boots also reach the complete file-select
background. A 60-second Mario Kart Wii saved-scene check and 50-second Wario
World boot retain their rendered scenes. All five acceptance runs use the
expected hardware core and report zero renderer errors. `npm run check`,
all 880 tests, and `npm run verify:provenance` pass.

Validation covers the reported Sunshine file-select/dialog failure and these
regression scenes; it is not a full Sunshine playthrough.

Local evidence is under `.omx/sunshine-fix/`: `firstdraw-source-kind/`,
`fixed-firstdraw-source-kind/findings.json`, `fixed-long-replay/findings.json`,
`cold-boot-1/`, `cold-boot-2/`, `verification-summary.json`, and
`all-tests-final.log`. The saved state and game-derived captures remain
local and are excluded from the source patches.
