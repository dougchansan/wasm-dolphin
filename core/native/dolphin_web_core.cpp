#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

namespace
{
constexpr int kWidth = 640;
constexpr int kHeight = 480;
constexpr std::size_t kTitleOffset = 0x20;
constexpr std::size_t kTitleLength = 0x40;

std::array<std::uint32_t, kWidth * kHeight> g_framebuffer{};
std::uint32_t g_frame = 0;
std::uint32_t g_input_mask = 0;
std::uint32_t g_saved_frame = 0;
std::uint32_t g_saved_input_mask = 0;
std::uint64_t g_disc_size = 0;
char g_game_id[8] = "NO-DISC";
char g_game_title[128] = "Native WebAssembly core";

std::uint8_t clamp_channel(std::uint32_t value)
{
  return static_cast<std::uint8_t>(value & 0xff);
}

std::uint32_t rgba(std::uint8_t red, std::uint8_t green, std::uint8_t blue)
{
  return (255u << 24u) | (static_cast<std::uint32_t>(blue) << 16u) |
         (static_cast<std::uint32_t>(green) << 8u) | red;
}

void copy_trimmed(char* destination, std::size_t destination_size, const char* source,
                  std::size_t source_size)
{
  if (destination_size == 0)
  {
    return;
  }

  std::size_t length = 0;
  while (length < source_size && source[length] != '\0')
  {
    length += 1;
  }

  while (length > 0 && static_cast<unsigned char>(source[length - 1]) <= 0x20)
  {
    length -= 1;
  }

  const std::size_t copied = length < destination_size - 1 ? length : destination_size - 1;
  std::memcpy(destination, source, copied);
  destination[copied] = '\0';
}

void set_default_disc_metadata(const char* path)
{
  std::strncpy(g_game_id, "UNKNOWN", sizeof(g_game_id) - 1);
  g_game_id[sizeof(g_game_id) - 1] = '\0';
  copy_trimmed(g_game_title, sizeof(g_game_title), path, std::strlen(path));
}

void parse_gamecube_header(FILE* file, const char* path)
{
  std::array<char, kTitleOffset + kTitleLength> header{};
  const std::size_t read = std::fread(header.data(), 1, header.size(), file);

  if (read < kTitleOffset + 1)
  {
    set_default_disc_metadata(path);
    return;
  }

  copy_trimmed(g_game_id, sizeof(g_game_id), header.data(), 6);
  copy_trimmed(g_game_title, sizeof(g_game_title), header.data() + kTitleOffset,
               read > kTitleOffset ? read - kTitleOffset : 0);

  if (g_game_title[0] == '\0')
  {
    set_default_disc_metadata(path);
  }
}

void draw_native_boot_frame()
{
  const std::uint32_t frame = g_frame;
  const std::uint32_t input = g_input_mask;
  const std::uint32_t title_hash = static_cast<std::uint8_t>(g_game_title[0]) +
                                   (static_cast<std::uint8_t>(g_game_title[1]) << 1u);

  for (int y = 0; y < kHeight; ++y)
  {
    for (int x = 0; x < kWidth; ++x)
    {
      const std::uint32_t wave = ((x ^ y) + frame + title_hash) & 0xffu;
      const std::uint8_t red = clamp_channel(x + frame + (input & 0xffu));
      const std::uint8_t green = clamp_channel(y + (frame >> 1u) + ((input >> 4u) & 0xffu));
      const std::uint8_t blue = clamp_channel(wave + ((input >> 8u) & 0xffu));
      g_framebuffer[static_cast<std::size_t>(y) * kWidth + x] = rgba(red, green, blue);
    }
  }

  const int marker_size = 24 + static_cast<int>(input & 0x0fu);
  const int marker_x = static_cast<int>((frame * 3u) % (kWidth - marker_size));
  const int marker_y = (kHeight / 2) - (marker_size / 2);

  for (int y = marker_y; y < marker_y + marker_size; ++y)
  {
    for (int x = marker_x; x < marker_x + marker_size; ++x)
    {
      if (x < 0 || y < 0 || x >= kWidth || y >= kHeight)
      {
        continue;
      }

      const bool edge = x == marker_x || y == marker_y || x == marker_x + marker_size - 1 ||
                        y == marker_y + marker_size - 1;
      if (edge)
      {
        g_framebuffer[static_cast<std::size_t>(y) * kWidth + x] = rgba(242, 239, 230);
      }
    }
  }
}
} // namespace

extern "C"
{
int MountDisc(const char* path)
{
  if (path == nullptr || path[0] == '\0')
  {
    return 0;
  }

  FILE* file = std::fopen(path, "rb");
  if (!file)
  {
    return 0;
  }

  std::fseek(file, 0, SEEK_END);
  g_disc_size = static_cast<std::uint64_t>(std::ftell(file));
  std::fseek(file, 0, SEEK_SET);
  parse_gamecube_header(file, path);
  std::fclose(file);

  g_frame = 0;
  draw_native_boot_frame();
  return 1;
}

void Reset()
{
  g_frame = 0;
  g_input_mask = 0;
  draw_native_boot_frame();
}

void SetInputMask(std::uint32_t mask)
{
  g_input_mask = mask;
}

void RunFrame()
{
  g_frame += 1;
  draw_native_boot_frame();
}

int FrameWidth()
{
  return kWidth;
}

int FrameHeight()
{
  return kHeight;
}

std::uint32_t* FrameBuffer()
{
  return g_framebuffer.data();
}

int SaveState(int slot)
{
  if (slot != 0)
  {
    return 0;
  }

  g_saved_frame = g_frame;
  g_saved_input_mask = g_input_mask;
  return 1;
}

int LoadState(int slot)
{
  if (slot != 0)
  {
    return 0;
  }

  g_frame = g_saved_frame;
  g_input_mask = g_saved_input_mask;
  draw_native_boot_frame();
  return 1;
}

std::uint32_t GetFrame()
{
  return g_frame;
}

const char* GetGameId()
{
  return g_game_id;
}

const char* GetGameTitle()
{
  return g_game_title;
}
}
