#include <cassert>
#include <cstddef>

#include "VideoCommon/WasmWebGpuDrawProfile.h"

int main()
{
  using namespace DolphinWeb::WebGpuDrawProfile;

  assert(PHASE_COUNT == 7);
  assert(!IsEnabled());
  for (std::size_t index = 0; index < PHASE_COUNT; ++index)
  {
    const Phase phase = static_cast<Phase>(index);
    assert(!ShouldSample(phase, 0) || SAMPLE_SEEDS[index] == 0);
    const std::uint64_t calls = static_cast<std::uint64_t>(GetSamplePeriod(phase)) * 5;
    std::uint64_t expected = 0;
    for (std::uint64_t call = 0; call < calls; ++call)
      expected += ShouldSample(phase, call) ? 1 : 0;
    assert(expected == 5);
  }

  SetEnabled(true);
  assert(GetEpoch() == 1);
  for (std::size_t index = 0; index < PHASE_COUNT; ++index)
  {
    const Phase phase = static_cast<Phase>(index);
    const std::uint64_t calls = static_cast<std::uint64_t>(GetSamplePeriod(phase)) * 5;
    for (std::uint64_t call = 0; call < calls; ++call)
    {
      ScopedSample sample(phase);
      sample.Pause();
      sample.Resume();
    }
    assert(GetCounters(phase).calls.load() == calls);
    assert(GetCounters(phase).samples.load() == 5);
    assert(GetCounters(phase).sampled_max_ns.load() <=
           GetCounters(phase).sampled_total_ns.load());
  }

  SetEnabled(false);
  assert(GetEpoch() == 2);
  return 0;
}
