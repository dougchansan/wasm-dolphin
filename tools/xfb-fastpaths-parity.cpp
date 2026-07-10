// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <random>
#include <vector>

#include "../core/upstream/dolphin_web_xfb_fastpaths.h"

namespace
{
using DolphinWeb::XfbFastPaths::DECODE_IDENTITY;
using DolphinWeb::XfbFastPaths::REUSE_ENCODED_ROWS;

#define CHECK(expression)                                                                       \
  do                                                                                            \
  {                                                                                             \
    if (!(expression))                                                                          \
    {                                                                                           \
      std::cerr << "CHECK failed at " << __FILE__ << ':' << __LINE__ << ": " #expression       \
                << '\n';                                                                        \
      std::abort();                                                                             \
    }                                                                                           \
  } while (false)

std::uint8_t ReferenceClamp(int value)
{
  if (value <= 0)
    return 0;
  if (value >= 255)
    return 255;
  return static_cast<std::uint8_t>(value);
}

std::uint32_t ReferenceYuvToRgba(std::uint8_t y, std::uint8_t u, std::uint8_t v)
{
  const int c = static_cast<int>(y) - 16;
  const int d = static_cast<int>(u) - 128;
  const int e = static_cast<int>(v) - 128;
  const std::uint8_t r = ReferenceClamp((298 * c + 409 * e + 128) >> 8);
  const std::uint8_t g = ReferenceClamp((298 * c - 100 * d - 208 * e + 128) >> 8);
  const std::uint8_t b = ReferenceClamp((298 * c + 516 * d + 128) >> 8);
  return 0xff000000u | (static_cast<std::uint32_t>(b) << 16) |
         (static_cast<std::uint32_t>(g) << 8) | static_cast<std::uint32_t>(r);
}

void ReferenceDecodeIdentity(std::uint32_t* destination, const std::uint8_t* xfb,
                             std::uint32_t width, std::uint32_t stride,
                             std::uint32_t height)
{
  for (std::uint32_t y = 0; y < height; ++y)
  {
    const std::uint8_t* row = xfb + static_cast<std::size_t>(y) * stride;
    for (std::uint32_t x = 0; x < width; ++x)
    {
      const std::uint32_t pair_x = std::min(x & ~1u, width - 2);
      const std::uint8_t* pair = row + static_cast<std::size_t>(pair_x) * 2;
      const std::uint8_t luma = (x & 1u) ? pair[2] : pair[0];
      destination[static_cast<std::size_t>(y) * width + x] =
          ReferenceYuvToRgba(luma, pair[1], pair[3]);
    }
  }
}

void CheckGoldenColors()
{
  CHECK(DolphinWeb::XfbFastPaths::YuvToRgba(16, 128, 128) == 0xff000000u);
  CHECK(DolphinWeb::XfbFastPaths::YuvToRgba(235, 128, 128) == 0xffffffffu);
}

void CheckExhaustiveEdgeColors()
{
  constexpr std::array<std::uint8_t, 13> edges = {
      0, 1, 15, 16, 17, 127, 128, 129, 235, 239, 240, 254, 255};
  std::array<std::uint8_t, 4> xfb{};
  std::array<std::uint32_t, 2> actual{};
  std::array<std::uint32_t, 2> expected{};

  for (const std::uint8_t y0 : edges)
  {
    for (const std::uint8_t u : edges)
    {
      for (const std::uint8_t y1 : edges)
      {
        for (const std::uint8_t v : edges)
        {
          xfb = {y0, u, y1, v};
          ReferenceDecodeIdentity(expected.data(), xfb.data(), 2, 4, 1);
          const bool used = DolphinWeb::XfbFastPaths::DecodeIdentityYuyvToRgba(
              DECODE_IDENTITY, actual.data(), xfb.data(), 2, 4, 1);
          CHECK(used);
          CHECK(actual == expected);
        }
      }
    }
  }
}

void CheckDecodeDimensions()
{
  constexpr std::array<std::uint32_t, 8> widths = {2, 4, 6, 16, 318, 320, 640, 720};
  constexpr std::array<std::uint32_t, 7> heights = {1, 2, 3, 17, 240, 480, 576};
  constexpr std::array<std::uint32_t, 3> padding = {0, 2, 16};
  std::mt19937 random(0x584642u);

  for (const std::uint32_t width : widths)
  {
    for (const std::uint32_t height : heights)
    {
      for (const std::uint32_t extra : padding)
      {
        const std::uint32_t stride = width * 2 + extra;
        std::vector<std::uint8_t> xfb(static_cast<std::size_t>(stride) * height);
        for (std::uint8_t& value : xfb)
          value = static_cast<std::uint8_t>(random());

        std::vector<std::uint32_t> expected(static_cast<std::size_t>(width) * height);
        std::vector<std::uint32_t> actual(expected.size(), 0x5a5a5a5au);
        ReferenceDecodeIdentity(expected.data(), xfb.data(), width, stride, height);
        CHECK(DolphinWeb::XfbFastPaths::DecodeIdentityYuyvToRgba(
            DECODE_IDENTITY, actual.data(), xfb.data(), width, stride, height));
        CHECK(actual == expected);

        std::fill(actual.begin(), actual.end(), 0x5a5a5a5au);
        CHECK(!DolphinWeb::XfbFastPaths::DecodeIdentityYuyvToRgba(
            0, actual.data(), xfb.data(), width, stride, height));
        CHECK(std::all_of(actual.begin(), actual.end(),
                           [](std::uint32_t value) { return value == 0x5a5a5a5au; }));
      }
    }
  }

  std::array<std::uint8_t, 12> odd_xfb{};
  std::array<std::uint32_t, 3> odd_destination{};
  CHECK(!DolphinWeb::XfbFastPaths::DecodeIdentityYuyvToRgba(
      DECODE_IDENTITY, odd_destination.data(), odd_xfb.data(), 3, 6, 1));
}

std::vector<std::uint8_t> EncodedRow(int source_y, int width)
{
  std::vector<std::uint8_t> row(static_cast<std::size_t>(width) * 2);
  for (int x = 0; x < width; ++x)
  {
    row[static_cast<std::size_t>(x) * 2] =
        static_cast<std::uint8_t>((source_y * 37 + x * 13) & 0xff);
    row[static_cast<std::size_t>(x) * 2 + 1] =
        static_cast<std::uint8_t>((source_y * 17 + x * 29 + 7) & 0xff);
  }
  return row;
}

void CheckRowReuseDimensions()
{
  constexpr std::array<int, 8> widths = {1, 2, 3, 4, 17, 639, 640, 720};
  constexpr std::array<int, 9> source_heights = {1, 2, 3, 4, 17, 239, 480, 527, 528};
  constexpr std::array<int, 10> destination_heights = {1, 2, 3, 4, 9, 120, 240, 360, 480, 576};
  constexpr std::array<int, 6> tops = {-4, -1, 0, 1, 527, 532};

  for (const int width : widths)
  {
    for (const int source_height : source_heights)
    {
      for (const int destination_height : destination_heights)
      {
        for (const int top : tops)
        {
          std::vector<std::uint8_t> expected(
              static_cast<std::size_t>(width) * 2 * destination_height);
          std::vector<std::uint8_t> actual(expected.size());
          int previous_source_y = -1;
          std::size_t reused = 0;

          for (int destination_y = 0; destination_y < destination_height; ++destination_y)
          {
            const int source_y = DolphinWeb::XfbFastPaths::FastEncodeSourceRow(
                destination_y, source_height, destination_height, top, 528, 1);
            const auto encoded = EncodedRow(source_y, width);
            std::uint8_t* expected_row = expected.data() +
                static_cast<std::size_t>(destination_y) * width * 2;
            std::memcpy(expected_row, encoded.data(), encoded.size());

            std::uint8_t* actual_row = actual.data() +
                static_cast<std::size_t>(destination_y) * width * 2;
            if (destination_y > 0 && DolphinWeb::XfbFastPaths::ShouldReuseEncodedRow(
                                         REUSE_ENCODED_ROWS, source_y, previous_source_y))
            {
              std::memcpy(actual_row, actual_row - width * 2, static_cast<std::size_t>(width) * 2);
              ++reused;
            }
            else
            {
              std::memcpy(actual_row, encoded.data(), encoded.size());
            }
            previous_source_y = source_y;
          }

          CHECK(actual == expected);
          CHECK(!DolphinWeb::XfbFastPaths::ShouldReuseEncodedRow(0, 4, 4));
          if (source_height == 480 && destination_height == 480 && top == 0)
            CHECK(reused == 240);
        }
      }
    }
  }
}
}  // namespace

int main()
{
  CheckGoldenColors();
  CheckExhaustiveEdgeColors();
  CheckDecodeDimensions();
  CheckRowReuseDimensions();
  std::cerr << "xfb fast-path parity: PASS\n";
  return 0;
}
