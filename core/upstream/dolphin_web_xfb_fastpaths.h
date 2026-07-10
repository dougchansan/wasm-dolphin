// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>

namespace DolphinWeb::XfbFastPaths
{
constexpr std::uint32_t REUSE_ENCODED_ROWS = 1u << 0;
constexpr std::uint32_t DECODE_IDENTITY = 1u << 1;
constexpr std::uint32_t ALL = REUSE_ENCODED_ROWS | DECODE_IDENTITY;

inline std::uint8_t ClampColor(int value)
{
  if (value <= 0)
    return 0;
  if (value >= 255)
    return 255;
  return static_cast<std::uint8_t>(value);
}

inline std::uint32_t YuvToRgba(std::uint8_t y, std::uint8_t u, std::uint8_t v)
{
  const int c = static_cast<int>(y) - 16;
  const int d = static_cast<int>(u) - 128;
  const int e = static_cast<int>(v) - 128;
  const std::uint8_t r = ClampColor((298 * c + 409 * e + 128) >> 8);
  const std::uint8_t g = ClampColor((298 * c - 100 * d - 208 * e + 128) >> 8);
  const std::uint8_t b = ClampColor((298 * c + 516 * d + 128) >> 8);
  return 0xff000000u | (static_cast<std::uint32_t>(b) << 16) |
         (static_cast<std::uint32_t>(g) << 8) | static_cast<std::uint32_t>(r);
}

inline int FastEncodeSourceRow(int destination_y, int source_height, int destination_height,
                               int source_top, int maximum_source_height, int encode_mode)
{
  const int scaled_y = static_cast<int>(
      (static_cast<std::int64_t>(destination_y) * source_height) / destination_height);
  int source_y = std::clamp(source_top + scaled_y, 0, maximum_source_height - 1);
  if (encode_mode > 0)
    source_y &= ~1;
  return source_y;
}

inline bool ShouldReuseEncodedRow(std::uint32_t flags, int source_y, int previous_source_y)
{
  return (flags & REUSE_ENCODED_ROWS) != 0 && source_y == previous_source_y;
}

// The generic presentation decoder must remain the fallback for scaling and odd widths. For an
// even identity-sized image, each four-byte YUYV group always produces exactly two adjacent RGBA
// pixels, so this removes only invariant coordinate math; color conversion and byte order are
// unchanged.
inline bool DecodeIdentityYuyvToRgba(std::uint32_t flags, std::uint32_t* destination,
                                     const std::uint8_t* xfb, std::uint32_t width,
                                     std::uint32_t stride, std::uint32_t height)
{
  if ((flags & DECODE_IDENTITY) == 0 || !destination || !xfb || width < 2 || (width & 1u) != 0 ||
      height == 0 || stride < width * 2)
  {
    return false;
  }

  for (std::uint32_t y = 0; y < height; ++y)
  {
    const std::uint8_t* row = xfb + static_cast<std::size_t>(y) * stride;
    std::uint32_t* output = destination + static_cast<std::size_t>(y) * width;
    for (std::uint32_t x = 0; x < width; x += 2)
    {
      const std::uint8_t* pair = row + static_cast<std::size_t>(x) * 2;
      output[x] = YuvToRgba(pair[0], pair[1], pair[3]);
      output[x + 1] = YuvToRgba(pair[2], pair[1], pair[3]);
    }
  }
  return true;
}
}  // namespace DolphinWeb::XfbFastPaths
