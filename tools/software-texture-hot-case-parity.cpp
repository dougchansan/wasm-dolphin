// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <random>
#include <span>
#include <vector>

#include "VideoBackends/Software/TextureSamplerHotCase.h"
#include "VideoCommon/TextureDecoder.h"

namespace
{
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

std::size_t EncodedSize(int width, int height)
{
  return static_cast<std::size_t>((width + 7) / 8) * static_cast<std::size_t>((height + 7) / 8) *
         32;
}
}  // namespace

int main()
{
  constexpr std::uint32_t seed = 0x5a17c0de;
  std::mt19937 rng(seed);
  std::uniform_int_distribution<int> byte_distribution(0, 255);
  std::uint64_t checked = 0;

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
                if (!CheckSample(source, width, height, palette, tlut_format, s, t, &checked))
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
          if (!CheckSample(source, width, height, palette, tlut_format, s, t, &checked))
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
                       coordinate_distribution(rng), coordinate_distribution(rng), &checked))
      {
        return 1;
      }
    }
  }

  std::printf("software texture hot-case parity: PASS (%llu samples, seed=0x%08x)\n",
              static_cast<unsigned long long>(checked), seed);
  return 0;
}
