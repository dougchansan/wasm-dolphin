// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Emulated Wii Remote input for the browser core.
//
// The browser already sends one pad snapshot (SetInputState) per input
// change. When bit 31 of its mask is set the snapshot is a Wii snapshot:
// the GameCube pad reports itself unplugged, and the bits and bytes below
// drive Wii Remote 1 instead. Nothing new crosses the worker boundary, so
// the existing SharedArrayBuffer transport carries it unchanged.
//
// The Wii side is ordinary Dolphin: a ControllerInterface device
// ("Web/0/Browser") exposes the snapshot as named inputs, and Wii Remote 1
// is mapped onto that device with Dolphin's own expressions. Dolphin's
// WiimoteEmu therefore produces the IR camera points, accelerometer data,
// extension reports and sideways rotation itself.
//
// Wii-mode mask (only meaningful while WEB_WII_MODE is set):
//   0 A          wiimote A / classic a
//   1 B          wiimote B / classic b
//   2 ONE        wiimote 1 / classic x
//   3 TWO        wiimote 2 / classic y
//   4 PLUS
//   5 C_L        nunchuk C / classic L
//   6 Z_R        nunchuk Z / classic R
//   7 ZL         classic ZL
//   8..11        D-pad up, down, left, right
//   12 ZR        classic ZR
//   13 MINUS
//   14 HOME
//   15 SHAKE
//   16..19       tilt left, right, forward, backward
//   20 SIDEWAYS  hold the remote sideways (also rotates the D-pad)
//   21 POINTER   the IR pointer is on screen
//   22..23       extension: 0 none, 1 nunchuk, 2 classic controller
//   24..28       swing forward, left, right, up, down
//   31 WII_MODE
// Bytes: stick = nunchuk stick / classic left stick, c-stick = classic right
// stick, analogA/analogB = IR pointer X/Y (0x80 centre, larger = right/up),
// triggers = classic L/R analog.

#pragma once

#include <cmath>
#include <memory>
#include <string>

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <vector>

#include "Core/Config/WiimoteSettings.h"
#include "Core/HW/Wiimote.h"
#include "Core/HW/WiimoteCommon/WiimoteConstants.h"
#include "Core/HW/WiimoteReal/WiimoteReal.h"
#include "Core/HW/WiimoteEmu/Extension/Classic.h"
#include "Core/HW/WiimoteEmu/Extension/Nunchuk.h"
#include "Core/HW/WiimoteEmu/WiimoteEmu.h"
#include "InputCommon/ControlReference/ControlReference.h"
#include "InputCommon/ControllerEmu/ControlGroup/Attachments.h"
#include "InputCommon/ControllerEmu/ControlGroup/ControlGroup.h"
#include "InputCommon/ControllerEmu/ControllerEmu.h"
#include "InputCommon/ControllerEmu/Setting/NumericSetting.h"
#include "InputCommon/ControllerInterface/ControllerInterface.h"
#include "InputCommon/ControllerInterface/CoreDevice.h"
#include "InputCommon/InputConfig.h"

namespace DolphinWebWii
{
constexpr std::uint32_t BIT_A = 1u << 0;
constexpr std::uint32_t BIT_B = 1u << 1;
constexpr std::uint32_t BIT_ONE = 1u << 2;
constexpr std::uint32_t BIT_TWO = 1u << 3;
constexpr std::uint32_t BIT_PLUS = 1u << 4;
constexpr std::uint32_t BIT_C_L = 1u << 5;
constexpr std::uint32_t BIT_Z_R = 1u << 6;
constexpr std::uint32_t BIT_ZL = 1u << 7;
constexpr std::uint32_t BIT_UP = 1u << 8;
constexpr std::uint32_t BIT_DOWN = 1u << 9;
constexpr std::uint32_t BIT_LEFT = 1u << 10;
constexpr std::uint32_t BIT_RIGHT = 1u << 11;
constexpr std::uint32_t BIT_ZR = 1u << 12;
constexpr std::uint32_t BIT_MINUS = 1u << 13;
constexpr std::uint32_t BIT_HOME = 1u << 14;
constexpr std::uint32_t BIT_SHAKE = 1u << 15;
constexpr std::uint32_t BIT_TILT_LEFT = 1u << 16;
constexpr std::uint32_t BIT_TILT_RIGHT = 1u << 17;
constexpr std::uint32_t BIT_TILT_FORWARD = 1u << 18;
constexpr std::uint32_t BIT_TILT_BACKWARD = 1u << 19;
constexpr std::uint32_t BIT_SIDEWAYS = 1u << 20;
constexpr std::uint32_t BIT_POINTER = 1u << 21;
constexpr std::uint32_t BIT_SWING_FORWARD = 1u << 24;
constexpr std::uint32_t BIT_SWING_LEFT = 1u << 25;
constexpr std::uint32_t BIT_SWING_RIGHT = 1u << 26;
constexpr std::uint32_t BIT_SWING_UP = 1u << 27;
constexpr std::uint32_t BIT_SWING_DOWN = 1u << 28;
constexpr int EXTENSION_SHIFT = 22;
constexpr std::uint32_t EXTENSION_MASK = 3u << EXTENSION_SHIFT;

constexpr const char* DEVICE = "Web/0/Browser";

class BrowserDevice final : public ciface::Core::Device
{
public:
  BrowserDevice()
  {
    for (const auto& [name, bit] : std::initializer_list<std::pair<const char*, std::uint32_t>>{
             {"A", BIT_A},
             {"B", BIT_B},
             {"One", BIT_ONE},
             {"Two", BIT_TWO},
             {"Plus", BIT_PLUS},
             {"C-L", BIT_C_L},
             {"Z-R", BIT_Z_R},
             {"ZL", BIT_ZL},
             {"ZR", BIT_ZR},
             {"Up", BIT_UP},
             {"Down", BIT_DOWN},
             {"Left", BIT_LEFT},
             {"Right", BIT_RIGHT},
             {"Minus", BIT_MINUS},
             {"Home", BIT_HOME},
             {"Shake", BIT_SHAKE},
             {"Tilt Left", BIT_TILT_LEFT},
             {"Tilt Right", BIT_TILT_RIGHT},
             {"Tilt Forward", BIT_TILT_FORWARD},
             {"Tilt Backward", BIT_TILT_BACKWARD},
             {"Sideways", BIT_SIDEWAYS},
             {"Swing Forward", BIT_SWING_FORWARD},
             {"Swing Left", BIT_SWING_LEFT},
             {"Swing Right", BIT_SWING_RIGHT},
             {"Swing Up", BIT_SWING_UP},
             {"Swing Down", BIT_SWING_DOWN},
         })
    {
      AddInput(new Button(this, name, bit));
    }

    AddInput(new Value(
        this, "Pointer Hidden",
        [](const InputStateSnapshot& s) {
          return ((s.mask & WEB_WII_MODE) && (s.mask & BIT_POINTER)) ? 0.0 : 1.0;
        },
        true));
    // Extension index for the Attachments selection expression. Read even
    // outside Wii mode so the attachment does not flap while switching.
    AddInput(new Value(this, "Extension", [](const InputStateSnapshot& s) {
      return double((s.mask & EXTENSION_MASK) >> EXTENSION_SHIFT);
    }, true));

    AddAxis("Stick", &InputStateSnapshot::stick_x, &InputStateSnapshot::stick_y);
    AddAxis("Right Stick", &InputStateSnapshot::c_stick_x, &InputStateSnapshot::c_stick_y);
    AddAxis("Pointer", &InputStateSnapshot::analog_a, &InputStateSnapshot::analog_b);
    AddInput(new Value(this, "L-Analog", [](const InputStateSnapshot& s) {
      return s.trigger_left / 255.0;
    }));
    AddInput(new Value(this, "R-Analog", [](const InputStateSnapshot& s) {
      return s.trigger_right / 255.0;
    }));
  }

  std::string GetName() const override { return "Browser"; }
  std::string GetSource() const override { return "Web"; }
  bool IsVirtualDevice() const override { return true; }

  ciface::Core::DeviceRemoval UpdateInput() override
  {
    const std::lock_guard<std::mutex> lock(s_input_state_mutex);
    m_state = s_input_state;
    return ciface::Core::DeviceRemoval::Keep;
  }

private:
  bool WiiMode() const { return (m_state.mask & WEB_WII_MODE) != 0; }

  class Button final : public Input
  {
  public:
    Button(const BrowserDevice* device, std::string name, std::uint32_t bit)
        : m_device(device), m_name(std::move(name)), m_bit(bit)
    {
    }
    std::string GetName() const override { return m_name; }
    ControlState GetState() const override
    {
      return m_device->WiiMode() && (m_device->m_state.mask & m_bit) ? 1.0 : 0.0;
    }

  private:
    const BrowserDevice* m_device;
    std::string m_name;
    std::uint32_t m_bit;
  };

  class Value final : public Input
  {
  public:
    using Reader = ControlState (*)(const InputStateSnapshot&);
    // An ungated value reads 0 outside Wii mode, like every button and axis,
    // so a Wii game played with the GameCube pad sees an idle remote.
    Value(const BrowserDevice* device, std::string name, Reader reader, bool always = false)
        : m_device(device), m_name(std::move(name)), m_reader(reader), m_always(always)
    {
    }
    std::string GetName() const override { return m_name; }
    bool IsDetectable() const override { return false; }
    ControlState GetState() const override
    {
      if (!m_always && !m_device->WiiMode())
        return 0.0;
      return m_reader(m_device->m_state);
    }

  private:
    const BrowserDevice* m_device;
    std::string m_name;
    Reader m_reader;
    bool m_always;
  };

  // One half of a byte axis centred on 0x80: "+" reads 0x80..0xff as 0..1,
  // "-" reads 0x80..0x00 as 0..1.
  class AxisHalf final : public Input
  {
  public:
    AxisHalf(const BrowserDevice* device, std::string name,
             std::uint8_t InputStateSnapshot::*field, bool positive)
        : m_device(device), m_name(std::move(name)), m_field(field), m_positive(positive)
    {
    }
    std::string GetName() const override { return m_name; }
    ControlState GetState() const override
    {
      if (!m_device->WiiMode())
        return 0.0;
      const double v = (double(m_device->m_state.*m_field) - 128.0) / 127.0;
      return std::clamp(m_positive ? v : -v, 0.0, 1.0);
    }

  private:
    const BrowserDevice* m_device;
    std::string m_name;
    std::uint8_t InputStateSnapshot::*m_field;
    bool m_positive;
  };

  void AddAxis(const std::string& name, std::uint8_t InputStateSnapshot::*x,
               std::uint8_t InputStateSnapshot::*y)
  {
    AddInput(new AxisHalf(this, name + " X-", x, false));
    AddInput(new AxisHalf(this, name + " X+", x, true));
    AddInput(new AxisHalf(this, name + " Y-", y, false));
    AddInput(new AxisHalf(this, name + " Y+", y, true));
  }

  InputStateSnapshot m_state;
};

inline std::string Ref(const char* input)
{
  return std::string("`") + DEVICE + ":" + input + "`";
}

inline void ClearGroups(std::vector<std::unique_ptr<ControllerEmu::ControlGroup>>& groups)
{
  for (auto& group : groups)
  {
    for (auto& control : group->controls)
      control->control_ref->SetExpression("");
    if (group->type == ControllerEmu::GroupType::Attachments)
    {
      auto* attachments = static_cast<ControllerEmu::Attachments*>(group.get());
      for (auto& attachment : attachments->GetAttachmentList())
        ClearGroups(attachment->groups);
    }
  }
}

inline int MapGroup(ControllerEmu::ControlGroup* group,
                    std::initializer_list<std::pair<const char*, const char*>> pairs)
{
  int missing = 0;
  if (!group)
    return static_cast<int>(pairs.size());
  for (const auto& [control_name, input] : pairs)
  {
    bool found = false;
    for (auto& control : group->controls)
    {
      if (control->name == control_name)
      {
        control->control_ref->SetExpression(Ref(input));
        found = true;
        break;
      }
    }
    if (!found)
    {
      ++missing;
      EM_ASM({ console.warn('[wii] no control ' + UTF8ToString($0) + ' in ' + UTF8ToString($1)); },
             control_name, group->name.c_str());
    }
  }
  return missing;
}

inline std::shared_ptr<BrowserDevice> s_browser_device;
inline bool s_config_ready = false;
inline void ApplyHidSources();

// Called once, after ControllerInterface, Pad and Keyboard are up.
inline void Initialize()
{
  if (!s_browser_device)
  {
    s_browser_device = std::make_shared<BrowserDevice>();
    g_controller_interface.AddDevice(s_browser_device);
  }

  Wiimote::Initialize(Wiimote::InitializeMode::DO_NOT_WAIT_FOR_WIIMOTES);

  auto* controller =
      static_cast<ControllerEmu::EmulatedController*>(Wiimote::GetConfig()->GetController(0));
  if (!controller)
    return;

  const auto lock = ControllerEmu::EmulatedController::GetStateLock();
  ClearGroups(controller->groups);
  controller->SetDefaultDevice(DEVICE);

  using WiimoteEmu::ClassicGroup;
  using WiimoteEmu::NunchukGroup;
  using WiimoteEmu::WiimoteGroup;
  int missing = 0;
  missing += MapGroup(Wiimote::GetWiimoteGroup(0, WiimoteGroup::Buttons),
                      {{"A", "A"},
                       {"B", "B"},
                       {"1", "One"},
                       {"2", "Two"},
                       {"-", "Minus"},
                       {"+", "Plus"},
                       {"Home", "Home"}});
  missing += MapGroup(Wiimote::GetWiimoteGroup(0, WiimoteGroup::DPad),
                      {{"Up", "Up"}, {"Down", "Down"}, {"Left", "Left"}, {"Right", "Right"}});
  missing += MapGroup(Wiimote::GetWiimoteGroup(0, WiimoteGroup::Point),
                      {{"Up", "Pointer Y+"},
                       {"Down", "Pointer Y-"},
                       {"Left", "Pointer X-"},
                       {"Right", "Pointer X+"},
                       {"Hide", "Pointer Hidden"}});
  missing += MapGroup(Wiimote::GetWiimoteGroup(0, WiimoteGroup::Shake),
                      {{"X", "Shake"}, {"Y", "Shake"}, {"Z", "Shake"}});
  missing += MapGroup(Wiimote::GetWiimoteGroup(0, WiimoteGroup::Tilt),
                      {{"Forward", "Tilt Forward"},
                       {"Backward", "Tilt Backward"},
                       {"Left", "Tilt Left"},
                       {"Right", "Tilt Right"}});
  missing += MapGroup(Wiimote::GetWiimoteGroup(0, WiimoteGroup::Swing),
                      {{"Forward", "Swing Forward"},
                       {"Left", "Swing Left"},
                       {"Right", "Swing Right"},
                       {"Up", "Swing Up"},
                       {"Down", "Swing Down"}});
  missing += MapGroup(Wiimote::GetWiimoteGroup(0, WiimoteGroup::Hotkeys),
                      {{"Sideways Hold", "Sideways"}});

  missing += MapGroup(Wiimote::GetNunchukGroup(0, NunchukGroup::Buttons),
                      {{"C", "C-L"}, {"Z", "Z-R"}});
  missing += MapGroup(Wiimote::GetNunchukGroup(0, NunchukGroup::Stick),
                      {{"Up", "Stick Y+"},
                       {"Down", "Stick Y-"},
                       {"Left", "Stick X-"},
                       {"Right", "Stick X+"}});

  missing += MapGroup(Wiimote::GetClassicGroup(0, ClassicGroup::Buttons),
                      {{"A", "A"},
                       {"B", "B"},
                       {"X", "One"},
                       {"Y", "Two"},
                       {"ZL", "ZL"},
                       {"ZR", "ZR"},
                       {"-", "Minus"},
                       {"+", "Plus"},
                       {"Home", "Home"}});
  missing += MapGroup(Wiimote::GetClassicGroup(0, ClassicGroup::Triggers),
                      {{"L", "C-L"}, {"R", "Z-R"}, {"L-Analog", "L-Analog"}, {"R-Analog", "R-Analog"}});
  missing += MapGroup(Wiimote::GetClassicGroup(0, ClassicGroup::DPad),
                      {{"Up", "Up"}, {"Down", "Down"}, {"Left", "Left"}, {"Right", "Right"}});
  missing += MapGroup(Wiimote::GetClassicGroup(0, ClassicGroup::LeftStick),
                      {{"Up", "Stick Y+"},
                       {"Down", "Stick Y-"},
                       {"Left", "Stick X-"},
                       {"Right", "Stick X+"}});
  missing += MapGroup(Wiimote::GetClassicGroup(0, ClassicGroup::RightStick),
                      {{"Up", "Right Stick Y+"},
                       {"Down", "Right Stick Y-"},
                       {"Left", "Right Stick X-"},
                       {"Right", "Right Stick X+"}});

  // The attached extension follows the browser's choice every frame.
  auto* attachments = static_cast<ControllerEmu::Attachments*>(
      Wiimote::GetWiimoteGroup(0, WiimoteGroup::Attachments));
  if (attachments)
    attachments->GetSelectionSetting().GetInputReference().SetExpression(Ref("Extension"));
  else
    ++missing;

  controller->UpdateReferences(g_controller_interface);

  // Dolphin reloads WiimoteNew.ini whenever a Wii title starts
  // (SConfig::OnESTitleChanged), so the mapping has to live in the file,
  // not just in memory.
  Wiimote::GetConfig()->SaveConfig();

  EM_ASM({ console.info('[wii] Wii Remote 1 mapped to the browser device (' + $0 + ' unmapped)'); },
         missing);

  s_config_ready = true;
  ApplyHidSources();
}
}  // namespace DolphinWebWii

// ---------------------------------------------------------------------------
// Real Wii Remotes over WebHID (Mayflash DolphinBar in mode 4, or a remote
// paired to the computer over Bluetooth).
//
// The page opens the HID interfaces and hands raw reports to the worker,
// which pushes them in here with WebHidPushReport. Dolphin's own real-remote
// code (WiimoteReal) then drives them exactly as desktop Dolphin does with
// hidapi: reports pass straight between the game and the remote, so the IR
// camera, accelerometer, extensions, rumble and speaker are all the real
// thing. Writes queue here until the worker drains them (WebHidPopWrite) and
// the page sends them with HIDDevice.sendReport.
// ---------------------------------------------------------------------------
namespace DolphinWebWii
{
constexpr int HID_SLOTS = 4;

struct HidSlot
{
  std::mutex mutex;
  std::condition_variable cv;
  std::deque<std::vector<u8>> reads;   // [report id, payload...]
  std::deque<std::vector<u8>> writes;  // [report id, payload...]
  bool attached = false;
  bool wake = false;
};

inline std::array<HidSlot, HID_SLOTS> s_hid_slots;
inline std::array<u8, 64> s_hid_write_buffer{};

class WebHidWiimote final : public WiimoteReal::Wiimote
{
public:
  explicit WebHidWiimote(int slot) : m_slot(slot) {}
  ~WebHidWiimote() override { Shutdown(); }

  std::string GetId() const override { return "WebHID/" + std::to_string(m_slot); }

protected:
  bool ConnectInternal() override { return IsConnected(); }
  void DisconnectInternal() override {}
  bool IsConnected() const override
  {
    auto& s = s_hid_slots[m_slot];
    const std::lock_guard lock(s.mutex);
    return s.attached;
  }
  void IOWakeup() override
  {
    auto& s = s_hid_slots[m_slot];
    {
      const std::lock_guard lock(s.mutex);
      s.wake = true;
    }
    s.cv.notify_all();
  }
  // Same convention as the hidapi backend: >0 bytes read, -1 nothing yet,
  // 0 error (the remote went away).
  int IORead(u8* buf) override
  {
    auto& s = s_hid_slots[m_slot];
    std::unique_lock lock(s.mutex);
    s.cv.wait_for(lock, std::chrono::milliseconds(200),
                  [&] { return !s.reads.empty() || s.wake || !s.attached; });
    if (!s.attached)
      return 0;
    s.wake = false;
    if (s.reads.empty())
      return -1;
    std::vector<u8> report = std::move(s.reads.front());
    s.reads.pop_front();
    const std::size_t n = std::min<std::size_t>(report.size(), WiimoteCommon::MAX_PAYLOAD - 1);
    buf[0] = 0xa1;  // HID DATA | INPUT
    std::memcpy(buf + 1, report.data(), n);
    return static_cast<int>(n + 1);
  }
  int IOWrite(const u8* buf, std::size_t len) override
  {
    if (len < 2)
      return 0;
    auto& s = s_hid_slots[m_slot];
    const std::lock_guard lock(s.mutex);
    if (!s.attached)
      return 0;
    // Drop the 0xa2 (HID DATA | OUTPUT) header: WebHID wants report id + payload.
    s.writes.emplace_back(buf + 1, buf + len);
    if (s.writes.size() > 256)
      s.writes.pop_front();
    return static_cast<int>(len);
  }

private:
  int m_slot;
};

class WebHidScanner final : public WiimoteReal::WiimoteScannerBackend
{
public:
  void Update() override {}
  void RequestStopSearching() override {}
  FindResults FindAttachedWiimotes() override
  {
    FindResults results;
    for (int i = 0; i < HID_SLOTS; ++i)
    {
      bool attached;
      {
        const std::lock_guard lock(s_hid_slots[i].mutex);
        attached = s_hid_slots[i].attached;
      }
      if (attached && WiimoteReal::IsNewWiimote("WebHID/" + std::to_string(i)))
        results.wii_remotes.emplace_back(std::make_unique<WebHidWiimote>(i));
    }
    return results;
  }
};
}  // namespace DolphinWebWii

namespace DolphinWebWii
{
inline void ApplyHidSources()
{
  for (int i = 0; i < HID_SLOTS; ++i)
  {
    bool attached;
    {
      const std::lock_guard lock(s_hid_slots[i].mutex);
      attached = s_hid_slots[i].attached;
    }
    const WiimoteSource want =
        attached ? WiimoteSource::Real : (i == 0 ? WiimoteSource::Emulated : WiimoteSource::None);
    if (Config::Get(Config::GetInfoForWiimoteSource(i)) != want)
      Config::SetBaseOrCurrent(Config::GetInfoForWiimoteSource(i), want);
  }
}
}  // namespace DolphinWebWii

// Called by WiimoteReal's scanner thread (patch 0068) to add this backend.
std::unique_ptr<WiimoteReal::WiimoteScannerBackend> DolphinWeb_CreateWiimoteScanner()
{
  return std::make_unique<DolphinWebWii::WebHidScanner>();
}

extern "C"
{
// A remote appeared on (attached=1) or left (0) a WebHID slot. While any
// real remote is attached, Wii Remote slots 1..n use it; the emulated
// remote (keyboard/mouse/gamepad) comes back when it is unplugged.
EMSCRIPTEN_KEEPALIVE void WebHidAttach(int slot, int attached)
{
  if (slot < 0 || slot >= DolphinWebWii::HID_SLOTS)
    return;
  auto& s = DolphinWebWii::s_hid_slots[slot];
  {
    const std::lock_guard lock(s.mutex);
    s.attached = attached != 0;
    s.reads.clear();
    s.writes.clear();
  }
  s.cv.notify_all();

  // Before CoreInit, Config is not up yet; Initialize() applies it later.
  if (DolphinWebWii::s_config_ready)
    DolphinWebWii::ApplyHidSources();
  EM_ASM({ console.info('[wii] WebHID slot ' + $0 + (($1) ? ' attached' : ' detached')); }, slot,
         attached);
}

EMSCRIPTEN_KEEPALIVE void WebHidPushReport(int slot, const u8* data, int length)
{
  if (slot < 0 || slot >= DolphinWebWii::HID_SLOTS || !data || length <= 0 || length > 64)
    return;
  auto& s = DolphinWebWii::s_hid_slots[slot];
  {
    const std::lock_guard lock(s.mutex);
    if (!s.attached)
      return;
    s.reads.emplace_back(data, data + length);
    if (s.reads.size() > 64)
      s.reads.pop_front();
  }
  s.cv.notify_all();
}

// Moves the next pending write for a slot into WebHidWriteBuffer() and
// returns its length (report id + payload), or 0 when there is none.
EMSCRIPTEN_KEEPALIVE int WebHidPopWrite(int slot)
{
  if (slot < 0 || slot >= DolphinWebWii::HID_SLOTS)
    return 0;
  auto& s = DolphinWebWii::s_hid_slots[slot];
  const std::lock_guard lock(s.mutex);
  if (s.writes.empty())
    return 0;
  const std::vector<u8> report = std::move(s.writes.front());
  s.writes.pop_front();
  const std::size_t n = std::min(report.size(), DolphinWebWii::s_hid_write_buffer.size());
  std::memcpy(DolphinWebWii::s_hid_write_buffer.data(), report.data(), n);
  return static_cast<int>(n);
}

EMSCRIPTEN_KEEPALIVE const u8* WebHidWriteBuffer()
{
  return DolphinWebWii::s_hid_write_buffer.data();
}
}
