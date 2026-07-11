// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstdio>

#include "VideoBackends/WebGPU/WebGPUCommandStream.h"

namespace
{
bool Check(const char* name, int result, const char* (*error)())
{
  if (result == 0)
    return true;
  std::fprintf(stderr, "%s failed (%d): %s\n", name, result,
               error());
  return false;
}
}  // namespace

int main()
{
  const bool non_indexed =
      Check("non-indexed parity", WebGPU::RunWebGpuCommandStreamGeometryParitySmoke(0),
            WebGPU::GetWebGpuCommandStreamGeometrySmokeError);
  const bool indexed =
      Check("indexed parity", WebGPU::RunWebGpuCommandStreamGeometryParitySmoke(1),
            WebGPU::GetWebGpuCommandStreamGeometrySmokeError);
  const bool rollback =
      Check("publication rollback", WebGPU::RunWebGpuCommandStreamGeometryRollbackSmoke(),
            WebGPU::GetWebGpuCommandStreamGeometrySmokeError);
  const bool dense_packet =
      Check("dense UBO packet", WebGPU::RunWebGpuDenseUboPacketSmoke(),
            WebGPU::GetWebGpuDenseUboSmokeError);
  const bool dense_rollback =
      Check("dense UBO rollback", WebGPU::RunWebGpuDenseUboRollbackSmoke(),
            WebGPU::GetWebGpuDenseUboSmokeError);
  if (!non_indexed || !indexed || !rollback || !dense_packet || !dense_rollback)
    return 1;
  std::puts("WebGPU command-stream native smokes passed");
  return 0;
}
