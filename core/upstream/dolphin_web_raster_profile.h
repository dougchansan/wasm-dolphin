// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <initializer_list>

namespace DolphinWeb::RasterProfile
{
using Clock = std::chrono::steady_clock;

enum class Phase
{
  RasterTraversal,
  TevPixel,
  TextureSample,
};

// Detailed cases use a disjoint sparse TEV/texture sample averaging 1/4096
// calls, so key construction and table insertion never inflate phase timing.
// The tables are fixed-size and store complete keys, so hash collisions probe
// to another slot rather than merging unrelated cases.  `other_samples` only
// grows when every slot is occupied by a different exact key.
constexpr std::size_t TEXTURE_CASE_CAPACITY = 256;
constexpr std::size_t TEV_CASE_CAPACITY = 256;

struct TextureCaseKey
{
  std::uint64_t packed = 0;

  friend constexpr bool operator==(TextureCaseKey left, TextureCaseKey right)
  {
    return left.packed == right.packed;
  }
};

struct TevCaseKey
{
  std::uint64_t structure = 0;
  std::uint64_t program_fingerprint = 0;

  friend constexpr bool operator==(TevCaseKey left, TevCaseKey right)
  {
    return left.structure == right.structure &&
           left.program_fingerprint == right.program_fingerprint;
  }
};

template <typename Key>
struct CaseEntry
{
  Key key{};
  std::uint64_t samples = 0;
  std::uint64_t work = 0;
  bool occupied = false;
};

template <typename Key, std::size_t Capacity>
struct CaseTableSnapshot
{
  std::array<CaseEntry<Key>, Capacity> entries{};
  std::uint64_t total_samples = 0;
  std::uint64_t total_work = 0;
  std::uint64_t other_samples = 0;
  std::uint64_t other_work = 0;
  std::uint64_t collision_count = 0;
};

using TextureCaseTableSnapshot = CaseTableSnapshot<TextureCaseKey, TEXTURE_CASE_CAPACITY>;
using TevCaseTableSnapshot = CaseTableSnapshot<TevCaseKey, TEV_CASE_CAPACITY>;

template <typename Key, std::size_t Capacity>
struct SharedCaseTable
{
  std::atomic_flag lock = ATOMIC_FLAG_INIT;
  std::array<CaseEntry<Key>, Capacity> entries{};
  std::uint64_t total_samples = 0;
  std::uint64_t total_work = 0;
  std::uint64_t other_samples = 0;
  std::uint64_t other_work = 0;
  std::uint64_t collision_count = 0;
};

struct PhaseCounters
{
  std::uint64_t calls = 0;
  std::uint64_t timed_samples = 0;
  std::uint64_t sampled_total_us = 0;
  std::uint64_t sampled_total_ns = 0;
};

struct PhasePublishCursor
{
  std::uint64_t calls = 0;
  std::uint64_t timed_samples = 0;
  std::uint64_t sampled_total_us = 0;
};

struct LocalCounters
{
  std::uint64_t epoch = 0;
  std::uint64_t active_scope_depth = 0;
  PhaseCounters raster;
  PhaseCounters tev;
  PhaseCounters texture;
  PhasePublishCursor raster_published;
  PhasePublishCursor tev_published;
  PhasePublishCursor texture_published;
  std::uint64_t tev_next_case_call = 0;
  std::uint64_t texture_next_case_call = 0;
  std::uint32_t tev_case_rng = 0;
  std::uint32_t texture_case_rng = 0;
  std::uint64_t raster_candidate_pixels = 0;
  std::uint64_t raster_candidate_pixels_published = 0;
  std::uint64_t tev_stages = 0;
  std::uint64_t tev_stages_published = 0;
  std::uint64_t fifo_burst_count = 0;
  std::uint64_t fifo_burst_count_published = 0;
  std::uint64_t fifo_consume_count = 0;
  std::uint64_t fifo_consume_count_published = 0;
  std::uint64_t fifo_bytes_last = 0;
  std::uint64_t fifo_bytes_max = 0;
  std::uint64_t fifo_age_last_us = 0;
  std::uint64_t fifo_age_max_us = 0;
  std::uint64_t fifo_age_sample_count = 0;
  std::uint64_t fifo_age_sample_count_published = 0;
  std::uint64_t fifo_pending_observed_at_us = 0;
  std::uint64_t xfb_generation_count = 0;
  std::uint64_t xfb_generation_last_us = 0;
  std::uint64_t xfb_generation_total_us = 0;
  std::uint64_t xfb_generation_max_us = 0;
  std::uint64_t frame_generation_count = 0;
  std::uint64_t frame_interval_last_us = 0;
  std::uint64_t frame_interval_total_us = 0;
  std::uint64_t frame_interval_max_us = 0;
  std::uint64_t frame_interval_count = 0;
  std::uint64_t last_frame_at_us = 0;
};

struct Snapshot
{
  bool enabled = false;
  std::uint32_t case_sample_seed = 0;
  PhaseCounters raster;
  PhaseCounters tev;
  PhaseCounters texture;
  TextureCaseTableSnapshot texture_cases;
  TevCaseTableSnapshot tev_cases;
  std::uint64_t raster_candidate_pixels = 0;
  std::uint64_t tev_stages = 0;
  std::uint64_t fifo_burst_count = 0;
  std::uint64_t fifo_consume_count = 0;
  std::uint64_t fifo_bytes_last = 0;
  std::uint64_t fifo_bytes_max = 0;
  std::uint64_t fifo_age_last_us = 0;
  std::uint64_t fifo_age_max_us = 0;
  std::uint64_t fifo_age_sample_count = 0;
  std::uint64_t fifo_distance_underflow_count = 0;
  std::uint64_t xfb_generation_count = 0;
  std::uint64_t xfb_generation_last_us = 0;
  std::uint64_t xfb_generation_total_us = 0;
  std::uint64_t xfb_generation_max_us = 0;
  std::uint64_t frame_generation_count = 0;
  std::uint64_t frame_interval_last_us = 0;
  std::uint64_t frame_interval_total_us = 0;
  std::uint64_t frame_interval_max_us = 0;
  std::uint64_t frame_interval_count = 0;
};

// Low bit: enabled. Remaining bits: reset epoch. One state load both gates the
// hot-path probe and lets each renderer pthread lazily reset its TLS counters
// after a disable/re-enable without a second atomic load on every pixel.
inline std::atomic<std::uint64_t> s_profile_state{0};
inline std::atomic<std::uint32_t> s_case_sample_seed{1};
inline thread_local LocalCounters s_local{};

inline std::atomic<std::uint64_t> s_raster_calls{0};
inline std::atomic<std::uint64_t> s_raster_timed_samples{0};
inline std::atomic<std::uint64_t> s_raster_sampled_total_us{0};
inline std::atomic<std::uint64_t> s_raster_candidate_pixels{0};
inline std::atomic<std::uint64_t> s_tev_calls{0};
inline std::atomic<std::uint64_t> s_tev_stages{0};
inline std::atomic<std::uint64_t> s_tev_timed_samples{0};
inline std::atomic<std::uint64_t> s_tev_sampled_total_us{0};
inline std::atomic<std::uint64_t> s_texture_calls{0};
inline std::atomic<std::uint64_t> s_texture_timed_samples{0};
inline std::atomic<std::uint64_t> s_texture_sampled_total_us{0};
inline SharedCaseTable<TextureCaseKey, TEXTURE_CASE_CAPACITY> s_texture_cases{};
inline SharedCaseTable<TevCaseKey, TEV_CASE_CAPACITY> s_tev_cases{};
inline std::atomic<std::uint64_t> s_fifo_burst_count{0};
inline std::atomic<std::uint64_t> s_fifo_consume_count{0};
inline std::atomic<std::uint64_t> s_fifo_bytes_last{0};
inline std::atomic<std::uint64_t> s_fifo_bytes_max{0};
inline std::atomic<std::uint64_t> s_fifo_age_last_us{0};
inline std::atomic<std::uint64_t> s_fifo_age_max_us{0};
inline std::atomic<std::uint64_t> s_fifo_age_sample_count{0};
inline std::atomic<std::uint64_t> s_fifo_distance_underflow_count{0};
inline std::atomic<std::uint64_t> s_xfb_generation_count{0};
inline std::atomic<std::uint64_t> s_xfb_generation_last_us{0};
inline std::atomic<std::uint64_t> s_xfb_generation_total_us{0};
inline std::atomic<std::uint64_t> s_xfb_generation_max_us{0};
inline std::atomic<std::uint64_t> s_frame_generation_count{0};
inline std::atomic<std::uint64_t> s_frame_interval_last_us{0};
inline std::atomic<std::uint64_t> s_frame_interval_total_us{0};
inline std::atomic<std::uint64_t> s_frame_interval_max_us{0};
inline std::atomic<std::uint64_t> s_frame_interval_count{0};

inline std::uint64_t NowMicros()
{
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count());
}

inline void AtomicMax(std::atomic<std::uint64_t>& target, std::uint64_t value)
{
  std::uint64_t current = target.load(std::memory_order_relaxed);
  while (value > current &&
         !target.compare_exchange_weak(current, value, std::memory_order_relaxed))
  {
  }
}

inline bool Enabled()
{
  return (s_profile_state.load(std::memory_order_acquire) & 1) != 0;
}

inline std::uint64_t ProfileEpoch(std::uint64_t state)
{
  return state >> 1;
}

inline void EnsureLocalEpoch(std::uint64_t epoch)
{
  if (s_local.epoch == epoch)
    return;
  s_local = LocalCounters{};
  s_local.epoch = epoch;
}

inline bool PrepareLocal()
{
  const std::uint64_t state = s_profile_state.load(std::memory_order_acquire);
  if ((state & 1) == 0)
    return false;
  EnsureLocalEpoch(ProfileEpoch(state));
  return true;
}

template <typename Key, std::size_t Capacity>
inline void ResetCaseTable(SharedCaseTable<Key, Capacity>& table);

inline void ResetPublished()
{
  for (std::atomic<std::uint64_t>* counter : {
           &s_raster_calls, &s_raster_timed_samples, &s_raster_sampled_total_us,
           &s_raster_candidate_pixels, &s_tev_calls, &s_tev_stages, &s_tev_timed_samples,
           &s_tev_sampled_total_us, &s_texture_calls, &s_texture_timed_samples,
           &s_texture_sampled_total_us, &s_fifo_burst_count, &s_fifo_consume_count,
           &s_fifo_bytes_last, &s_fifo_bytes_max, &s_fifo_age_last_us, &s_fifo_age_max_us,
           &s_fifo_age_sample_count, &s_fifo_distance_underflow_count,
           &s_xfb_generation_count, &s_xfb_generation_last_us, &s_xfb_generation_total_us,
           &s_xfb_generation_max_us, &s_frame_generation_count, &s_frame_interval_last_us,
           &s_frame_interval_total_us, &s_frame_interval_max_us, &s_frame_interval_count})
  {
    counter->store(0, std::memory_order_relaxed);
  }
  ResetCaseTable(s_texture_cases);
  ResetCaseTable(s_tev_cases);
}

inline void SetEnabled(bool enabled)
{
  const std::uint64_t previous = s_profile_state.load(std::memory_order_relaxed);
  const std::uint64_t disabled_state = (ProfileEpoch(previous) + 1) << 1;
  // Hide the probes before clearing published counters. Publishing the new
  // enabled epoch last prevents a renderer thread's first sample from being
  // erased by ResetPublished().
  s_profile_state.store(disabled_state, std::memory_order_release);
  ResetPublished();
  if (enabled)
  {
    std::uint32_t seed = static_cast<std::uint32_t>(NowMicros());
    if (seed == 0)
      seed = 1;
    s_case_sample_seed.store(seed, std::memory_order_release);
    s_profile_state.store(disabled_state | 1, std::memory_order_release);
  }
}

inline PhaseCounters& LocalPhase(Phase phase)
{
  switch (phase)
  {
  case Phase::RasterTraversal:
    return s_local.raster;
  case Phase::TevPixel:
    return s_local.tev;
  case Phase::TextureSample:
    return s_local.texture;
  }
  return s_local.raster;
}

inline PhasePublishCursor& LocalPublishCursor(Phase phase)
{
  switch (phase)
  {
  case Phase::RasterTraversal:
    return s_local.raster_published;
  case Phase::TevPixel:
    return s_local.tev_published;
  case Phase::TextureSample:
    return s_local.texture_published;
  }
  return s_local.raster_published;
}

inline void PublishDelta(std::atomic<std::uint64_t>& destination, std::uint64_t value,
                         std::uint64_t& published)
{
  if (value > published)
    destination.fetch_add(value - published, std::memory_order_relaxed);
  published = value;
}

inline void PublishPhase(Phase phase)
{
  PhaseCounters& counters = LocalPhase(phase);
  PhasePublishCursor& published = LocalPublishCursor(phase);
  switch (phase)
  {
  case Phase::RasterTraversal:
    PublishDelta(s_raster_calls, counters.calls, published.calls);
    PublishDelta(s_raster_timed_samples, counters.timed_samples, published.timed_samples);
    PublishDelta(s_raster_sampled_total_us, counters.sampled_total_ns / 1000,
                 published.sampled_total_us);
    PublishDelta(s_raster_candidate_pixels, s_local.raster_candidate_pixels,
                 s_local.raster_candidate_pixels_published);
    break;
  case Phase::TevPixel:
    PublishDelta(s_tev_calls, counters.calls, published.calls);
    PublishDelta(s_tev_timed_samples, counters.timed_samples, published.timed_samples);
    PublishDelta(s_tev_sampled_total_us, counters.sampled_total_ns / 1000,
                 published.sampled_total_us);
    PublishDelta(s_tev_stages, s_local.tev_stages, s_local.tev_stages_published);
    break;
  case Phase::TextureSample:
    PublishDelta(s_texture_calls, counters.calls, published.calls);
    PublishDelta(s_texture_timed_samples, counters.timed_samples, published.timed_samples);
    PublishDelta(s_texture_sampled_total_us, counters.sampled_total_ns / 1000,
                 published.sampled_total_us);
    break;
  }
}

inline std::uint64_t MixCaseHash(std::uint64_t value)
{
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31);
}

inline std::uint64_t CaseHash(TextureCaseKey key)
{
  return MixCaseHash(key.packed);
}

inline std::uint64_t CaseHash(TevCaseKey key)
{
  return MixCaseHash(key.structure) ^ MixCaseHash(key.program_fingerprint + 0x9e3779b97f4a7c15ULL);
}

template <typename Key, std::size_t Capacity>
inline void LockCaseTable(SharedCaseTable<Key, Capacity>& table)
{
  while (table.lock.test_and_set(std::memory_order_acquire))
  {
  }
}

template <typename Key, std::size_t Capacity>
inline void UnlockCaseTable(SharedCaseTable<Key, Capacity>& table)
{
  table.lock.clear(std::memory_order_release);
}

template <typename Key, std::size_t Capacity>
inline void ResetCaseTable(SharedCaseTable<Key, Capacity>& table)
{
  LockCaseTable(table);
  table.entries = {};
  table.total_samples = 0;
  table.total_work = 0;
  table.other_samples = 0;
  table.other_work = 0;
  table.collision_count = 0;
  UnlockCaseTable(table);
}

template <typename Key, std::size_t Capacity>
inline void RecordCase(SharedCaseTable<Key, Capacity>& table, Key key, std::uint64_t work,
                       std::uint64_t expected_epoch)
{
  static_assert(Capacity > 0);
  LockCaseTable(table);
  const std::uint64_t state = s_profile_state.load(std::memory_order_acquire);
  if ((state & 1) == 0 || ProfileEpoch(state) != expected_epoch)
  {
    UnlockCaseTable(table);
    return;
  }
  ++table.total_samples;
  table.total_work += work;
  const std::size_t first = static_cast<std::size_t>(CaseHash(key) % Capacity);
  for (std::size_t probe = 0; probe < Capacity; ++probe)
  {
    CaseEntry<Key>& entry = table.entries[(first + probe) % Capacity];
    if (!entry.occupied)
    {
      entry.key = key;
      entry.samples = 1;
      entry.work = work;
      entry.occupied = true;
      UnlockCaseTable(table);
      return;
    }
    if (entry.key == key)
    {
      ++entry.samples;
      entry.work += work;
      UnlockCaseTable(table);
      return;
    }
    ++table.collision_count;
  }
  ++table.other_samples;
  table.other_work += work;
  UnlockCaseTable(table);
}

template <typename Key, std::size_t Capacity>
inline CaseTableSnapshot<Key, Capacity> CaptureCaseTable(SharedCaseTable<Key, Capacity>& table)
{
  LockCaseTable(table);
  CaseTableSnapshot<Key, Capacity> snapshot;
  snapshot.entries = table.entries;
  snapshot.total_samples = table.total_samples;
  snapshot.total_work = table.total_work;
  snapshot.other_samples = table.other_samples;
  snapshot.other_work = table.other_work;
  snapshot.collision_count = table.collision_count;
  UnlockCaseTable(table);
  return snapshot;
}

inline constexpr std::uint64_t PackTextureCaseKey(
    std::uint32_t texture_format, bool linear, std::uint32_t mipmap_filter,
    std::uint32_t base_mip, bool mip_linear, std::uint32_t wrap_s, std::uint32_t wrap_t,
    bool manually_managed, std::uint32_t tlut_format, bool width_power_of_two,
    bool height_power_of_two, std::uint32_t decode_work, std::uint32_t min_filter,
    std::uint32_t mag_filter)
{
  return (static_cast<std::uint64_t>(texture_format) & 0xf) |
         (static_cast<std::uint64_t>(linear) << 4) |
         ((static_cast<std::uint64_t>(mipmap_filter) & 0x3) << 5) |
         ((static_cast<std::uint64_t>(base_mip) & 0x1f) << 7) |
         (static_cast<std::uint64_t>(mip_linear) << 12) |
         ((static_cast<std::uint64_t>(wrap_s) & 0x3) << 13) |
         ((static_cast<std::uint64_t>(wrap_t) & 0x3) << 15) |
         (static_cast<std::uint64_t>(manually_managed) << 17) |
         ((static_cast<std::uint64_t>(tlut_format) & 0x3) << 18) |
         (static_cast<std::uint64_t>(width_power_of_two) << 20) |
         (static_cast<std::uint64_t>(height_power_of_two) << 21) |
         ((static_cast<std::uint64_t>(decode_work) & 0xf) << 22) |
         ((static_cast<std::uint64_t>(min_filter) & 0x1) << 26) |
         ((static_cast<std::uint64_t>(mag_filter) & 0x1) << 27);
}

inline constexpr std::uint64_t PackTevStructuralKey(
    std::uint32_t tev_stage_count, std::uint32_t indirect_stage_count,
    std::uint32_t texture_generation_count, std::uint32_t color_channel_count,
    std::uint32_t texture_enabled_count, std::uint32_t active_indirect_count,
    std::uint32_t used_indirect_texture_mask, std::uint32_t color_compare_count,
    std::uint32_t alpha_compare_count, std::uint32_t color_clamp_count,
    std::uint32_t alpha_clamp_count)
{
  return (static_cast<std::uint64_t>(tev_stage_count) & 0x1f) |
         ((static_cast<std::uint64_t>(indirect_stage_count) & 0x7) << 5) |
         ((static_cast<std::uint64_t>(texture_generation_count) & 0xf) << 8) |
         ((static_cast<std::uint64_t>(color_channel_count) & 0x7) << 12) |
         ((static_cast<std::uint64_t>(texture_enabled_count) & 0x1f) << 15) |
         ((static_cast<std::uint64_t>(active_indirect_count) & 0x1f) << 20) |
         ((static_cast<std::uint64_t>(used_indirect_texture_mask) & 0xf) << 25) |
         ((static_cast<std::uint64_t>(color_compare_count) & 0x1f) << 29) |
         ((static_cast<std::uint64_t>(alpha_compare_count) & 0x1f) << 34) |
         ((static_cast<std::uint64_t>(color_clamp_count) & 0x1f) << 39) |
         ((static_cast<std::uint64_t>(alpha_clamp_count) & 0x1f) << 44);
}

constexpr std::uint64_t TEV_PROGRAM_FINGERPRINT_SEED = 1469598103934665603ULL;

inline constexpr std::uint64_t AppendTevProgramWord(std::uint64_t fingerprint,
                                                     std::uint32_t word)
{
  for (unsigned int byte = 0; byte < 4; ++byte)
  {
    fingerprint ^= (word >> (byte * 8)) & 0xff;
    fingerprint *= 1099511628211ULL;
  }
  return fingerprint;
}

inline std::uint64_t SampleMask(Phase phase)
{
  // Triangle traversal is coarse enough to time every 64 calls. TEV and
  // texture sampling are per-pixel, so clock reads are limited to 1/4096.
  return phase == Phase::RasterTraversal ? 63 : 4095;
}

inline std::uint32_t AdvanceCaseSampleRng(std::uint32_t state)
{
  return state * 1664525u + 1013904223u;
}

inline std::uint64_t AvoidTimedSampleCall(Phase phase, std::uint64_t call)
{
  // Timing and case samples must remain disjoint: timing starts a clock before
  // the measured call, while a case sample constructs and inserts a detailed
  // key inside that call. Move the sparse case sample one call forward if its
  // seeded schedule lands on the fixed timing phase.
  return ((call - 1) & SampleMask(phase)) == 0 ? call + 1 : call;
}

inline bool ShouldSampleCase(Phase phase, std::uint64_t call)
{
  if (phase == Phase::RasterTraversal)
    return false;
  std::uint64_t& next = phase == Phase::TevPixel ? s_local.tev_next_case_call :
                                                   s_local.texture_next_case_call;
  std::uint32_t& rng = phase == Phase::TevPixel ? s_local.tev_case_rng :
                                                  s_local.texture_case_rng;
  if (next == 0)
  {
    rng = s_case_sample_seed.load(std::memory_order_acquire) ^
          (phase == Phase::TevPixel ? 0x54455631u : 0x54455831u);
    rng = AdvanceCaseSampleRng(rng);
    next = AvoidTimedSampleCall(phase, 1 + (rng & 4095u));
  }
  if (call != next)
    return false;
  rng = AdvanceCaseSampleRng(rng);
  // A seeded 3072..5119-call stratified interval averages approximately one
  // sample per 4096 calls. Publishing the seed makes retained runs auditable,
  // while phase-specific salts start TEV and texture on distinct streams.
  next = AvoidTimedSampleCall(phase, call + 3072 + (rng & 2047u));
  return true;
}

class SampledScope
{
public:
  explicit SampledScope(Phase phase) : m_phase(phase)
  {
    const std::uint64_t state = s_profile_state.load(std::memory_order_acquire);
    if ((state & 1) == 0)
      return;
    m_epoch = ProfileEpoch(state);
    EnsureLocalEpoch(m_epoch);
    m_active = true;
    ++s_local.active_scope_depth;
    PhaseCounters& counters = LocalPhase(phase);
    ++counters.calls;
    const std::uint64_t sample_position = (counters.calls - 1) & SampleMask(phase);
    if (sample_position == 0)
    {
      m_sampled = true;
      m_started_at = Clock::now();
    }
    else if (ShouldSampleCase(phase, counters.calls))
    {
      m_case_sampled = true;
    }
  }

  ~SampledScope()
  {
    if (m_active && s_local.active_scope_depth > 0)
      --s_local.active_scope_depth;
    if (!m_sampled)
      return;
    const std::uint64_t state = s_profile_state.load(std::memory_order_acquire);
    if ((state & 1) == 0 || ProfileEpoch(state) != m_epoch)
      return;
    PhaseCounters& counters = LocalPhase(m_phase);
    ++counters.timed_samples;
    counters.sampled_total_ns += static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - m_started_at).count());
    // The software renderer may never call SWGfx::ShowImage on the browser
    // XFB route, so frame-boundary publication alone can strand these
    // thread-local counters at zero.  Flush only on sampled calls (1/64
    // raster traversals and 1/4096 pixel/texture calls) to keep the hot path
    // effectively local while making the measurements observable.
    PublishPhase(m_phase);
  }

  SampledScope(const SampledScope&) = delete;
  SampledScope& operator=(const SampledScope&) = delete;

  bool ShouldRecordCase() const
  {
    if (!m_case_sampled)
      return false;
    const std::uint64_t state = s_profile_state.load(std::memory_order_acquire);
    return (state & 1) != 0 && ProfileEpoch(state) == m_epoch;
  }

  std::uint64_t Epoch() const { return m_epoch; }

private:
  Phase m_phase;
  std::uint64_t m_epoch = 0;
  bool m_active = false;
  bool m_sampled = false;
  bool m_case_sampled = false;
  Clock::time_point m_started_at{};
};

inline void RecordTextureCase(std::uint64_t packed_key, std::uint64_t decode_work,
                              std::uint64_t expected_epoch)
{
  RecordCase(s_texture_cases, TextureCaseKey{packed_key}, decode_work, expected_epoch);
}

inline void RecordTevCase(std::uint64_t structural_key, std::uint64_t program_fingerprint,
                          std::uint64_t stage_work, std::uint64_t expected_epoch)
{
  RecordCase(s_tev_cases, TevCaseKey{structural_key, program_fingerprint}, stage_work,
             expected_epoch);
}

inline void RecordRasterCandidatePixel()
{
  // Called inside the traversal SampledScope; use its TLS activity marker to
  // avoid a second shared atomic load for every candidate pixel.
  if (s_local.active_scope_depth != 0)
    ++s_local.raster_candidate_pixels;
}

inline void RecordTevStages(std::uint64_t stages)
{
  // Called immediately after constructing the TEV SampledScope.
  if (s_local.active_scope_depth != 0)
    s_local.tev_stages += stages;
}

inline void RecordXfbGeneration(std::uint64_t elapsed_us)
{
  if (!Enabled())
    return;
  s_xfb_generation_count.fetch_add(1, std::memory_order_relaxed);
  s_xfb_generation_last_us.store(elapsed_us, std::memory_order_relaxed);
  s_xfb_generation_total_us.fetch_add(elapsed_us, std::memory_order_relaxed);
  AtomicMax(s_xfb_generation_max_us, elapsed_us);
}

inline void RecordFifoBurst(std::uint64_t previous_bytes, std::uint64_t burst_bytes)
{
  if (!PrepareLocal())
    return;
  const std::uint64_t bytes = previous_bytes + burst_bytes;
  ++s_local.fifo_burst_count;
  s_local.fifo_bytes_last = bytes;
  if (bytes > s_local.fifo_bytes_max)
    s_local.fifo_bytes_max = bytes;
  if ((s_local.fifo_burst_count & 1023) == 0)
  {
    PublishDelta(s_fifo_burst_count, s_local.fifo_burst_count,
                 s_local.fifo_burst_count_published);
    s_fifo_bytes_last.store(s_local.fifo_bytes_last, std::memory_order_relaxed);
    AtomicMax(s_fifo_bytes_max, s_local.fifo_bytes_max);
  }
}

inline void RecordFifoConsume(std::uint64_t remaining_bytes)
{
  if (!PrepareLocal())
    return;
  ++s_local.fifo_consume_count;
  s_local.fifo_bytes_last = remaining_bytes;
  if (remaining_bytes > s_local.fifo_bytes_max)
    s_local.fifo_bytes_max = remaining_bytes;

  // Age is the duration of a continuously non-empty backlog as observed by
  // the consumer. Sampling once per 1,024 consumes avoids the previous
  // ~100k clock reads/second and eliminates a racy producer timestamp.
  if (remaining_bytes == 0)
  {
    s_local.fifo_pending_observed_at_us = 0;
  }
  else if (s_local.fifo_pending_observed_at_us == 0)
  {
    s_local.fifo_pending_observed_at_us = NowMicros();
  }
  else if ((s_local.fifo_consume_count & 1023) == 0)
  {
    const std::uint64_t now_us = NowMicros();
    if (now_us >= s_local.fifo_pending_observed_at_us)
    {
      const std::uint64_t age_us = now_us - s_local.fifo_pending_observed_at_us;
      s_local.fifo_age_last_us = age_us;
      if (age_us > s_local.fifo_age_max_us)
        s_local.fifo_age_max_us = age_us;
      ++s_local.fifo_age_sample_count;
    }
  }

  if ((s_local.fifo_consume_count & 1023) == 0)
  {
    PublishDelta(s_fifo_consume_count, s_local.fifo_consume_count,
                 s_local.fifo_consume_count_published);
    s_fifo_bytes_last.store(s_local.fifo_bytes_last, std::memory_order_relaxed);
    AtomicMax(s_fifo_bytes_max, s_local.fifo_bytes_max);
    s_fifo_age_last_us.store(s_local.fifo_age_last_us, std::memory_order_relaxed);
    AtomicMax(s_fifo_age_max_us, s_local.fifo_age_max_us);
    PublishDelta(s_fifo_age_sample_count, s_local.fifo_age_sample_count,
                 s_local.fifo_age_sample_count_published);
  }
}

inline void RecordFifoDistanceUnderflow()
{
  if (Enabled())
    s_fifo_distance_underflow_count.fetch_add(1, std::memory_order_relaxed);
}

inline void PublishGeneratedFrame()
{
  if (!PrepareLocal())
    return;
  PublishPhase(Phase::RasterTraversal);
  PublishPhase(Phase::TevPixel);
  PublishPhase(Phase::TextureSample);
  const std::uint64_t now_us = NowMicros();
  ++s_local.frame_generation_count;
  if (s_local.last_frame_at_us != 0)
  {
    const std::uint64_t interval_us = now_us - s_local.last_frame_at_us;
    s_local.frame_interval_last_us = interval_us;
    s_local.frame_interval_total_us += interval_us;
    ++s_local.frame_interval_count;
    if (interval_us > s_local.frame_interval_max_us)
      s_local.frame_interval_max_us = interval_us;
  }
  s_local.last_frame_at_us = now_us;

  s_frame_generation_count.fetch_add(1, std::memory_order_relaxed);
  s_frame_interval_last_us.store(s_local.frame_interval_last_us, std::memory_order_relaxed);
  if (s_local.frame_interval_count != 0)
  {
    s_frame_interval_total_us.fetch_add(s_local.frame_interval_last_us,
                                        std::memory_order_relaxed);
    s_frame_interval_count.fetch_add(1, std::memory_order_relaxed);
    AtomicMax(s_frame_interval_max_us, s_local.frame_interval_last_us);
  }
}

inline Snapshot Capture()
{
  Snapshot snapshot;
  snapshot.enabled = Enabled();
  snapshot.case_sample_seed =
      snapshot.enabled ? s_case_sample_seed.load(std::memory_order_acquire) : 0;
  snapshot.raster = {s_raster_calls.load(std::memory_order_relaxed),
                     s_raster_timed_samples.load(std::memory_order_relaxed),
                     s_raster_sampled_total_us.load(std::memory_order_relaxed)};
  snapshot.tev = {s_tev_calls.load(std::memory_order_relaxed),
                  s_tev_timed_samples.load(std::memory_order_relaxed),
                  s_tev_sampled_total_us.load(std::memory_order_relaxed)};
  snapshot.texture = {s_texture_calls.load(std::memory_order_relaxed),
                      s_texture_timed_samples.load(std::memory_order_relaxed),
                      s_texture_sampled_total_us.load(std::memory_order_relaxed)};
  snapshot.texture_cases = CaptureCaseTable(s_texture_cases);
  snapshot.tev_cases = CaptureCaseTable(s_tev_cases);
  snapshot.raster_candidate_pixels = s_raster_candidate_pixels.load(std::memory_order_relaxed);
  snapshot.tev_stages = s_tev_stages.load(std::memory_order_relaxed);
  snapshot.fifo_burst_count = s_fifo_burst_count.load(std::memory_order_relaxed);
  snapshot.fifo_consume_count = s_fifo_consume_count.load(std::memory_order_relaxed);
  snapshot.fifo_bytes_last = s_fifo_bytes_last.load(std::memory_order_relaxed);
  snapshot.fifo_bytes_max = s_fifo_bytes_max.load(std::memory_order_relaxed);
  snapshot.fifo_age_last_us = s_fifo_age_last_us.load(std::memory_order_relaxed);
  snapshot.fifo_age_max_us = s_fifo_age_max_us.load(std::memory_order_relaxed);
  snapshot.fifo_age_sample_count = s_fifo_age_sample_count.load(std::memory_order_relaxed);
  snapshot.fifo_distance_underflow_count =
      s_fifo_distance_underflow_count.load(std::memory_order_relaxed);
  snapshot.xfb_generation_count = s_xfb_generation_count.load(std::memory_order_relaxed);
  snapshot.xfb_generation_last_us = s_xfb_generation_last_us.load(std::memory_order_relaxed);
  snapshot.xfb_generation_total_us = s_xfb_generation_total_us.load(std::memory_order_relaxed);
  snapshot.xfb_generation_max_us = s_xfb_generation_max_us.load(std::memory_order_relaxed);
  snapshot.frame_generation_count = s_frame_generation_count.load(std::memory_order_relaxed);
  snapshot.frame_interval_last_us = s_frame_interval_last_us.load(std::memory_order_relaxed);
  snapshot.frame_interval_total_us = s_frame_interval_total_us.load(std::memory_order_relaxed);
  snapshot.frame_interval_max_us = s_frame_interval_max_us.load(std::memory_order_relaxed);
  snapshot.frame_interval_count = s_frame_interval_count.load(std::memory_order_relaxed);
  return snapshot;
}
}  // namespace DolphinWeb::RasterProfile
