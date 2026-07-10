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
    s_profile_state.store(disabled_state | 1, std::memory_order_release);
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
    const std::uint64_t state = s_profile_state.load(std::memory_order_acquire);
    if ((state & 1) == 0)
      return;
    m_epoch = ProfileEpoch(state);
    EnsureLocalEpoch(m_epoch);
    m_active = true;
    ++s_local.active_scope_depth;
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

private:
  Phase m_phase;
  std::uint64_t m_epoch = 0;
  bool m_active = false;
  bool m_sampled = false;
  Clock::time_point m_started_at{};
};

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
