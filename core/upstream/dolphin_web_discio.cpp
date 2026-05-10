// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#include <array>
#include <algorithm>
#include <climits>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "DiscIO/DiscExtractor.h"
#include "DiscIO/DiscUtils.h"
#include "DiscIO/Enums.h"
#include "DiscIO/Filesystem.h"
#include "DiscIO/Volume.h"
#include "DiscIO/VolumeDisc.h"
#include "Core/HW/VideoInterface.h"
#include "Core/System.h"
#include "InputCommon/GCPadStatus.h"
#include "VideoCommon/TextureDecoder.h"
#include "VideoCommon/Statistics.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/atomic.h>
#endif

#ifdef __EMSCRIPTEN__
extern "C" int DolphinWeb_FastSoftwareRaster();
#else
static int DolphinWeb_FastSoftwareRaster()
{
  return 0;
}
#endif

namespace
{
using WebProfileClock = std::chrono::steady_clock;

constexpr int METADATA_FRAME_WIDTH = 320;
constexpr int METADATA_FRAME_HEIGHT = 240;
constexpr int MAX_XFB_WIDTH = 720;
constexpr int MAX_XFB_HEIGHT = 576;

constexpr std::uint32_t INPUT_A = 1u << 0;
constexpr std::uint32_t INPUT_B = 1u << 1;
constexpr std::uint32_t INPUT_X = 1u << 2;
constexpr std::uint32_t INPUT_Y = 1u << 3;
constexpr std::uint32_t INPUT_START = 1u << 4;
constexpr std::uint32_t INPUT_L = 1u << 5;
constexpr std::uint32_t INPUT_R = 1u << 6;
constexpr std::uint32_t INPUT_Z = 1u << 7;
constexpr std::uint32_t INPUT_D_UP = 1u << 8;
constexpr std::uint32_t INPUT_D_DOWN = 1u << 9;
constexpr std::uint32_t INPUT_D_LEFT = 1u << 10;
constexpr std::uint32_t INPUT_D_RIGHT = 1u << 11;
constexpr std::uint32_t INPUT_STICK_UP = 1u << 12;
constexpr std::uint32_t INPUT_STICK_DOWN = 1u << 13;
constexpr std::uint32_t INPUT_STICK_LEFT = 1u << 14;
constexpr std::uint32_t INPUT_STICK_RIGHT = 1u << 15;
constexpr std::uint32_t INPUT_C_STICK_UP = 1u << 16;
constexpr std::uint32_t INPUT_C_STICK_DOWN = 1u << 17;
constexpr std::uint32_t INPUT_C_STICK_LEFT = 1u << 18;
constexpr std::uint32_t INPUT_C_STICK_RIGHT = 1u << 19;

struct RootEntry
{
  std::string name;
  std::string path;
  double offset;
  double size;
  int is_directory;
};

std::unique_ptr<DiscIO::VolumeDisc> s_disc;
std::string s_game_id;
std::string s_game_title;
std::string s_maker_id;
std::string s_platform;
std::string s_region;
std::string s_apploader_date;
double s_apploader_size = -1.0;
double s_boot_dol_offset = -1.0;
double s_boot_dol_size = -1.0;
double s_fst_offset = -1.0;
double s_fst_size = -1.0;
double s_raw_size = -1.0;
double s_data_size = -1.0;
int s_root_entry_count = -1;
std::vector<RootEntry> s_root_entries;
std::array<std::uint32_t, MAX_XFB_WIDTH * MAX_XFB_HEIGHT> s_framebuffer{};
int s_frame_width = METADATA_FRAME_WIDTH;
int s_frame_height = METADATA_FRAME_HEIGHT;
std::uint32_t s_frame = 0;
std::uint32_t s_input_mask = 0;
std::uint8_t s_stick_x = GCPadStatus::MAIN_STICK_CENTER_X;
std::uint8_t s_stick_y = GCPadStatus::MAIN_STICK_CENTER_Y;
std::uint8_t s_c_stick_x = GCPadStatus::C_STICK_CENTER_X;
std::uint8_t s_c_stick_y = GCPadStatus::C_STICK_CENTER_Y;
std::uint8_t s_trigger_left = 0;
std::uint8_t s_trigger_right = 0;
std::uint8_t s_analog_a = 0;
std::uint8_t s_analog_b = 0;
bool s_using_xfb_frame = false;
std::string s_video_stats = "xfb:0";
float s_presentation_scale = 0.5f;
std::uint32_t s_frame_signal = 0;
std::uint32_t s_input_update_count = 0;
std::uint32_t s_pad_poll_count = 0;
std::uint32_t s_last_polled_input_mask = 0;
std::uint16_t s_last_polled_button_mask = 0;
std::uint8_t s_last_polled_stick_x = GCPadStatus::MAIN_STICK_CENTER_X;
std::uint8_t s_last_polled_stick_y = GCPadStatus::MAIN_STICK_CENTER_Y;
WebProfileClock::time_point s_last_xfb_profile_time{};
std::uint64_t s_last_xfb_interval_us = 0;
std::uint64_t s_total_xfb_interval_us = 0;
std::uint64_t s_max_xfb_interval_us = 0;
std::uint64_t s_xfb_interval_count = 0;
std::uint64_t s_last_xfb_decode_us = 0;
std::uint64_t s_total_xfb_decode_us = 0;
std::uint64_t s_max_xfb_decode_us = 0;
std::uint64_t s_xfb_decode_count = 0;
std::atomic<std::uint32_t> s_last_video_sync_us{0};
std::atomic<std::uint32_t> s_last_video_publish_us{0};
std::atomic<std::uint32_t> s_last_video_total_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_convert_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_copy_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_total_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_width{0};
std::atomic<std::uint32_t> s_last_sw_xfb_height{0};
std::atomic<std::uint32_t> s_last_sw_xfb_dst_height{0};
std::atomic<std::uint32_t> s_ogl_swap_count{0};
std::atomic<int> s_last_ogl_worker_owned{0};
std::atomic<int> s_last_ogl_commit_result{0};
std::atomic<std::uint32_t> s_last_ogl_width{0};
std::atomic<std::uint32_t> s_last_ogl_height{0};
std::atomic<std::uint32_t> s_last_ogl_debug_bits{0};
std::atomic<std::uint32_t> s_last_ogl_readback_rgba{0};
std::atomic<int> s_last_ogl_gl_error{0};

int ScaledPresentationDimension(std::uint32_t source)
{
  const int scaled = static_cast<int>(static_cast<float>(source) * s_presentation_scale);
  return std::clamp(scaled, 1, static_cast<int>(source));
}

void DownsampleFramebuffer(std::uint32_t source_width, std::uint32_t source_height, int target_width,
                           int target_height)
{
  if (target_width == static_cast<int>(source_width) &&
      target_height == static_cast<int>(source_height))
  {
    return;
  }

  for (int y = 0; y < target_height; ++y)
  {
    const auto source_y =
        static_cast<std::size_t>((static_cast<std::uint64_t>(y) * source_height) / target_height);
    for (int x = 0; x < target_width; ++x)
    {
      const auto source_x =
          static_cast<std::size_t>((static_cast<std::uint64_t>(x) * source_width) / target_width);
      s_framebuffer[static_cast<std::size_t>(y) * target_width + x] =
          s_framebuffer[source_y * source_width + source_x];
    }
  }
}

std::uint8_t ClampColor(int value)
{
  if (value <= 0)
    return 0;
  if (value >= 255)
    return 255;
  return static_cast<std::uint8_t>(value);
}

std::uint32_t YuvToRgba(std::uint8_t y, std::uint8_t u, std::uint8_t v)
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

void DecodeXfbToPresentationBuffer(const std::uint8_t* xfb, std::uint32_t source_width,
                                   std::uint32_t stride, std::uint32_t source_height,
                                   int target_width, int target_height)
{
  if (source_width < 2)
  {
    TexDecoder_DecodeXFB(reinterpret_cast<std::uint8_t*>(s_framebuffer.data()), xfb, source_width,
                         source_height, stride);
    DownsampleFramebuffer(source_width, source_height, target_width, target_height);
    return;
  }

  for (int y = 0; y < target_height; ++y)
  {
    const std::uint32_t source_y =
        static_cast<std::uint32_t>((static_cast<std::uint64_t>(y) * source_height) /
                                   static_cast<std::uint32_t>(target_height));
    const std::uint8_t* row = xfb + static_cast<std::size_t>(source_y) * stride;
    for (int x = 0; x < target_width; ++x)
    {
      const std::uint32_t source_x =
          static_cast<std::uint32_t>((static_cast<std::uint64_t>(x) * source_width) /
                                     static_cast<std::uint32_t>(target_width));
      const std::uint32_t pair_x = std::min(source_x & ~1u, source_width - 2);
      const std::uint8_t* pair = row + static_cast<std::size_t>(pair_x) * 2;
      const std::uint8_t luma = (source_x & 1u) ? pair[2] : pair[0];
      s_framebuffer[static_cast<std::size_t>(y) * target_width + x] =
          YuvToRgba(luma, pair[1], pair[3]);
    }
  }
}

void CopyRgbaToPresentationBuffer(const std::uint8_t* rgba, std::uint32_t source_width,
                                  std::uint32_t source_height, int target_width,
                                  int target_height)
{
  for (int y = 0; y < target_height; ++y)
  {
    const std::uint32_t sampled_y =
        static_cast<std::uint32_t>((static_cast<std::uint64_t>(y) * source_height) /
                                   static_cast<std::uint32_t>(target_height));
    const std::uint32_t source_y = source_height - 1 - sampled_y;
    for (int x = 0; x < target_width; ++x)
    {
      const std::uint32_t source_x =
          static_cast<std::uint32_t>((static_cast<std::uint64_t>(x) * source_width) /
                                     static_cast<std::uint32_t>(target_width));
      const std::uint8_t* pixel =
          rgba + (static_cast<std::size_t>(source_y) * source_width + source_x) * 4;
      s_framebuffer[static_cast<std::size_t>(y) * target_width + x] =
          0xff000000u | (static_cast<std::uint32_t>(pixel[2]) << 16) |
          (static_cast<std::uint32_t>(pixel[1]) << 8) | static_cast<std::uint32_t>(pixel[0]);
    }
  }
}

void PublishFrameSignal()
{
#ifdef __EMSCRIPTEN__
  emscripten_atomic_store_u32(&s_frame_signal, s_frame);
  emscripten_atomic_notify(&s_frame_signal, INT_MAX);
#endif
}

std::string PadDebugStats()
{
  std::ostringstream out;
  out << " pad polls:" << s_pad_poll_count << " updates:" << s_input_update_count
      << " input:" << std::hex << s_last_polled_input_mask
      << " buttons:" << s_last_polled_button_mask << std::dec
      << " stick:" << static_cast<int>(s_last_polled_stick_x) << ","
      << static_cast<int>(s_last_polled_stick_y)
      << " fastsw:" << DolphinWeb_FastSoftwareRaster();
  return out.str();
}

std::uint64_t ElapsedMicros(WebProfileClock::time_point start, WebProfileClock::time_point end)
{
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(end - start).count());
}

std::string FormatMicrosAsMs(std::uint64_t micros)
{
  std::ostringstream out;
  out << (micros / 1000) << "." << ((micros % 1000) / 100);
  return out.str();
}

std::string XfbProfileStats()
{
  std::ostringstream out;
  const std::uint64_t avg_interval =
      s_xfb_interval_count > 0 ? s_total_xfb_interval_us / s_xfb_interval_count : 0;
  const std::uint64_t avg_decode =
      s_xfb_decode_count > 0 ? s_total_xfb_decode_us / s_xfb_decode_count : 0;
  out << " coreprof xfb_dt:" << FormatMicrosAsMs(s_last_xfb_interval_us)
      << " avg:" << FormatMicrosAsMs(avg_interval)
      << " max:" << FormatMicrosAsMs(s_max_xfb_interval_us)
      << " decode:" << FormatMicrosAsMs(s_last_xfb_decode_us)
      << " avg:" << FormatMicrosAsMs(avg_decode)
      << " max:" << FormatMicrosAsMs(s_max_xfb_decode_us)
      << " vo_sync:" << FormatMicrosAsMs(s_last_video_sync_us.load(std::memory_order_relaxed))
      << " vo_pub:" << FormatMicrosAsMs(s_last_video_publish_us.load(std::memory_order_relaxed))
      << " vo_total:" << FormatMicrosAsMs(s_last_video_total_us.load(std::memory_order_relaxed))
      << " swxfb:" << FormatMicrosAsMs(s_last_sw_xfb_total_us.load(std::memory_order_relaxed))
      << " conv:" << FormatMicrosAsMs(s_last_sw_xfb_convert_us.load(std::memory_order_relaxed))
      << " copy:" << FormatMicrosAsMs(s_last_sw_xfb_copy_us.load(std::memory_order_relaxed))
      << " sz:" << s_last_sw_xfb_width.load(std::memory_order_relaxed) << "x"
      << s_last_sw_xfb_height.load(std::memory_order_relaxed) << "->"
      << s_last_sw_xfb_dst_height.load(std::memory_order_relaxed);
  return out.str();
}

std::string OglSwapStats()
{
  std::ostringstream out;
  out << " ogl_swap:" << s_ogl_swap_count.load(std::memory_order_relaxed)
      << " worker:" << s_last_ogl_worker_owned.load(std::memory_order_relaxed)
      << " commit:" << s_last_ogl_commit_result.load(std::memory_order_relaxed)
      << " bb:" << s_last_ogl_width.load(std::memory_order_relaxed) << "x"
      << s_last_ogl_height.load(std::memory_order_relaxed)
      << " bits:" << s_last_ogl_debug_bits.load(std::memory_order_relaxed) << " rb:0x"
      << std::hex << s_last_ogl_readback_rgba.load(std::memory_order_relaxed)
      << " glerr:0x" << s_last_ogl_gl_error.load(std::memory_order_relaxed) << std::dec;
  return out.str();
}

const char* PlatformName(DiscIO::Platform platform)
{
  switch (platform)
  {
  case DiscIO::Platform::GameCubeDisc:
    return "GameCube";
  case DiscIO::Platform::WiiDisc:
    return "Wii";
  case DiscIO::Platform::WiiWAD:
    return "Wii WAD";
  case DiscIO::Platform::ELFOrDOL:
    return "ELF/DOL";
  case DiscIO::Platform::Triforce:
    return "Triforce";
  default:
    return "Unknown";
  }
}

const char* RegionName(DiscIO::Region region)
{
  switch (region)
  {
  case DiscIO::Region::NTSC_J:
    return "NTSC-J";
  case DiscIO::Region::NTSC_U:
    return "NTSC-U";
  case DiscIO::Region::PAL:
    return "PAL";
  case DiscIO::Region::NTSC_K:
    return "NTSC-K";
  default:
    return "Unknown";
  }
}

double OptionalToDouble(std::optional<std::uint64_t> value)
{
  return value ? static_cast<double>(*value) : -1.0;
}

double OptionalToDouble(std::optional<std::uint32_t> value)
{
  return value ? static_cast<double>(*value) : -1.0;
}

std::uint8_t ClampPadByte(int value)
{
  if (value <= 0)
    return 0;
  if (value >= 0xff)
    return 0xff;
  return static_cast<std::uint8_t>(value);
}

void ClearDiscMetadata()
{
  s_game_id.clear();
  s_game_title.clear();
  s_maker_id.clear();
  s_platform = "Unknown";
  s_region = "Unknown";
  s_apploader_date.clear();
  s_apploader_size = -1.0;
  s_boot_dol_offset = -1.0;
  s_boot_dol_size = -1.0;
  s_fst_offset = -1.0;
  s_fst_size = -1.0;
  s_raw_size = -1.0;
  s_data_size = -1.0;
  s_root_entry_count = -1;
  s_root_entries.clear();
}

void RefreshBootMetadata()
{
  if (!s_disc)
  {
    ClearDiscMetadata();
    return;
  }

  const DiscIO::Partition partition = s_disc->GetGamePartition();
  s_apploader_date = s_disc->GetApploaderDate(partition);
  s_apploader_size = OptionalToDouble(DiscIO::GetApploaderSize(*s_disc, partition));

  const std::optional<std::uint64_t> dol_offset = DiscIO::GetBootDOLOffset(*s_disc, partition);
  s_boot_dol_offset = OptionalToDouble(dol_offset);
  s_boot_dol_size =
      dol_offset ? OptionalToDouble(DiscIO::GetBootDOLSize(*s_disc, partition, *dol_offset)) : -1.0;

  s_fst_offset = OptionalToDouble(DiscIO::GetFSTOffset(*s_disc, partition));
  s_fst_size = OptionalToDouble(DiscIO::GetFSTSize(*s_disc, partition));
  s_raw_size = static_cast<double>(s_disc->GetRawSize());
  s_data_size = static_cast<double>(s_disc->GetDataSize());

  const DiscIO::FileSystem* file_system = s_disc->GetFileSystem(partition);
  s_root_entries.clear();
  if (file_system && file_system->IsValid())
  {
    const DiscIO::FileInfo& root = file_system->GetRoot();
    for (const DiscIO::FileInfo& child : root)
    {
      s_root_entries.push_back({
          child.GetName(),
          child.GetPath(),
          static_cast<double>(child.GetOffset()),
          static_cast<double>(child.GetSize()),
          child.IsDirectory() ? 1 : 0,
      });
    }
    s_root_entry_count = static_cast<int>(s_root_entries.size());
  }
  else
  {
    s_root_entry_count = -1;
  }
}

void RenderMetadataFrame()
{
  s_frame_width = METADATA_FRAME_WIDTH;
  s_frame_height = METADATA_FRAME_HEIGHT;
  s_using_xfb_frame = false;

  std::uint32_t id_seed = 0x504f5254u;
  for (std::size_t i = 0; i < s_game_id.size() && i < 4; ++i)
    id_seed = (id_seed << 8) ^ static_cast<unsigned char>(s_game_id[i]);

  for (int y = 0; y < METADATA_FRAME_HEIGHT; ++y)
  {
    for (int x = 0; x < METADATA_FRAME_WIDTH; ++x)
    {
      const std::uint8_t r = static_cast<std::uint8_t>((x + s_frame + (id_seed & 0xff)) & 0xff);
      const std::uint8_t g =
          static_cast<std::uint8_t>((y + (s_frame >> 1) + ((id_seed >> 8) & 0xff)) & 0xff);
      const std::uint8_t b =
          static_cast<std::uint8_t>((x ^ y ^ s_input_mask ^ ((id_seed >> 16) & 0xff)) & 0xff);
      s_framebuffer[static_cast<std::size_t>(y) * METADATA_FRAME_WIDTH + x] =
          0xff000000u | (static_cast<std::uint32_t>(b) << 16) |
          (static_cast<std::uint32_t>(g) << 8) | static_cast<std::uint32_t>(r);
    }
  }
}
}  // namespace

extern "C"
{
void DolphinWeb_RecordVideoOutputProfile(std::uint32_t sync_us, std::uint32_t publish_us,
                                         std::uint32_t total_us)
{
  s_last_video_sync_us.store(sync_us, std::memory_order_relaxed);
  s_last_video_publish_us.store(publish_us, std::memory_order_relaxed);
  s_last_video_total_us.store(total_us, std::memory_order_relaxed);
}

void DolphinWeb_RecordSoftwareXfbEncodeProfile(std::uint32_t convert_us, std::uint32_t copy_us,
                                               std::uint32_t total_us, std::uint32_t width,
                                               std::uint32_t height,
                                               std::uint32_t dst_height)
{
  s_last_sw_xfb_convert_us.store(convert_us, std::memory_order_relaxed);
  s_last_sw_xfb_copy_us.store(copy_us, std::memory_order_relaxed);
  s_last_sw_xfb_total_us.store(total_us, std::memory_order_relaxed);
  s_last_sw_xfb_width.store(width, std::memory_order_relaxed);
  s_last_sw_xfb_height.store(height, std::memory_order_relaxed);
  s_last_sw_xfb_dst_height.store(dst_height, std::memory_order_relaxed);
}

int MountDisc(const char* path)
{
  if (!path)
    return 0;

  s_disc = DiscIO::CreateDisc(std::string(path));
  if (!s_disc)
  {
    ClearDiscMetadata();
    RenderMetadataFrame();
    return 0;
  }

  s_game_id = s_disc->GetGameID();
  s_game_title = s_disc->GetInternalName();
  s_maker_id = s_disc->GetMakerID();
  s_platform = PlatformName(s_disc->GetVolumeType());
  s_region = RegionName(s_disc->GetRegion());
  RefreshBootMetadata();
  RenderMetadataFrame();
  return 1;
}

void Reset()
{
  s_frame = 0;
  RenderMetadataFrame();
}

void SetInputMask(std::uint32_t mask)
{
  s_input_mask = mask;
  ++s_input_update_count;
  s_stick_x = GCPadStatus::MAIN_STICK_CENTER_X;
  s_stick_y = GCPadStatus::MAIN_STICK_CENTER_Y;
  s_c_stick_x = GCPadStatus::C_STICK_CENTER_X;
  s_c_stick_y = GCPadStatus::C_STICK_CENTER_Y;
  s_trigger_left = 0;
  s_trigger_right = 0;
  s_analog_a = 0;
  s_analog_b = 0;
}

void SetInputState(std::uint32_t mask, int stick_x, int stick_y, int c_stick_x, int c_stick_y,
                   int trigger_left, int trigger_right, int analog_a, int analog_b)
{
  s_input_mask = mask;
  ++s_input_update_count;
  s_stick_x = ClampPadByte(stick_x);
  s_stick_y = ClampPadByte(stick_y);
  s_c_stick_x = ClampPadByte(c_stick_x);
  s_c_stick_y = ClampPadByte(c_stick_y);
  s_trigger_left = ClampPadByte(trigger_left);
  s_trigger_right = ClampPadByte(trigger_right);
  s_analog_a = ClampPadByte(analog_a);
  s_analog_b = ClampPadByte(analog_b);
}

int SetPresentationScale(float scale)
{
  if (scale < 0.25f || scale > 1.0f)
    return 0;

  s_presentation_scale = scale;
  return 1;
}

void RunFrame()
{
  ++s_frame;
  if (!s_using_xfb_frame)
    RenderMetadataFrame();
  PublishFrameSignal();
}

int FrameWidth()
{
  return s_frame_width;
}

int FrameHeight()
{
  return s_frame_height;
}

std::uint32_t* FrameBuffer()
{
  return s_framebuffer.data();
}

int SaveState(int slot)
{
  return slot >= 0 ? 1 : 0;
}

int LoadState(int slot)
{
  return slot >= 0 ? 1 : 0;
}

std::uint32_t GetFrame()
{
  return s_frame;
}

std::uint32_t* GetFrameSignalPtr()
{
  return &s_frame_signal;
}

void DolphinWeb_OnXfb(const std::uint8_t* xfb, std::uint32_t width, std::uint32_t stride,
                      std::uint32_t height)
{
  const auto callback_start = WebProfileClock::now();
  if (s_last_xfb_profile_time.time_since_epoch().count() != 0)
  {
    s_last_xfb_interval_us = ElapsedMicros(s_last_xfb_profile_time, callback_start);
    s_total_xfb_interval_us += s_last_xfb_interval_us;
    s_max_xfb_interval_us = std::max(s_max_xfb_interval_us, s_last_xfb_interval_us);
    ++s_xfb_interval_count;
  }
  s_last_xfb_profile_time = callback_start;

  if (!xfb || width == 0 || height == 0 || width > MAX_XFB_WIDTH || height > MAX_XFB_HEIGHT ||
      stride < width * 2)
  {
    return;
  }

  const int presentation_width = ScaledPresentationDimension(width);
  const int presentation_height = ScaledPresentationDimension(height);
  DecodeXfbToPresentationBuffer(xfb, width, stride, height, presentation_width,
                                 presentation_height);
  const auto decode_done = WebProfileClock::now();
  s_last_xfb_decode_us = ElapsedMicros(callback_start, decode_done);
  s_total_xfb_decode_us += s_last_xfb_decode_us;
  s_max_xfb_decode_us = std::max(s_max_xfb_decode_us, s_last_xfb_decode_us);
  ++s_xfb_decode_count;

  std::uint32_t hash = 2166136261u;
  std::uint32_t nonzero_samples = 0;
  const std::size_t frame_bytes = static_cast<std::size_t>(stride) * height;
  const std::size_t sample_count = std::min<std::size_t>(frame_bytes / 4, 2048);
  const std::size_t sample_step =
      std::max<std::size_t>(4, ((frame_bytes / std::max<std::size_t>(1, sample_count)) / 4) * 4);
  for (std::size_t i = 0; i < frame_bytes; i += sample_step)
  {
    const std::uint8_t luma = xfb[i];
    hash ^= luma;
    hash *= 16777619u;
    hash ^= xfb[std::min<std::size_t>(i + 1, frame_bytes - 1)];
    hash *= 16777619u;
    hash ^= xfb[std::min<std::size_t>(i + 2, frame_bytes - 1)];
    hash *= 16777619u;
    if (luma != 0)
      ++nonzero_samples;
  }

  s_frame_width = presentation_width;
  s_frame_height = presentation_height;
  s_using_xfb_frame = true;
  ++s_frame;
  PublishFrameSignal();

  std::ostringstream out;
  out << "xfb:" << s_frame << " " << width << "x" << height << " stride:" << stride
      << " present:" << presentation_width << "x" << presentation_height
      << " hash:" << std::hex << hash << std::dec << " nz:" << nonzero_samples
      << " bp:" << g_stats.this_frame.num_bp_loads << " cp:" << g_stats.this_frame.num_cp_loads
      << " xf:" << g_stats.this_frame.num_xf_loads
      << " prim:" << g_stats.this_frame.num_prims
      << " draw:" << g_stats.this_frame.num_draw_calls
      << " rast:" << g_stats.this_frame.rasterized_pixels
      << " verts:" << g_stats.this_frame.num_vertices_loaded << PadDebugStats()
      << XfbProfileStats();
  s_video_stats = out.str();
}

void DolphinWeb_OnGlBackbuffer(const std::uint8_t* rgba, std::uint32_t width, std::uint32_t height)
{
  const auto callback_start = WebProfileClock::now();
  if (s_last_xfb_profile_time.time_since_epoch().count() != 0)
  {
    s_last_xfb_interval_us = ElapsedMicros(s_last_xfb_profile_time, callback_start);
    s_total_xfb_interval_us += s_last_xfb_interval_us;
    s_max_xfb_interval_us = std::max(s_max_xfb_interval_us, s_last_xfb_interval_us);
    ++s_xfb_interval_count;
  }
  s_last_xfb_profile_time = callback_start;

  if (!rgba || width == 0 || height == 0 || width > MAX_XFB_WIDTH || height > MAX_XFB_HEIGHT)
  {
    return;
  }

  const int presentation_width = ScaledPresentationDimension(width);
  const int presentation_height = ScaledPresentationDimension(height);
  CopyRgbaToPresentationBuffer(rgba, width, height, presentation_width, presentation_height);
  const auto decode_done = WebProfileClock::now();
  s_last_xfb_decode_us = ElapsedMicros(callback_start, decode_done);
  s_total_xfb_decode_us += s_last_xfb_decode_us;
  s_max_xfb_decode_us = std::max(s_max_xfb_decode_us, s_last_xfb_decode_us);
  ++s_xfb_decode_count;

  std::uint32_t hash = 2166136261u;
  std::uint32_t nonzero_samples = 0;
  const std::size_t pixel_count = static_cast<std::size_t>(presentation_width) * presentation_height;
  const std::size_t sample_step = std::max<std::size_t>(1, pixel_count / 2048);
  for (std::size_t i = 0; i < pixel_count; i += sample_step)
  {
    const std::uint32_t pixel = s_framebuffer[i];
    hash ^= pixel & 0xffu;
    hash *= 16777619u;
    hash ^= (pixel >> 8) & 0xffu;
    hash *= 16777619u;
    hash ^= (pixel >> 16) & 0xffu;
    hash *= 16777619u;
    if ((pixel & 0x00ffffffu) != 0)
      ++nonzero_samples;
  }

  s_frame_width = presentation_width;
  s_frame_height = presentation_height;
  s_using_xfb_frame = false;
  ++s_frame;
  PublishFrameSignal();

  std::ostringstream out;
  out << "glfb:" << s_frame << " " << width << "x" << height
      << " present:" << presentation_width << "x" << presentation_height
      << " hash:" << std::hex << hash << std::dec << " nz:" << nonzero_samples
      << " bp:" << g_stats.this_frame.num_bp_loads << " cp:" << g_stats.this_frame.num_cp_loads
      << " xf:" << g_stats.this_frame.num_xf_loads
      << " prim:" << g_stats.this_frame.num_prims
      << " draw:" << g_stats.this_frame.num_draw_calls
      << " rast:" << g_stats.this_frame.rasterized_pixels
      << " verts:" << g_stats.this_frame.num_vertices_loaded << PadDebugStats()
      << XfbProfileStats();
  s_video_stats = out.str();
}

void DolphinWeb_OnOglSwap(int worker_owned, int commit_result, std::uint32_t width,
                          std::uint32_t height, std::uint32_t debug_bits,
                          std::uint32_t readback_rgba, int gl_error)
{
  s_ogl_swap_count.fetch_add(1, std::memory_order_relaxed);
  s_last_ogl_worker_owned.store(worker_owned, std::memory_order_relaxed);
  s_last_ogl_commit_result.store(commit_result, std::memory_order_relaxed);
  s_last_ogl_width.store(width, std::memory_order_relaxed);
  s_last_ogl_height.store(height, std::memory_order_relaxed);
  s_last_ogl_debug_bits.store(debug_bits, std::memory_order_relaxed);
  s_last_ogl_readback_rgba.store(readback_rgba, std::memory_order_relaxed);
  s_last_ogl_gl_error.store(gl_error, std::memory_order_relaxed);
  ++s_frame;
  PublishFrameSignal();
}

const char* GetVideoStats()
{
  static std::string current_video_stats;
  if (s_video_stats == "xfb:0")
  {
    const auto& vi = Core::System::GetInstance().GetVideoInterface();
    std::ostringstream out;
    out << "xfb:0 vi_top:" << std::hex << vi.GetXFBAddressTop()
        << " vi_bottom:" << vi.GetXFBAddressBottom() << std::dec
        << " hz:" << vi.GetTargetRefreshRate() << PadDebugStats() << OglSwapStats();
    current_video_stats = out.str();
    return current_video_stats.c_str();
  }
  current_video_stats = s_video_stats + OglSwapStats();
  return current_video_stats.c_str();
}

int DolphinWeb_GetPadStatus(int pad_num, GCPadStatus* status)
{
  if (!status || pad_num != 0)
    return 0;

  *status = {};
  status->isConnected = true;
  status->stickX = s_stick_x;
  status->stickY = s_stick_y;
  status->substickX = s_c_stick_x;
  status->substickY = s_c_stick_y;
  status->triggerLeft = s_trigger_left;
  status->triggerRight = s_trigger_right;
  status->analogA = s_analog_a;
  status->analogB = s_analog_b;

  const std::uint32_t mask = s_input_mask;
  if (mask & INPUT_A)
  {
    status->button |= PAD_BUTTON_A;
    status->analogA = std::max<std::uint8_t>(status->analogA, 0xff);
  }
  if (mask & INPUT_B)
  {
    status->button |= PAD_BUTTON_B;
    status->analogB = std::max<std::uint8_t>(status->analogB, 0xff);
  }
  if (mask & INPUT_X)
    status->button |= PAD_BUTTON_X;
  if (mask & INPUT_Y)
    status->button |= PAD_BUTTON_Y;
  if (mask & INPUT_START)
    status->button |= PAD_BUTTON_START;
  if (mask & INPUT_L)
  {
    status->button |= PAD_TRIGGER_L;
    status->triggerLeft = std::max<std::uint8_t>(status->triggerLeft, 0xff);
  }
  if (mask & INPUT_R)
  {
    status->button |= PAD_TRIGGER_R;
    status->triggerRight = std::max<std::uint8_t>(status->triggerRight, 0xff);
  }
  if (mask & INPUT_Z)
    status->button |= PAD_TRIGGER_Z;
  if (mask & INPUT_D_UP)
    status->button |= PAD_BUTTON_UP;
  if (mask & INPUT_D_DOWN)
    status->button |= PAD_BUTTON_DOWN;
  if (mask & INPUT_D_LEFT)
    status->button |= PAD_BUTTON_LEFT;
  if (mask & INPUT_D_RIGHT)
    status->button |= PAD_BUTTON_RIGHT;

  if ((mask & INPUT_STICK_LEFT) && !(mask & INPUT_STICK_RIGHT))
    status->stickX = 0x20;
  else if ((mask & INPUT_STICK_RIGHT) && !(mask & INPUT_STICK_LEFT))
    status->stickX = 0xe0;

  if ((mask & INPUT_STICK_UP) && !(mask & INPUT_STICK_DOWN))
    status->stickY = 0xe0;
  else if ((mask & INPUT_STICK_DOWN) && !(mask & INPUT_STICK_UP))
    status->stickY = 0x20;

  if ((mask & INPUT_C_STICK_LEFT) && !(mask & INPUT_C_STICK_RIGHT))
    status->substickX = 0x20;
  else if ((mask & INPUT_C_STICK_RIGHT) && !(mask & INPUT_C_STICK_LEFT))
    status->substickX = 0xe0;

  if ((mask & INPUT_C_STICK_UP) && !(mask & INPUT_C_STICK_DOWN))
    status->substickY = 0xe0;
  else if ((mask & INPUT_C_STICK_DOWN) && !(mask & INPUT_C_STICK_UP))
    status->substickY = 0x20;

  ++s_pad_poll_count;
  s_last_polled_input_mask = mask;
  s_last_polled_button_mask = status->button;
  s_last_polled_stick_x = status->stickX;
  s_last_polled_stick_y = status->stickY;

  return 1;
}

const char* GetGameId()
{
  return s_game_id.c_str();
}

const char* GetGameTitle()
{
  return s_game_title.c_str();
}

const char* GetMakerId()
{
  return s_maker_id.c_str();
}

const char* GetPlatform()
{
  return s_platform.c_str();
}

const char* GetRegion()
{
  return s_region.c_str();
}

int GetDiscNumber()
{
  const std::optional<std::uint8_t> disc_number = s_disc ? s_disc->GetDiscNumber() : std::nullopt;
  return disc_number ? static_cast<int>(*disc_number) : -1;
}

const char* GetApploaderDate()
{
  return s_apploader_date.c_str();
}

double GetApploaderSize()
{
  return s_apploader_size;
}

double GetBootDolOffset()
{
  return s_boot_dol_offset;
}

double GetBootDolSize()
{
  return s_boot_dol_size;
}

double GetFstOffset()
{
  return s_fst_offset;
}

double GetFstSize()
{
  return s_fst_size;
}

double GetRawSize()
{
  return s_raw_size;
}

double GetDataSize()
{
  return s_data_size;
}

int GetRootEntryCount()
{
  return s_root_entry_count;
}

const char* GetRootEntryName(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return "";

  return s_root_entries[static_cast<std::size_t>(index)].name.c_str();
}

const char* GetRootEntryPath(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return "";

  return s_root_entries[static_cast<std::size_t>(index)].path.c_str();
}

int GetRootEntryIsDirectory(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return 0;

  return s_root_entries[static_cast<std::size_t>(index)].is_directory;
}

double GetRootEntryOffset(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return -1.0;

  return s_root_entries[static_cast<std::size_t>(index)].offset;
}

double GetRootEntrySize(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return -1.0;

  return s_root_entries[static_cast<std::size_t>(index)].size;
}

int ReadDisc(double offset, int length, std::uint8_t* buffer)
{
  if (!s_disc || !buffer || offset < 0 || length < 0)
    return 0;

  const bool read =
      s_disc->Read(static_cast<std::uint64_t>(offset), static_cast<std::uint64_t>(length), buffer,
                   s_disc->GetGamePartition());
  return read ? length : 0;
}

int ReadDiscFile(const char* path, double offset, int length, std::uint8_t* buffer)
{
  if (!s_disc || !path || !buffer || offset < 0 || length < 0)
    return 0;

  const std::uint64_t read =
      DiscIO::ReadFile(*s_disc, s_disc->GetGamePartition(), path, buffer,
                       static_cast<std::uint64_t>(length), static_cast<std::uint64_t>(offset));
  return read > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ?
             std::numeric_limits<int>::max() :
             static_cast<int>(read);
}
}
