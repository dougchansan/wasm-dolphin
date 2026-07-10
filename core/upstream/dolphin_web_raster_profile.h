// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <atomic>
#include <chrono>
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

struct PhaseCounters
{
  std::uint64_t calls = 0;
  std::uint64_t timed_samples = 0;
  std::uint64_t sampled_total_us = 0;
};

struct LocalCounters
{
  PhaseCounters raster;
  PhaseCounters tev;
  PhaseCounters texture;
  std::uint64_t raster_candidate_pixels = 0;
  std::uint64_t tev_stages = 0;
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
  PhaseCounters raster;
  PhaseCounters tev;
  PhaseCounters texture;
  std::uint64_t raster_candidate_pixels = 0;
  std::uint64_t tev_stages = 0;
  std::uint64_t fifo_burst_count = 0;
  std::uint64_t fifo_consume_count = 0;
  std::uint64_t fifo_bytes_last = 0;
  std::uint64_t fifo_bytes_max = 0;
  std::uint64_t fifo_age_last_us = 0;
  std::uint64_t fifo_age_max_us = 0;
  std::uint64_t fifo_age_sample_count = 0;
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

inline bool s_enabled = false;
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
inline std::atomic<std::uint64_t> s_fifo_burst_count{0};
inline std::atomic<std::uint64_t> s_fifo_consume_count{0};
inline std::atomic<std::uint64_t> s_fifo_bytes_last{0};
inline std::atomic<std::uint64_t> s_fifo_bytes_max{0};
inline std::atomic<std::uint64_t> s_fifo_first_pending_at_us{0};
inline std::atomic<std::uint64_t> s_fifo_age_last_us{0};
inline std::atomic<std::uint64_t> s_fifo_age_max_us{0};
inline std::atomic<std::uint64_t> s_fifo_age_sample_count{0};
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
  return s_enabled;
}

inline void ResetPublished()
{
  for (std::atomic<std::uint64_t>* counter : {
           &s_raster_calls, &s_raster_timed_samples, &s_raster_sampled_total_us,
           &s_raster_candidate_pixels, &s_tev_calls, &s_tev_stages, &s_tev_timed_samples,
           &s_tev_sampled_total_us, &s_texture_calls, &s_texture_timed_samples,
           &s_texture_sampled_total_us, &s_fifo_burst_count, &s_fifo_consume_count,
           &s_fifo_bytes_last, &s_fifo_bytes_max, &s_fifo_first_pending_at_us,
           &s_fifo_age_last_us, &s_fifo_age_max_us, &s_fifo_age_sample_count,
           &s_xfb_generation_count, &s_xfb_generation_last_us, &s_xfb_generation_total_us,
           &s_xfb_generation_max_us, &s_frame_generation_count, &s_frame_interval_last_us,
           &s_frame_interval_total_us, &s_frame_interval_max_us, &s_frame_interval_count})
  {
    counter->store(0, std::memory_order_relaxed);
  }
}

inline void SetEnabled(bool enabled)
{
  s_enabled = enabled;
  ResetPublished();
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

inline std::uint64_t SampleMask(Phase phase)
{
  // Triangle traversal is coarse enough to time every 64 calls. TEV and
  // texture sampling are per-pixel, so clock reads are limited to 1/4096.
  return phase == Phase::RasterTraversal ? 63 : 4095;
}

class SampledScope
{
public:
  explicit SampledScope(Phase phase) : m_phase(phase)
  {
    if (!Enabled())
      return;
    PhaseCounters& counters = LocalPhase(phase);
    ++counters.calls;
    if (((counters.calls - 1) & SampleMask(phase)) == 0)
    {
      m_sampled = true;
      m_started_at = Clock::now();
    }
  }

  ~SampledScope()
  {
    if (!m_sampled)
      return;
    PhaseCounters& counters = LocalPhase(m_phase);
    ++counters.timed_samples;
    counters.sampled_total_us += static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - m_started_at).count());
  }

  SampledScope(const SampledScope&) = delete;
  SampledScope& operator=(const SampledScope&) = delete;

private:
  Phase m_phase;
  bool m_sampled = false;
  Clock::time_point m_started_at{};
};

inline void RecordRasterCandidatePixel()
{
  if (Enabled())
    ++s_local.raster_candidate_pixels;
}

inline void RecordTevStages(std::uint64_t stages)
{
  if (Enabled())
    s_local.tev_stages += stages;
}

inline void RecordXfbGeneration(std::uint64_t elapsed_us)
{
  if (!Enabled())
    return;
  ++s_local.xfb_generation_count;
  s_local.xfb_generation_last_us = elapsed_us;
  s_local.xfb_generation_total_us += elapsed_us;
  if (elapsed_us > s_local.xfb_generation_max_us)
    s_local.xfb_generation_max_us = elapsed_us;
}

inline void RecordFifoBurst(std::uint64_t previous_bytes, std::uint64_t burst_bytes)
{
  if (!Enabled())
    return;
  const std::uint64_t bytes = previous_bytes + burst_bytes;
  s_fifo_burst_count.fetch_add(1, std::memory_order_relaxed);
  s_fifo_bytes_last.store(bytes, std::memory_order_relaxed);
  AtomicMax(s_fifo_bytes_max, bytes);
  if (previous_bytes == 0)
  {
    std::uint64_t empty = 0;
    s_fifo_first_pending_at_us.compare_exchange_strong(empty, NowMicros(),
                                                        std::memory_order_relaxed);
  }
}

inline void RecordFifoConsume(std::uint64_t remaining_bytes)
{
  if (!Enabled())
    return;
  s_fifo_consume_count.fetch_add(1, std::memory_order_relaxed);
  s_fifo_bytes_last.store(remaining_bytes, std::memory_order_relaxed);
  const std::uint64_t first_pending = s_fifo_first_pending_at_us.load(std::memory_order_relaxed);
  if (first_pending != 0)
  {
    const std::uint64_t age_us = NowMicros() - first_pending;
    s_fifo_age_last_us.store(age_us, std::memory_order_relaxed);
    AtomicMax(s_fifo_age_max_us, age_us);
    s_fifo_age_sample_count.fetch_add(1, std::memory_order_relaxed);
  }
  if (remaining_bytes == 0)
    s_fifo_first_pending_at_us.store(0, std::memory_order_relaxed);
}

inline void PublishGeneratedFrame()
{
  if (!Enabled())
    return;
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

  s_raster_calls.store(s_local.raster.calls, std::memory_order_relaxed);
  s_raster_timed_samples.store(s_local.raster.timed_samples, std::memory_order_relaxed);
  s_raster_sampled_total_us.store(s_local.raster.sampled_total_us, std::memory_order_relaxed);
  s_raster_candidate_pixels.store(s_local.raster_candidate_pixels, std::memory_order_relaxed);
  s_tev_calls.store(s_local.tev.calls, std::memory_order_relaxed);
  s_tev_stages.store(s_local.tev_stages, std::memory_order_relaxed);
  s_tev_timed_samples.store(s_local.tev.timed_samples, std::memory_order_relaxed);
  s_tev_sampled_total_us.store(s_local.tev.sampled_total_us, std::memory_order_relaxed);
  s_texture_calls.store(s_local.texture.calls, std::memory_order_relaxed);
  s_texture_timed_samples.store(s_local.texture.timed_samples, std::memory_order_relaxed);
  s_texture_sampled_total_us.store(s_local.texture.sampled_total_us, std::memory_order_relaxed);
  s_xfb_generation_count.store(s_local.xfb_generation_count, std::memory_order_relaxed);
  s_xfb_generation_last_us.store(s_local.xfb_generation_last_us, std::memory_order_relaxed);
  s_xfb_generation_total_us.store(s_local.xfb_generation_total_us, std::memory_order_relaxed);
  s_xfb_generation_max_us.store(s_local.xfb_generation_max_us, std::memory_order_relaxed);
  s_frame_generation_count.store(s_local.frame_generation_count, std::memory_order_relaxed);
  s_frame_interval_last_us.store(s_local.frame_interval_last_us, std::memory_order_relaxed);
  s_frame_interval_total_us.store(s_local.frame_interval_total_us, std::memory_order_relaxed);
  s_frame_interval_max_us.store(s_local.frame_interval_max_us, std::memory_order_relaxed);
  s_frame_interval_count.store(s_local.frame_interval_count, std::memory_order_relaxed);
}

inline Snapshot Capture()
{
  Snapshot snapshot;
  snapshot.enabled = Enabled();
  snapshot.raster = {s_raster_calls.load(std::memory_order_relaxed),
                     s_raster_timed_samples.load(std::memory_order_relaxed),
                     s_raster_sampled_total_us.load(std::memory_order_relaxed)};
  snapshot.tev = {s_tev_calls.load(std::memory_order_relaxed),
                  s_tev_timed_samples.load(std::memory_order_relaxed),
                  s_tev_sampled_total_us.load(std::memory_order_relaxed)};
  snapshot.texture = {s_texture_calls.load(std::memory_order_relaxed),
                      s_texture_timed_samples.load(std::memory_order_relaxed),
                      s_texture_sampled_total_us.load(std::memory_order_relaxed)};
  snapshot.raster_candidate_pixels = s_raster_candidate_pixels.load(std::memory_order_relaxed);
  snapshot.tev_stages = s_tev_stages.load(std::memory_order_relaxed);
  snapshot.fifo_burst_count = s_fifo_burst_count.load(std::memory_order_relaxed);
  snapshot.fifo_consume_count = s_fifo_consume_count.load(std::memory_order_relaxed);
  snapshot.fifo_bytes_last = s_fifo_bytes_last.load(std::memory_order_relaxed);
  snapshot.fifo_bytes_max = s_fifo_bytes_max.load(std::memory_order_relaxed);
  snapshot.fifo_age_last_us = s_fifo_age_last_us.load(std::memory_order_relaxed);
  snapshot.fifo_age_max_us = s_fifo_age_max_us.load(std::memory_order_relaxed);
  snapshot.fifo_age_sample_count = s_fifo_age_sample_count.load(std::memory_order_relaxed);
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
