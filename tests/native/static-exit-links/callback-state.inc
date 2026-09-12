using u16 = std::uint16_t; using s16 = std::int16_t; using s8 = std::int8_t; using u64 = std::uint64_t;
namespace PowerPC {
struct PowerPCState {
  u32 pc = 0, npc = 0, Exceptions = 0, lr = 0, ctr = 0, feature_flags = 2;
  s32 downcount = 100;
  std::array<u32, 32> gpr{};
  struct MSR { bool FP = true, LE = false, PR = false; u32 Hex = 0; bool operator==(const MSR&) const = default; } msr;
  struct CR { std::array<u32, 32> bits{}; u32 GetBit(unsigned i) const { return bits.at(i); } bool operator==(const CR&) const = default; } cr;
  std::vector<std::string> effects;
  bool operator==(const PowerPCState&) const = default;
};
struct PowerPCManager { PowerPCState* state = nullptr; u32 exception_pc = 0x2000; void CheckExceptions() { if (state) state->pc = state->npc = exception_pc; } };
}
u32& LR(PowerPC::PowerPCState& state) { return state.lr; }
u32& CTR(PowerPC::PowerPCState& state) { return state.ctr; }
constexpr u32 EXCEPTION_FPU_UNAVAILABLE = 1;

