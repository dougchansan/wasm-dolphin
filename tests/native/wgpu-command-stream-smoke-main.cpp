// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstdio>

#include "VideoBackends/WebGPU/WebGPUCommandStream.h"

namespace
{
bool Check(const char* name, int result)
{
  if (result == 0)
    return true;
  std::fprintf(stderr, "%s failed (%d): %s\n", name, result,
               WebGPU::GetWebGpuCommandStreamGeometrySmokeError());
  return false;
}
}  // namespace

int main()
{
  const bool non_indexed =
      Check("non-indexed parity", WebGPU::RunWebGpuCommandStreamGeometryParitySmoke(0));
  const bool indexed =
      Check("indexed parity", WebGPU::RunWebGpuCommandStreamGeometryParitySmoke(1));
  const bool rollback =
      Check("publication rollback", WebGPU::RunWebGpuCommandStreamGeometryRollbackSmoke());
  if (!non_indexed || !indexed || !rollback)
    return 1;
  std::puts("WebGPU command-stream native smokes passed");
  return 0;
}
