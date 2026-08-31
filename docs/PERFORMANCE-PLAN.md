# Performance and correctness plan

An ordered, testable backlog. Each item states a hypothesis, the test that
settles it, and what counts as success. Work them one at a time and record the
result — including "hypothesis dead", which is a result.

Written 2026-08-31 after a measurement session that killed several plausible
leads. Read [Measurement discipline](ARCHITECTURE.md#measurement-discipline)
first; most of the dead leads below died because a counter did not mean what it
looked like.

## Current baseline

`video=wgpu`, 45 GameCube discs, 45s each:

| metric | value |
| --- | ---: |
| boots | 41 (2 static, 2 black) |
| titles at >=95% game speed | 13 |
| titles at >=80% | 17 |
| mean unique visual fps | 28.4 |

Two clusters: ~13 titles at 99-100%, and a long tail at 20-40%. The tail is
what this plan is about.

## Already ruled out, with evidence — do not re-run these

| lead | evidence it is dead |
| --- | --- |
| JIT tier (guarded vs mixed) | 35/35, 29/29, 31/29 on three slow titles |
| JIT admission / emitter breadth | `reject:0` — nothing is rejected for unsupported instructions |
| JIT coverage generally | 11 -> 59,754,839 block runs moved Metroid Prime 34% -> 36% |
| the renderer, for most slow titles | Metroid 34/34, Paper Mario 35.5/34, Colosseum 32/36 (hw/sw) |
| stale prebuilt JIT cache | A/B with the broken v1 file: Melee 100%/99%, F-Zero 99% |

Melee is not a valid control for anything CPU-side: it sits at the 100% cap with
the JIT on or off, so a difference cannot show. Use a title below realtime.

---

## 1. Identify `wasm-function[1026]`  — DO THIS FIRST

**Hypothesis.** 94.6% of emulation-thread self time is in one wasm function that
has never been identified. It was assumed to be the cached interpreter; that
assumption is unverified and partly contradicted by item 2's result.

**Test.** Resolve the index against the core's wasm name section
(`cores/dolphin/dolphin-core-upstream.wasm`), e.g. `wasm-objdump -x -j Function`
or the emscripten symbol map, and confirm against a second profile capture.

**Success.** The function is named, and its role (interpreter dispatch, software
raster, FIFO, memory helper, sync) is stated with evidence.

**Why first.** The tail sits at ~34% with both the renderer and the JIT
eliminated. Something else dominates and nobody has named it. Every further
performance decision is guesswork until this is answered.

### Item 1 result (2026-08-31)

`wasm-function[1026]` was never named, and the attempt to name it produced two
warnings worth keeping:

- Wasm function indices are **build-specific**. Resolving the old profile's
  index against a freshly built binary gave `File::Rename` -- a confident,
  meaningless answer. Never map an index across builds.
- `--profiling-funcs` (needed for a name section, since the shipping wasm is
  stripped) costs about **20% speed**: Metroid Prime 32% plain vs 25.5% named.
  Nothing measured on a named build is comparable to the baseline.

On the named build every thread was dominated by `_do_futex_wait`, which looked
like a synchronisation bottleneck. It is not:

| test | result |
| --- | --- |
| pacing / queue depth (tick-4, direct-1, smooth-8) | 25.5 / 24 / 25.5 -- no effect |
| single vs dual core | 32% vs 30.5% -- no effect |

**What the bottleneck actually is: PPC execution throughput.** Underclocking the
emulated CPU scales speed almost proportionally:

| `oc` | speed |
| ---: | ---: |
| 1 | 30% |
| 0.5 | 34% |
| 0.25 | **78%** |

So these titles are CPU-bound, and JIT coverage is the right lever after all.

**Why coverage is ~8%: compiled prefixes are ~6 instructions long.** The helper
stat `pre:6/74` is `s_wasm_prefix_instruction_sum / s_wasm_block_attempt_count`
-- the average number of instructions compiled per attempted block, against a
max of 74. The admission loop walks a block and `break`s at the first
instruction it cannot emit, compiling only the prefix before it. With warmup
fixed, Metroid Prime runs 59.7M block executions, but at ~6 instructions each
that is roughly 8% of the instruction stream.

This revises the "emitter breadth is dead" entry above. `reject:0` is true --
whole blocks are not rejected -- but blocks are silently **truncated** at the
first unsupported instruction, which has the same effect and is invisible in
the reject counter. **Raising `pre:` is the performance lever.**

Next: find which instructions terminate prefixes most often, ranked by
frequency. The histogram infrastructure exists
(`s_wasm_direct_reject_key_counts`, emitted as `| rejOPCD/SUBOP:count`) but only
counts direct-tier rejects, not prefix terminations. Add the equivalent
histogram at the `break` sites in the prefix loop, then rank.

## 2. Ship the JIT warmup fix

**Hypothesis.** `jitwarmup` counts *stable video frames*, so at 20fps the JIT
engages ~35s in. It is specified in frames but behaves as a time delay that
scales inversely with how slow the game is — penalising exactly the titles that
need it.

**Evidence.** Metroid Prime, 50s run: warmup 700 gives 7 blocks compiled and 11
block runs; warmup 60 gives 1,356 compiled and 59.7M runs.

**Measured gain.** +2 points (Metroid 34->36, Star Fox 24->26), 0 on Colosseum.
Small but free.

**Test.** Full 45-disc sweep at the new default; confirm no title regresses and
watch for compile-burst stalls, which is what the long warmup was protecting
against. Check `presentationMaxIntervalMs` and the 0%-speed sample fraction.

**Success.** Mean speed up, no title down more than noise, no new stalls.

## 3. Why is JIT'd code barely faster than interpreting?

**Hypothesis.** Per-block overhead eats the win: WASM has no cross-module direct
jumps so every block returns to a dispatcher, and guest state is loaded and
stored per block (`stateu32:1238ld/753st`).

**Test.** From item 1's profile, split dispatch cost from block-body cost — the
`cpu-profile-analyze.mjs` tool was built for exactly this ratio and currently
reports `0 block modules` because the JIT was not engaged. Re-run it with
warmup 60 so blocks actually exist.

**Success.** A number: what fraction of emulation time is dispatch versus block
body. That ratio is the ceiling on block linking.

**Warning.** `G:\dolrecompwned\DolRecomp\docs\register-cache-design.md` records
**four reverted attempts** at promoting guest registers out of the state struct,
concluding it must not be retried until the state model and the emitter derive
from one shared description. Read it before proposing state promotion.

## 4. Finish the Wii rendering fix

**State.** The hardware renderer draws Mario Kart Wii correctly — the EFB holds
the right scene and the EFB->XFB copy is verified correct by paired readback.
The fault is in the XFB -> backbuffer blit.

**Lead.** #15: the XFB blit viewport is exactly half the source width
(`fbColor=47 vp=304x456` against a 608-wide target).

**Test.** Instrument the backbuffer blit's source rect and viewport; compare
against the XFB entry's dimensions. Then fix and verify by eye against the
software reference at the same screen.

**Success.** Mario Kart Wii renders its race scene on `video=wgpu`.

## 5. Sweep the untested configuration space

Single vs dual core, CPU overclock, frame queue depth, pacing mode, resolution
scale. Cheap. Expect mostly washes — but item 2 came from exactly this kind of
check, so it is not zero-value.

**Success.** Each knob has a measured effect on the slow tail, recorded here.

## 6. The two remaining renderer stubs

`WebGPU::TextureCache::CopyEFB` (EFB copy to RAM) and `WebGPUStagingTexture`
are both empty. Any game relying on EFB readback into guest RAM silently gets
nothing. Not yet tied to a specific broken title — do that first rather than
implementing blind.

## 7. Broken titles

GoldenEye Rogue Agent 0% and black; Resident Evil Code: Veronica X black;
Animal Crossing static on both paths (#11). Each needs its own diagnosis.

## 8. Wii Remote input

No Wii title is playable past its controller prompt. Mario Kart Wii accepts a
GameCube pad, which is why it could be driven at all; Zelda cannot.

## 9. Audio

Never measured in this session. Unknown whether it is correct or costly.

---

## Measurement blind spot

Game speed caps at 100%, so for the 13 fast titles a change cannot show as a
gain and only large regressions are visible. Any "no change" on those titles is
uninformative by construction — say so rather than reporting it as evidence.
