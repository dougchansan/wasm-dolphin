#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include "CachedInterpreterLink.h"
using u32 = std::uint32_t; using u64 = std::uint64_t;
/* COUNTERS */
std::atomic<int> s_applied_wasm_policy{1};
struct JitFallbackDispatchStats { u64 hit = 0, empty_miss = 0, collision_miss = 0; };
JitFallbackDispatchStats GetJitFallbackDispatchStats() { return {}; }
#if DOLPHIN_WEB_STATIC_EXIT_LINKS && DOLPHIN_WEB_STATIC_EXIT_LINK_STATS
StaticExitLinks::Stats s_static_link_stats;
#endif
/* ACTUAL_GETTER_CACHE_PREFIX */

std::vector<std::string> passed, failed;
namespace L = StaticExitLinks;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void group(const char* name, const std::function<void()>& test) { try { test(); passed.emplace_back(name); }
  catch (const std::exception& e) { failed.push_back(std::string(name) + ": " + e.what()); } }
u64 reads = 0, intermediate = 0, retries = 0;

int main()
{
  group("actual diagnostic decision and dispatch partitions preserve exact counts", [] {
    L::Stats stats; stats.Init(); stats.InitialDispatch(false); stats.InitialDispatch(true);
    for (std::size_t i = 0; i < L::Stats::Decisions; ++i) {
      stats.Record(static_cast<L::Decision>(i));
      if (i != static_cast<std::size_t>(L::Decision::Linked)) stats.FallbackDispatch(i == static_cast<std::size_t>(L::Decision::Unlinked));
    }
    stats.Publish(); const auto s = *stats.Read();
    for (std::size_t i = 0; i < L::Stats::Decisions; ++i) require(s.counts[i] == 1, "one count per resolution decision");
    require(s.counts[L::Stats::Initial] == 2 && s.counts[L::Stats::InitialMiss] == 1, "initial hit/miss cohort");
    require(s.counts[L::Stats::Fallback] == L::Stats::Decisions - 1 && s.counts[L::Stats::FallbackMiss] == 1, "non-link fallback cohort");
    require((s.sequence & 1) == 0 && s.owner == 1, "coherent owner publication");
  });
  group("64-slice cadence forced publication and reset work without a new event", [] {
    L::Stats stats; stats.Init(); const auto before = *stats.Read(); stats.Record(L::Decision::Linked);
    for (unsigned i = 0; i < 63; ++i) stats.Slice();
    require(stats.Read()->sequence == before.sequence && stats.Read()->counts[0] == 0, "unpublished live counters stay private");
    stats.Slice(); auto s = *stats.Read(); require(s.slices == 64 && s.counts[0] == 1 && s.sequence > before.sequence, "64th slice publishes");
    stats.Record(L::Decision::Unlinked); stats.Publish(); s = *stats.Read(); require(s.slices == 64 && s.counts[7] == 1, "forced publication includes no-slice event");
    const auto owner = s.owner, sequence = s.sequence; stats.Init(); s = *stats.Read();
    require(s.owner == owner + 1 && s.sequence > sequence && s.slices == 0, "no-event owner reset publishes immediately");
    for (auto count : s.counts) require(count == 0, "reset counters");
  });
  group("actual getter sequence cache refreshes on new publication and owner reset", [] {
    s_static_link_stats.Init(); const std::string first = GetPpcWasmHelperStats();
    require(first.find("linked:0") != std::string::npos, "initial getter snapshot");
    s_static_link_stats.Record(L::Decision::Linked);
    require(std::string(GetPpcWasmHelperStats()) == first, "unpublished counters do not change getter");
    s_static_link_stats.Publish(); const std::string updated = GetPpcWasmHelperStats();
    require(updated != first && updated.find("linked:1") != std::string::npos, "sequence alone invalidates old stats cache");
    require(std::string(GetPpcWasmHelperStats()) == updated, "same sequence remains cached");
    s_static_link_stats.Init(); const std::string reset = GetPpcWasmHelperStats();
    require(reset != updated && reset.find("owner:2") != std::string::npos && reset.find("linked:0") != std::string::npos, "zero-event reset refreshes owner/counters");
  });
  group("concurrent SC snapshots preserve owner and complete event tuples", [] {
    L::Stats stats; stats.Init(); std::atomic<bool> ready{false}, done{false}; std::string error;
    std::thread reader([&] {
      u64 previous_seq = 0, previous_owner = 0;
      try {
        do {
          auto s = stats.Read(); if (!s) { ++retries; continue; }
          require((s->sequence & 1) == 0 && s->sequence >= previous_seq && s->owner >= previous_owner, "accepted sequence/owner order");
          previous_seq = s->sequence; previous_owner = s->owner;
          require(s->counts[L::Stats::Initial] == s->slices && s->counts[0] + s->counts[1] == s->slices, "mixed publication tuple");
          require(s->counts[L::Stats::Fallback] == s->counts[1] && s->counts[L::Stats::InitialMiss] == 0 && s->counts[L::Stats::FallbackMiss] == 0, "dispatch partition coherence");
          if (s->slices > 0 && s->slices < 20000) ++intermediate;
          ++reads; ready.store(true);
        } while (!done.load());
      } catch (const std::exception& e) { error = e.what(); ready.store(true); }
    });
    while (!ready.load()) std::this_thread::yield();
    std::thread writer([&] {
      for (unsigned owner = 0; owner < 2; ++owner) {
        if (owner) stats.Init();
        for (unsigned i = 1; i <= 20000; ++i) {
          stats.InitialDispatch(false); stats.Record(i & 1 ? L::Decision::NoCompletion : L::Decision::Linked);
          if (i & 1) stats.FallbackDispatch(false);
          stats.Slice(); if (i % 37 == 0) stats.Publish();
        }
      }
      stats.Publish(); done.store(true);
    });
    writer.join(); reader.join(); require(error.empty(), error.c_str());
    require(reads > 0 && intermediate > 0, "reader must observe intermediate concurrent states");
    const auto final = *stats.Read(); require(final.owner == 2 && final.slices == 20000 && final.counts[0] == 10000, "writer completed both epochs");
  });
  std::cout << "{\"passed\":["; for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":["; for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "],\"coherentSnapshots\":" << reads << ",\"intermediateSnapshots\":" << intermediate << ",\"retryMisses\":" << retries << "}\n";
  return failed.empty() ? 0 : 1;
}
