// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstdio>

#include "VideoBackends/WebGPU/WebGPUCommandStream.h"
#include "VideoBackends/WebGPU/WebGPUVertexManager.h"

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
  bool vertex_manager_parity = true;
  for (const int packed : {0, 1})
  {
    for (const int indexed_mode : {0, 1})
    {
      vertex_manager_parity &=
          Check("VertexManager geometry parity",
                WebGPU::RunWebGpuVertexManagerGeometryParitySmoke(indexed_mode, packed),
                WebGPU::GetWebGpuVertexManagerGeometrySmokeError);
    }
    vertex_manager_parity &=
        Check("VertexManager geometry rollback",
              WebGPU::RunWebGpuVertexManagerGeometryRollbackSmoke(packed),
              WebGPU::GetWebGpuVertexManagerGeometrySmokeError);
  }
  const bool vertex_manager_lifecycle =
      Check("VertexManager geometry lifecycle",
            WebGPU::RunWebGpuVertexManagerGeometryLifecycleSmoke(),
            WebGPU::GetWebGpuVertexManagerGeometrySmokeError);
  const bool vertex_manager_range =
      Check("VertexManager geometry range",
            WebGPU::RunWebGpuVertexManagerGeometryRangeSmoke(),
            WebGPU::GetWebGpuVertexManagerGeometrySmokeError);
  if (!non_indexed || !indexed || !rollback || !dense_packet || !dense_rollback ||
      !vertex_manager_parity || !vertex_manager_lifecycle || !vertex_manager_range)
    return 1;
  std::puts("WebGPU command-stream native smokes passed");
  return 0;
}
