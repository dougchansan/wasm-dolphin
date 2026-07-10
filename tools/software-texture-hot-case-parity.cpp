// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <random>
#include <span>
#include <vector>

#include "VideoBackends/Software/TextureSamplerHotCase.h"
#include "Common/MsgHandler.h"
#include "VideoCommon/TextureDecoder.h"

#ifdef TEXTURE_HOT_CASE_PARITY_STANDALONE
namespace Common
{
bool MsgAlertFmtImpl(bool, MsgType, Log::LogType, const char*, int, fmt::string_view,
                     const fmt::format_args&)
{
  std::fputs("unexpected texture-decoder alert during parity test\n", stderr);
  return false;
}
}  // namespace Common
#endif

namespace
{
using TextureSampler::HotCase::I4LinearCaseState;

constexpr bool IsMeasuredI4Key(u64 key)
{
  for (const u64 measured : TextureSampler::HotCase::MEASURED_I4_LINEAR_CASE_KEYS)
  {
    if (key == measured)
      return true;
  }
  return false;
}

constexpr u64 PackI4CaseKey(const I4LinearCaseState& state)
{
  const u32 decode_work = state.linear ? 4u : 1u;
  return (static_cast<u64>(state.texture_format) & 0xf) |
         (static_cast<u64>(state.linear) << 4) |
         ((static_cast<u64>(state.mipmap_filter) & 0x3) << 5) |
         ((static_cast<u64>(state.mip) & 0x1f) << 7) |
         ((static_cast<u64>(state.wrap_s) & 0x3) << 13) |
         ((static_cast<u64>(state.wrap_t) & 0x3) << 15) |
         (static_cast<u64>(state.manually_managed) << 17) |
         ((static_cast<u64>(state.tlut_format) & 0x3) << 18) |
         (static_cast<u64>(state.width_power_of_two) << 20) |
         (static_cast<u64>(state.height_power_of_two) << 21) |
         ((static_cast<u64>(decode_work) & 0xf) << 22) |
         ((static_cast<u64>(state.min_filter) & 0x1) << 26) |
         ((static_cast<u64>(state.mag_filter) & 0x1) << 27);
}

constexpr I4LinearCaseState DecodeI4CaseKey(u64 key)
{
  return {
      static_cast<TextureFormat>(key & 0xf),
      ((key >> 4) & 1) != 0,
      static_cast<s32>((key >> 7) & 0x1f),
      static_cast<u32>((key >> 5) & 0x3),
      static_cast<u32>((key >> 13) & 0x3),
      static_cast<u32>((key >> 15) & 0x3),
      ((key >> 17) & 1) != 0,
      static_cast<TLUTFormat>((key >> 18) & 0x3),
      ((key >> 20) & 1) != 0,
      ((key >> 21) & 1) != 0,
      static_cast<u32>((key >> 26) & 1),
      static_cast<u32>((key >> 27) & 1),
  };
}

constexpr bool IsPowerOfTwo(int value)
{
  return value > 0 && (value & (value - 1)) == 0;
}

void WrapCoord(int* coordinate, u32 wrap_mode, int image_size)
{
  switch (wrap_mode)
  {
  case 0:
    *coordinate = std::clamp(*coordinate, 0, image_size - 1);
    return;
  case 1:
    *coordinate &= image_size - 1;
    return;
  case 2:
    if ((*coordinate & image_size) != 0)
      *coordinate = ~*coordinate;
    *coordinate &= image_size - 1;
    return;
  default:
    *coordinate = std::clamp(*coordinate, 0, image_size - 1);
    return;
  }
}

void ReferenceSample(std::span<const u8> source, int image_width_minus_1,
                     int image_height_minus_1, std::span<const u8> palette,
                     TLUTFormat tlut_format, s32 s, s32 t, u8* sample)
{
  s -= 64;
  t -= 64;
  int image_s = s >> 7;
  int image_t = t >> 7;
  int image_s_plus_1 = image_s + 1;
  int image_t_plus_1 = image_t + 1;
  const u32 fract_s = static_cast<u32>(s & 0x7f);
  const u32 fract_t = static_cast<u32>(t & 0x7f);
  image_s &= image_width_minus_1;
  image_s_plus_1 &= image_width_minus_1;
  image_t &= image_height_minus_1;
  image_t_plus_1 &= image_height_minus_1;

  std::array<std::array<u8, 4>, 4> texels{};
  TexDecoder_DecodeTexel(texels[0].data(), source, image_s, image_t, image_width_minus_1,
                         TextureFormat::CMPR, palette, tlut_format);
  TexDecoder_DecodeTexel(texels[1].data(), source, image_s_plus_1, image_t,
                         image_width_minus_1, TextureFormat::CMPR, palette, tlut_format);
  TexDecoder_DecodeTexel(texels[2].data(), source, image_s, image_t_plus_1,
                         image_width_minus_1, TextureFormat::CMPR, palette, tlut_format);
  TexDecoder_DecodeTexel(texels[3].data(), source, image_s_plus_1, image_t_plus_1,
                         image_width_minus_1, TextureFormat::CMPR, palette, tlut_format);
  const u32 weights[4] = {
      (128 - fract_s) * (128 - fract_t), fract_s * (128 - fract_t),
      (128 - fract_s) * fract_t, fract_s * fract_t};

  for (unsigned int channel = 0; channel < 4; ++channel)
  {
    u32 value = texels[0][channel] * weights[0];
    value += texels[1][channel] * weights[1];
    value += texels[2][channel] * weights[2];
    value += texels[3][channel] * weights[3];
    sample[channel] = static_cast<u8>(value >> 14);
  }
}

bool CheckSample(std::span<const u8> source, int width, int height,
                 std::span<const u8> palette, TLUTFormat tlut_format, s32 s, s32 t,
                 std::uint64_t* checked)
{
  std::array<u8, 4> expected{};
  std::array<u8, 4> actual{};
  ReferenceSample(source, width - 1, height - 1, palette, tlut_format, s, t, expected.data());
  TextureSampler::HotCase::SampleCmprLinearRepeatPow2(source, width - 1, height - 1, s, t,
                                                       actual.data());
  ++*checked;
  if (expected == actual)
    return true;

  std::fprintf(stderr,
               "mismatch width=%d height=%d s=%d t=%d source=%zu expected=%02x%02x%02x%02x "
               "actual=%02x%02x%02x%02x\n",
               width, height, s, t, source.size(), expected[0], expected[1], expected[2],
               expected[3], actual[0], actual[1], actual[2], actual[3]);
  return false;
}

void ReferenceI4Sample(std::span<const u8> source, int image_width_minus_1,
                       int image_height_minus_1, std::span<const u8> palette,
                       const I4LinearCaseState& state, s32 s, s32 t, u8* sample)
{
  s -= 64;
  t -= 64;
  int image_s = s >> 7;
  int image_t = t >> 7;
  int image_s_plus_1 = image_s + 1;
  int image_t_plus_1 = image_t + 1;
  const u32 fract_s = static_cast<u32>(s & 0x7f);
  const u32 fract_t = static_cast<u32>(t & 0x7f);
  WrapCoord(&image_s, state.wrap_s, image_width_minus_1 + 1);
  WrapCoord(&image_t, state.wrap_t, image_height_minus_1 + 1);
  WrapCoord(&image_s_plus_1, state.wrap_s, image_width_minus_1 + 1);
  WrapCoord(&image_t_plus_1, state.wrap_t, image_height_minus_1 + 1);

  std::array<std::array<u8, 4>, 4> texels{};
  TexDecoder_DecodeTexel(texels[0].data(), source, image_s, image_t, image_width_minus_1,
                         TextureFormat::I4, palette, state.tlut_format);
  TexDecoder_DecodeTexel(texels[1].data(), source, image_s_plus_1, image_t,
                         image_width_minus_1, TextureFormat::I4, palette, state.tlut_format);
  TexDecoder_DecodeTexel(texels[2].data(), source, image_s, image_t_plus_1,
                         image_width_minus_1, TextureFormat::I4, palette, state.tlut_format);
  TexDecoder_DecodeTexel(texels[3].data(), source, image_s_plus_1, image_t_plus_1,
                         image_width_minus_1, TextureFormat::I4, palette, state.tlut_format);
  const u32 weights[4] = {
      (128 - fract_s) * (128 - fract_t),
      fract_s * (128 - fract_t),
      (128 - fract_s) * fract_t,
      fract_s * fract_t,
  };

  for (unsigned int channel = 0; channel < 4; ++channel)
  {
    u32 value = texels[0][channel] * weights[0];
    value += texels[1][channel] * weights[1];
    value += texels[2][channel] * weights[2];
    value += texels[3][channel] * weights[3];
    sample[channel] = static_cast<u8>(value >> 14);
  }
}

void SpecializedI4Sample(std::span<const u8> source, int image_width_minus_1,
                         int image_height_minus_1, const I4LinearCaseState& state, s32 s,
                         s32 t, u8* sample)
{
  s -= 64;
  t -= 64;
  int image_s = s >> 7;
  int image_t = t >> 7;
  int image_s_plus_1 = image_s + 1;
  int image_t_plus_1 = image_t + 1;
  const u32 fract_s = static_cast<u32>(s & 0x7f);
  const u32 fract_t = static_cast<u32>(t & 0x7f);
  WrapCoord(&image_s, state.wrap_s, image_width_minus_1 + 1);
  WrapCoord(&image_t, state.wrap_t, image_height_minus_1 + 1);
  WrapCoord(&image_s_plus_1, state.wrap_s, image_width_minus_1 + 1);
  WrapCoord(&image_t_plus_1, state.wrap_t, image_height_minus_1 + 1);
  TextureSampler::HotCase::SampleI4LinearCanonical(
      source, image_width_minus_1, image_s, image_t, image_s_plus_1, image_t_plus_1,
      fract_s, fract_t, sample);
}

bool CheckI4Sample(u64 key, const I4LinearCaseState& state, std::span<const u8> source,
                   int width, int height, std::span<const u8> palette, s32 s, s32 t,
                   std::uint64_t* checked)
{
  std::array<u8, 4> expected{};
  std::array<u8, 4> actual{};
  ReferenceI4Sample(source, width - 1, height - 1, palette, state, s, t, expected.data());
  SpecializedI4Sample(source, width - 1, height - 1, state, s, t, actual.data());
  ++*checked;
  if (expected == actual)
    return true;

  std::fprintf(stderr,
               "I4 mismatch key=0x%llx width=%d height=%d s=%d t=%d source=%zu "
               "expected=%02x%02x%02x%02x actual=%02x%02x%02x%02x\n",
               static_cast<unsigned long long>(key), width, height, s, t, source.size(),
               expected[0], expected[1], expected[2], expected[3], actual[0], actual[1],
               actual[2], actual[3]);
  return false;
}

std::size_t EncodedSize(int width, int height)
{
  return static_cast<std::size_t>((width + 7) / 8) * static_cast<std::size_t>((height + 7) / 8) *
         32;
}

bool CheckI4DispatchPredicate(std::uint64_t* checked)
{
  for (const u64 key : TextureSampler::HotCase::MEASURED_I4_LINEAR_CASE_KEYS)
  {
    const I4LinearCaseState state = DecodeI4CaseKey(key);
    ++*checked;
    if (PackI4CaseKey(state) != key ||
        !TextureSampler::HotCase::IsMeasuredI4LinearCase(state))
    {
      std::fprintf(stderr, "I4 dispatch rejected measured key 0x%llx\n",
                   static_cast<unsigned long long>(key));
      return false;
    }
  }

  for (u32 format = 0; format < 16; ++format)
  {
    for (u32 linear = 0; linear < 2; ++linear)
    {
      for (u32 mipmap_filter = 0; mipmap_filter < 4; ++mipmap_filter)
      {
        for (u32 mip = 0; mip < 32; ++mip)
        {
          for (u32 wrap_s = 0; wrap_s < 4; ++wrap_s)
          {
            for (u32 wrap_t = 0; wrap_t < 4; ++wrap_t)
            {
              for (u32 manually_managed = 0; manually_managed < 2; ++manually_managed)
              {
                for (u32 tlut_format = 0; tlut_format < 4; ++tlut_format)
                {
                  for (u32 power_flags = 0; power_flags < 4; ++power_flags)
                  {
                    for (u32 filter_flags = 0; filter_flags < 4; ++filter_flags)
                    {
                      const I4LinearCaseState state = {
                          static_cast<TextureFormat>(format),
                          linear != 0,
                          static_cast<s32>(mip),
                          mipmap_filter,
                          wrap_s,
                          wrap_t,
                          manually_managed != 0,
                          static_cast<TLUTFormat>(tlut_format),
                          (power_flags & 1) != 0,
                          (power_flags & 2) != 0,
                          filter_flags & 1,
                          (filter_flags >> 1) & 1,
                      };
                      const bool expected = IsMeasuredI4Key(PackI4CaseKey(state));
                      const bool actual =
                          TextureSampler::HotCase::IsMeasuredI4LinearCase(state);
                      ++*checked;
                      if (expected != actual)
                      {
                        std::fprintf(stderr,
                                     "I4 dispatch mismatch key=0x%llx expected=%d actual=%d\n",
                                     static_cast<unsigned long long>(PackI4CaseKey(state)),
                                     expected, actual);
                        return false;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  I4LinearCaseState invalid = DecodeI4CaseKey(
      TextureSampler::HotCase::MEASURED_I4_LINEAR_CASE_KEYS.front());
  for (const auto mutate : {
           +[](I4LinearCaseState& state) { state.mip = -1; },
           +[](I4LinearCaseState& state) { state.mip = 32; },
           +[](I4LinearCaseState& state) { state.mipmap_filter = 4; },
           +[](I4LinearCaseState& state) { state.wrap_s = 4; },
           +[](I4LinearCaseState& state) { state.min_filter = 2; },
           +[](I4LinearCaseState& state) { state.mag_filter = 2; },
       })
  {
    invalid = DecodeI4CaseKey(TextureSampler::HotCase::MEASURED_I4_LINEAR_CASE_KEYS.front());
    mutate(invalid);
    ++*checked;
    if (TextureSampler::HotCase::IsMeasuredI4LinearCase(invalid))
    {
      std::fputs("I4 dispatch accepted an out-of-range state\n", stderr);
      return false;
    }
  }
  return true;
}
}  // namespace

int main()
{
  constexpr std::uint32_t seed = 0x5a17c0de;
  std::mt19937 rng(seed);
  std::uniform_int_distribution<int> byte_distribution(0, 255);
  std::uint64_t cmpr_checked = 0;
  std::uint64_t i4_checked = 0;
  std::uint64_t dispatch_checked = 0;

  if (!CheckI4DispatchPredicate(&dispatch_checked))
    return 1;

  // TLUT formats 1 and 2 distinguish the two measured keys. CMPR ignores palette state, but keep
  // randomized palette bytes in each pass to make that invariance explicit in the test matrix.
  for (const TLUTFormat tlut_format : {TLUTFormat::RGB565, TLUTFormat::RGB5A3})
  {
    std::vector<u8> palette(32768);
    for (u8& byte : palette)
      byte = static_cast<u8>(byte_distribution(rng));

    for (const auto [width, height] :
         {std::array{1, 1}, std::array{2, 4}, std::array{4, 2}, std::array{8, 8},
          std::array{16, 8}, std::array{32, 16}, std::array{64, 64}})
    {
      std::vector<u8> texture(EncodedSize(width, height));
      for (u8& byte : texture)
        byte = static_cast<u8>(byte_distribution(rng));

      const std::array<std::size_t, 6> span_sizes = {
          0, 1, 7, 8, texture.empty() ? 0 : texture.size() - 1, texture.size()};
      for (const std::size_t span_size : span_sizes)
      {
        const std::span<const u8> source(texture.data(), span_size);
        for (const int texel_s : {-2, -1, 0, width - 1, width, width + 1, width * 2})
        {
          for (const int texel_t : {-2, -1, 0, height - 1, height, height + 1, height * 2})
          {
            for (const int fract_s : {0, 1, 63, 64, 127})
            {
              for (const int fract_t : {0, 1, 63, 64, 127})
              {
                const s32 s = texel_s * 128 + 64 + fract_s;
                const s32 t = texel_t * 128 + 64 + fract_t;
                if (!CheckSample(source, width, height, palette, tlut_format, s, t,
                                 &cmpr_checked))
                  return 1;
              }
            }
          }
        }
      }

      // Exhaust every bilinear fraction at the wrap boundary, where all four CMPR sub-block
      // layouts and repeat transitions are exercised.
      const std::span<const u8> source(texture);
      for (int fract_s = 0; fract_s < 128; ++fract_s)
      {
        for (int fract_t = 0; fract_t < 128; ++fract_t)
        {
          const s32 s = (width - 1) * 128 + 64 + fract_s;
          const s32 t = (height - 1) * 128 + 64 + fract_t;
          if (!CheckSample(source, width, height, palette, tlut_format, s, t,
                           &cmpr_checked))
            return 1;
        }
      }

      // Mutating otherwise-unused palette bytes must not affect CMPR output for either observed
      // TLUT-format key.
      palette[(tlut_format == TLUTFormat::RGB565 ? 1u : 2u) * 4096] ^= 0xff;
    }
  }

  std::uniform_int_distribution<int> power_distribution(0, 7);
  std::uniform_int_distribution<int> coordinate_distribution(-262144, 262143);
  std::vector<u8> random_palette(32768);
  for (u8& byte : random_palette)
    byte = static_cast<u8>(byte_distribution(rng));
  for (int trial = 0; trial < 64; ++trial)
  {
    const int width = 1 << power_distribution(rng);
    const int height = 1 << power_distribution(rng);
    std::vector<u8> texture(EncodedSize(width, height));
    for (u8& byte : texture)
      byte = static_cast<u8>(byte_distribution(rng));
    for (int sample = 0; sample < 2048; ++sample)
    {
      const TLUTFormat tlut_format =
          (sample & 1) == 0 ? TLUTFormat::RGB565 : TLUTFormat::RGB5A3;
      if (!CheckSample(texture, width, height, random_palette, tlut_format,
                       coordinate_distribution(rng), coordinate_distribution(rng),
                       &cmpr_checked))
      {
        return 1;
      }
    }
  }

  for (const u64 key : TextureSampler::HotCase::MEASURED_I4_LINEAR_CASE_KEYS)
  {
    const I4LinearCaseState state = DecodeI4CaseKey(key);
    std::vector<std::array<int, 2>> dimensions;
    if (state.width_power_of_two && state.height_power_of_two)
    {
      dimensions = {{1, 1}, {2, 4}, {8, 8}, {16, 32}, {64, 16}};
    }
    else if (!state.width_power_of_two && !state.height_power_of_two)
    {
      dimensions = {{3, 5}, {7, 9}, {10, 13}};
    }
    else if (!state.width_power_of_two && state.height_power_of_two)
    {
      dimensions = {{3, 4}, {7, 8}, {10, 16}};
    }
    else
    {
      std::fprintf(stderr, "I4 key 0x%llx has an untested dimension class\n",
                   static_cast<unsigned long long>(key));
      return 1;
    }

    for (const auto [width, height] : dimensions)
    {
      if (IsPowerOfTwo(width) != state.width_power_of_two ||
          IsPowerOfTwo(height) != state.height_power_of_two)
      {
        std::fprintf(stderr, "I4 dimension class mismatch for key 0x%llx (%dx%d)\n",
                     static_cast<unsigned long long>(key), width, height);
        return 1;
      }

      std::vector<u8> texture(EncodedSize(width, height));
      for (u8& byte : texture)
        byte = static_cast<u8>(byte_distribution(rng));

      const std::array<std::size_t, 7> span_sizes = {
          0,
          std::min<std::size_t>(1, texture.size()),
          std::min<std::size_t>(7, texture.size()),
          std::min<std::size_t>(31, texture.size()),
          std::min<std::size_t>(32, texture.size()),
          texture.empty() ? 0 : texture.size() - 1,
          texture.size(),
      };
      for (const std::size_t span_size : span_sizes)
      {
        const std::span<const u8> source(texture.data(), span_size);
        for (const int texel_s : {-2, -1, 0, width - 1, width, width + 1, width * 2})
        {
          for (const int texel_t : {-2, -1, 0, height - 1, height, height + 1, height * 2})
          {
            for (const int fract_s : {0, 1, 63, 64, 127})
            {
              for (const int fract_t : {0, 1, 63, 64, 127})
              {
                const s32 s = texel_s * 128 + 64 + fract_s;
                const s32 t = texel_t * 128 + 64 + fract_t;
                if (!CheckI4Sample(key, state, source, width, height, random_palette, s, t,
                                   &i4_checked))
                {
                  return 1;
                }
              }
            }
          }
        }
      }

      // Exhaust every fractional pair at both the negative and positive clamp/repeat boundaries.
      for (const auto [texel_s, texel_t] :
           {std::array{-1, -1}, std::array{width - 1, height - 1}})
      {
        for (int fract_s = 0; fract_s < 128; ++fract_s)
        {
          for (int fract_t = 0; fract_t < 128; ++fract_t)
          {
            const s32 s = texel_s * 128 + 64 + fract_s;
            const s32 t = texel_t * 128 + 64 + fract_t;
            if (!CheckI4Sample(key, state, texture, width, height, random_palette, s, t,
                               &i4_checked))
            {
              return 1;
            }
          }
        }
      }

      for (int sample = 0; sample < 512; ++sample)
      {
        if (!CheckI4Sample(key, state, texture, width, height, random_palette,
                           coordinate_distribution(rng), coordinate_distribution(rng),
                           &i4_checked))
        {
          return 1;
        }
      }
    }
  }

  std::printf("software texture hot-case parity: PASS (CMPR=%llu, I4=%llu, dispatch=%llu, "
              "seed=0x%08x)\n",
              static_cast<unsigned long long>(cmpr_checked),
              static_cast<unsigned long long>(i4_checked),
              static_cast<unsigned long long>(dispatch_checked), seed);
  return 0;
}
