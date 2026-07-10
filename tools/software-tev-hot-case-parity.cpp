// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

#include "VideoBackends/Software/TevHotCase.h"

namespace
{
struct Color
{
  std::int16_t a = 0;
  std::int16_t b = 0;
  std::int16_t g = 0;
  std::int16_t r = 0;
};

using Registers = std::array<Color, 4>;

[[noreturn]] void Fail(const char* message, std::uint64_t index)
{
  std::fprintf(stderr, "software TEV hot-case parity: FAIL (%s at %llu)\n", message,
               static_cast<unsigned long long>(index));
  std::exit(1);
}

bool Equal(const Registers& left, const Registers& right)
{
  for (std::size_t i = 0; i < left.size(); ++i)
  {
    if (left[i].a != right[i].a || left[i].b != right[i].b || left[i].g != right[i].g ||
        left[i].r != right[i].r)
    {
      return false;
    }
  }
  return true;
}

std::int16_t GenericRegular(std::int16_t a, std::int16_t b, std::int16_t c,
                            std::int16_t d)
{
  const std::uint16_t expanded_c = static_cast<std::uint16_t>(c) +
                                   (static_cast<std::uint16_t>(c) >> 7);
  std::int32_t temp = static_cast<std::int32_t>(a) * (256 - expanded_c) +
                      static_cast<std::int32_t>(b) * expanded_c;
  temp += 128;
  temp >>= 8;
  return TevHotCase::Clamp255(static_cast<std::int32_t>(d) + temp);
}

void ReferenceEvaluate(TevHotCase::Kind kind, Registers& registers, const Color& texture,
                       const Color& raster)
{
  Color& previous = registers[0];
  switch (kind)
  {
  case TevHotCase::Kind::TextureModulateRgbRasterAlpha:
    previous.r = GenericRegular(0, raster.r, texture.r, 0);
    previous.g = GenericRegular(0, raster.g, texture.g, 0);
    previous.b = GenericRegular(0, raster.b, texture.b, 0);
    previous.a = GenericRegular(0, 0, 0, raster.a);
    return;
  case TevHotCase::Kind::PassThroughGenMode10:
  case TevHotCase::Kind::PassThroughGenMode4010:
    previous.r = GenericRegular(0, 0, 0, raster.r);
    previous.g = GenericRegular(0, 0, 0, raster.g);
    previous.b = GenericRegular(0, 0, 0, raster.b);
    previous.a = GenericRegular(0, 0, 0, raster.a);
    return;
  case TevHotCase::Kind::None:
    return;
  }
}

std::uint32_t Next(std::uint32_t& state)
{
  state = state * 1664525u + 1013904223u;
  return state;
}

Color RandomColor(std::uint32_t& state, bool byte_range)
{
  const auto component = [&] {
    const std::uint32_t value = Next(state);
    return static_cast<std::int16_t>(byte_range ? (value & 0xff) :
                                                   static_cast<std::int32_t>(value % 2048) - 1024);
  };
  return {component(), component(), component(), component()};
}

void CheckOne(TevHotCase::Kind kind, const Registers& initial, const Color& texture,
              const Color& raster, std::uint64_t index)
{
  Registers expected = initial;
  Registers actual = initial;
  ReferenceEvaluate(kind, expected, texture, raster);
  TevHotCase::Evaluate(kind, actual[0], texture, raster);
  if (!Equal(expected, actual))
    Fail("register mismatch", index);
}
}  // namespace

int main()
{
  constexpr std::array<TevHotCase::Kind, 3> kinds = {
      TevHotCase::Kind::TextureModulateRgbRasterAlpha,
      TevHotCase::Kind::PassThroughGenMode10,
      TevHotCase::Kind::PassThroughGenMode4010,
  };
  constexpr std::array<TevHotCase::ExactTuple, 3> tuples = {
      TevHotCase::TEXTURE_MODULATE_RGB_RASTER_ALPHA,
      TevHotCase::PASS_THROUGH_GENMODE_10,
      TevHotCase::PASS_THROUGH_GENMODE_4010,
  };

  for (std::size_t i = 0; i < tuples.size(); ++i)
  {
    if (TevHotCase::Classify(tuples[i]) != kinds[i])
      Fail("canonical tuple classifier", i);
    for (std::size_t word = 0; word < tuples[i].size(); ++word)
    {
      for (std::uint32_t bit = 0; bit < 32; ++bit)
      {
        auto mutated = tuples[i];
        mutated[word] ^= 1u << bit;
        // The two pass-through tuples intentionally differ by one genMode
        // bit. A mutation may therefore become the other supported tuple, but
        // it must never remain classified as the original exact program.
        if (TevHotCase::Classify(mutated) == kinds[i])
          Fail("one-bit tuple mutation retained original classification", i * 288 + word * 32 + bit);
      }
    }
  }

  constexpr std::array<std::int16_t, 6> byte_boundaries = {0, 1, 127, 128, 254, 255};
  constexpr std::array<std::int16_t, 5> register_boundaries = {-1024, -1, 0, 255, 1023};
  std::uint64_t checks = 0;
  for (TevHotCase::Kind kind : kinds)
  {
    for (std::int16_t raster_value : byte_boundaries)
    {
      for (std::int16_t texture_value : byte_boundaries)
      {
        for (std::int16_t register_value : register_boundaries)
        {
          Registers registers{};
          for (Color& value : registers)
            value = {register_value, register_value, register_value, register_value};
          const Color texture{texture_value, texture_value, texture_value, texture_value};
          const Color raster{raster_value, raster_value, raster_value, raster_value};
          CheckOne(kind, registers, texture, raster, checks++);
        }
      }
    }
  }

  constexpr std::uint64_t RANDOM_CASES = 1'200'000;
  std::uint32_t state = 0x5a17c0deu;
  for (std::uint64_t i = 0; i < RANDOM_CASES; ++i)
  {
    Registers registers{};
    for (Color& value : registers)
      value = RandomColor(state, false);
    const Color texture = RandomColor(state, true);
    const Color raster = RandomColor(state, true);
    CheckOne(kinds[i % kinds.size()], registers, texture, raster, checks++);
  }

  std::printf("software TEV hot-case parity: PASS (checks=%llu mutations=%u seed=0x%08x)\n",
              static_cast<unsigned long long>(checks), 3u * 9u * 32u, 0x5a17c0deu);
  return 0;
}
