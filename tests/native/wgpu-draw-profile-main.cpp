#include <cassert>
#include <atomic>
#include <cstddef>
#include <thread>

#include "VideoCommon/WasmWebGpuDrawProfile.h"

int main()
{
  using namespace DolphinWeb::WebGpuDrawProfile;

  assert(PHASE_COUNT == 7);
  assert(!IsEnabled());
  assert(GetEpoch() == 0);
  {
    ScopedSample disabled(Phase::PipelineUidBuild);
  }
  assert(GetCounters(Phase::PipelineUidBuild).calls.load() == 0);
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

  // The first disabled call filled this thread's cache. A later enable must
  // become visible within one bounded refresh period.
  SetEnabled(true);
  assert(GetEpoch() == 1);
  std::uint32_t enable_probe_calls = 0;
  while (GetCounters(Phase::PipelineUidBuild).calls.load() == 0 &&
         enable_probe_calls < ENABLE_REFRESH_PERIOD)
  {
    ScopedSample probe(Phase::PipelineUidBuild);
    ++enable_probe_calls;
  }
  assert(enable_probe_calls <= ENABLE_REFRESH_PERIOD);
  assert(GetCounters(Phase::PipelineUidBuild).calls.load() == 1);

  for (std::size_t index = 0; index < PHASE_COUNT; ++index)
  {
    const Phase phase = static_cast<Phase>(index);
    const std::uint64_t calls_before = GetCounters(phase).calls.load();
    const std::uint64_t samples_before = GetCounters(phase).samples.load();
    const std::uint64_t calls = static_cast<std::uint64_t>(GetSamplePeriod(phase)) * 5;
    for (std::uint64_t call = 0; call < calls; ++call)
    {
      ScopedSample sample(phase);
      sample.Pause();
      sample.Resume();
    }
    assert(GetCounters(phase).calls.load() == calls_before + calls);
    const std::uint64_t samples_after = GetCounters(phase).samples.load();
    assert(samples_after >= samples_before + 4 && samples_after <= samples_before + 6);
    assert(GetCounters(phase).sampled_max_ns.load() <=
           GetCounters(phase).sampled_total_ns.load());
  }

  // A newly-created thread has an unseen control snapshot and must observe an
  // already-enabled profiler on its first probe. Keep it alive across disable
  // to prove each thread independently stops within the same bound.
  std::atomic<bool> thread_ready{false};
  std::atomic<bool> disable_published{false};
  std::thread second_thread([&] {
    const std::uint64_t before_first = GetCounters(Phase::CommandStage).calls.load();
    {
      ScopedSample first_probe(Phase::CommandStage);
    }
    assert(GetCounters(Phase::CommandStage).calls.load() == before_first + 1);
    thread_ready.store(true, std::memory_order_release);
    while (!disable_published.load(std::memory_order_acquire))
      std::this_thread::yield();

    const std::uint64_t before_disable = GetCounters(Phase::CommandStage).calls.load();
    for (std::uint32_t call = 0; call < ENABLE_REFRESH_PERIOD; ++call)
    {
      ScopedSample pending_disable(Phase::CommandStage);
    }
    const std::uint64_t after_disable = GetCounters(Phase::CommandStage).calls.load();
    assert(after_disable - before_disable < ENABLE_REFRESH_PERIOD);
    for (std::uint32_t call = 0; call < ENABLE_REFRESH_PERIOD; ++call)
    {
      ScopedSample disabled_again(Phase::CommandStage);
    }
    assert(GetCounters(Phase::CommandStage).calls.load() == after_disable);
  });
  while (!thread_ready.load(std::memory_order_acquire))
    std::this_thread::yield();

  SetEnabled(false);
  assert(GetEpoch() == 2);
  disable_published.store(true, std::memory_order_release);
  second_thread.join();
  const std::uint64_t calls_before_disable =
      GetCounters(Phase::PipelineUidBuild).calls.load();
  for (std::uint32_t call = 0; call < ENABLE_REFRESH_PERIOD; ++call)
  {
    ScopedSample pending_disable(Phase::PipelineUidBuild);
  }
  const std::uint64_t calls_after_disable =
      GetCounters(Phase::PipelineUidBuild).calls.load();
  assert(calls_after_disable - calls_before_disable < ENABLE_REFRESH_PERIOD);
  for (std::uint32_t call = 0; call < ENABLE_REFRESH_PERIOD; ++call)
  {
    ScopedSample disabled_again(Phase::PipelineUidBuild);
  }
  assert(GetCounters(Phase::PipelineUidBuild).calls.load() == calls_after_disable);

  SetEnabled(false);
  assert(GetEpoch() == 2);
  return 0;
}
