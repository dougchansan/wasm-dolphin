#include <cassert>

#include "VideoCommon/WasmWebGpuProducerProfile.h"

int main()
{
  using namespace DolphinWeb::WebGpuProducerProfile;

  assert(PHASE_COUNT == 12);
  assert(!IsEnabled());
  assert(GetEpoch() == 0);
  {
    ScopedSample disabled(Phase::RingPublish);
  }
  assert(GetCounters(Phase::RingPublish).calls.load() == 0);

  SetEnabled(true);
  assert(IsEnabled());
  assert(GetEpoch() == 1);
  for (int call = 0; call < 512; ++call)
  {
    ScopedSample sampled(Phase::RingPublish);
  }
  assert(GetCounters(Phase::RingPublish).calls.load() == 512);
  assert(GetCounters(Phase::RingPublish).samples.load() == 2);
  assert(GetCounters(Phase::RingPublish).sampled_max_ns.load() <=
         GetCounters(Phase::RingPublish).sampled_total_ns.load());

  SetEnabled(true);
  assert(GetEpoch() == 1);
  SetEnabled(false);
  assert(GetEpoch() == 2);
  {
    ScopedSample disabled_again(Phase::RingPublish);
  }
  assert(GetCounters(Phase::RingPublish).calls.load() == 512);
  return 0;
}
