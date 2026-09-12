#define NOMINMAX
#include "test-platform.h"
#include <array>
#include <atomic>
#include <cstring>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include "CachedInterpreterLink.h"

namespace L = StaticExitLinks;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
std::vector<std::string> passed, failed;
void group(const char* name, const std::function<void()>& test)
{
  try { test(); passed.emplace_back(name); }
  catch (const std::exception& e) { failed.push_back(std::string(name) + ": " + e.what()); }
}
std::vector<L::U32> pcs(const L::Descriptor& d)
{
  std::vector<L::U32> result;
  for (unsigned i = 0; i < d.count; ++i) result.push_back(d.cells[i].pc);
  return result;
}
L::U32 direct(int displacement, bool absolute = false, bool call = false)
{ return (18u << 26) | (L::U32(displacement) & 0x03fffffcu) | (unsigned(absolute) << 1) | call; }
L::U32 conditional(int displacement, unsigned bo, bool absolute = false, bool call = false)
{ return (16u << 26) | (bo << 21) | (L::U32(displacement) & 0xfffcu) | (unsigned(absolute) << 1) | call; }
L::U32 indirect(unsigned xo, unsigned bo, bool call = false)
{ return (19u << 26) | (bo << 21) | (xo << 1) | call; }

int main()
{
  group("BeginBlock clears stale completion while preserving TLS and current owner", [] {
    int owner = 0, state = 0, other_owner = 0; const std::uint8_t code[8]{};
    auto descriptor = L::Fallthrough(0x100); L::WriteEntry(&descriptor.cells[0], code);
    L::Scope scope(&owner, &state); auto* const active = L::active_context;
    scope.BeginBlock(10, 3); L::Publish(&state, &descriptor);
    require(scope.Resolve(&owner, &state, 10, 3, 0x100).entry == code, "first block resolves");
    scope.BeginBlock(10, 3);
    require(scope.Resolve(&owner, &state, 10, 3, 0x100).decision == L::Decision::NoCompletion,
            "early halt at same PC cannot borrow prior block descriptor");
    require(L::active_context == active && active->owner == &owner && active->state == &state,
            "BeginBlock must retain installed context and immutable identities");
    scope.BeginBlock(11, 4); L::Publish(&state, &descriptor);
    require(scope.Resolve(&owner, &state, 11, 4, 0x100).entry == code, "new block captures fresh feature/epoch");
    require(scope.Resolve(&owner, &state, 10, 4, 0x100).decision == L::Decision::EpochMismatch, "old epoch cannot resolve new block");
    require(scope.Resolve(&owner, &state, 11, 3, 0x100).decision == L::Decision::FeatureMismatch, "old features cannot resolve new block");
    require(scope.Resolve(&other_owner, &state, 11, 4, 0x100).decision == L::Decision::OwnerMismatch, "BeginBlock never changes cache owner");
  });
  group("BeginBlock drops a protected stale descriptor before the new block starts", [] {
    void* page = TestProtectedPage();
    require(page != nullptr, "protected descriptor allocation");
    int owner = 0, state = 0;
    { L::Scope scope(&owner, &state); scope.BeginBlock(1, 2);
      L::Publish(&state, static_cast<const L::Descriptor*>(page));
      require(scope.Resolve(&owner, &state, 2, 2, 0).decision == L::Decision::EpochMismatch, "old block rejected before protected dereference");
      scope.BeginBlock(2, 3);
      require(scope.Resolve(&owner, &state, 2, 3, 0).decision == L::Decision::NoCompletion, "new epoch cannot make an old descriptor readable"); }
    require(TestFreeProtectedPage(page) != 0, "protected descriptor release");
  });
  group("nested lean blocks restore parent completion and BeginBlock cannot reopen closed scope", [] {
    int owner = 0, state = 0, child_owner = 0, child_state = 0;
    const std::uint8_t parent_code[8]{}, child_code[8]{};
    auto parent_descriptor = L::Fallthrough(0x100); auto child_descriptor = L::Fallthrough(0x200);
    L::WriteEntry(&parent_descriptor.cells[0], parent_code); L::WriteEntry(&child_descriptor.cells[0], child_code);
    L::Scope parent(&owner, &state); parent.BeginBlock(1, 2); auto* const parent_active = L::active_context;
    L::Publish(&state, &parent_descriptor);
    { L::Scope child(&child_owner, &child_state); child.BeginBlock(3, 4); L::Publish(&child_state, &child_descriptor);
      require(child.Resolve(&child_owner, &child_state, 3, 4, 0x200).entry == child_code, "child resolves independently");
      child.BeginBlock(4, 5); require(child.Resolve(&child_owner, &child_state, 4, 5, 0x200).decision == L::Decision::NoCompletion, "child consecutive completion cleared");
      child.Close(); require(L::active_context == parent_active, "child close restores parent TLS");
      child.BeginBlock(5, 6); require(L::active_context == parent_active, "closed child is never reinstalled");
      require(child.Resolve(&child_owner, &child_state, 5, 6, 0x200).decision == L::Decision::NoCompletion, "closed child never reopens"); }
    require(parent.Resolve(&owner, &state, 1, 2, 0x100).entry == parent_code, "parent completion survives nested child");
    parent.BeginBlock(2, 3); require(parent.Resolve(&owner, &state, 2, 3, 0x100).decision == L::Decision::NoCompletion, "parent's own next block clears completion");
  });
  group("descriptor deduplicates cells and retains call qualification", [] {
    L::Descriptor d; L::Add(d, 0x100, false); L::Add(d, 0x100, true);
    require(d.count == 1 && d.cells[0].call == 1, "duplicate target must merge call flag");
    L::Add(d, 0x200); L::Add(d, 0x300);
    require(pcs(d) == std::vector<L::U32>{0x100, 0x200}, "two-cell capacity");
    require(!d.cells[0].entry && !d.cells[1].entry, "new cells are unresolved");
  });
  group("immediate b and bl decode signed AA and wrapping targets", [] {
    require(pcs(L::Branch(direct(-4), 0x100)) == std::vector<L::U32>{0xfc}, "relative negative branch");
    require(pcs(L::Branch(direct(-4, true), 0x100)) == std::vector<L::U32>{0xfffffffcu}, "absolute negative branch");
    require(pcs(L::Branch(direct(8), 0xfffffffcu)) == std::vector<L::U32>{4}, "relative 32-bit wrap");
    auto call = L::Branch(direct(0x100, false, true), 0x100);
    require(pcs(call) == std::vector<L::U32>{0x200, 0x104}, "bl includes callee and inline completion");
    require(call.cells[0].call && !call.cells[1].call, "taken-call versus continuation metadata");
    auto same = L::Branch(direct(4, false, true), 0x100);
    require(same.count == 1 && same.cells[0].call, "call/continuation duplicate");
    require(pcs(L::Branch(direct(0), 0x100)) == std::vector<L::U32>{0x100}, "self branch remains known");
  });
  group("bc and bcl include only immediate and fallthrough candidates", [] {
    for (unsigned bo = 0; bo < 32; ++bo)
      for (bool call : {false, true}) {
        auto d = L::Branch(conditional(-16, bo, false, call), 0x100);
        require(pcs(d) == std::vector<L::U32>{0xf0, 0x104}, "conditional candidates");
        require(d.cells[0].call == unsigned(call), "conditional call flag");
      }
    require(pcs(L::Branch(conditional(-4, 16, true), 0x100)) == std::vector<L::U32>{0xfffffffcu, 0x104}, "AA bc target");
    require(L::Branch(conditional(4, 16), 0x100).count == 1, "conditional duplicate continuation");
  });
  group("LR and CTR taken destinations are never inferred as static targets", [] {
    for (unsigned bo = 0; bo < 32; ++bo) {
      const bool conditioned = (bo & 0x14) != 0x14;
      require(L::Branch(indirect(16, bo), 0x100).count == unsigned(conditioned), "bclr static fallthrough qualification");
      require(L::Branch(indirect(528, bo), 0x100).count == unsigned(conditioned && (bo & 4)), "bcctr validity and fallthrough qualification");
    }
    require(L::Branch(indirect(50, 0), 0x100).count == 0, "rfi has no static target");
    require(L::Branch(17u << 26, 0x100).count == 0, "syscall has no static target");
    require(pcs(L::Fallthrough(0x1234)) == std::vector<L::U32>{0x1234}, "explicit emitted fallthrough");
  });
  group("cell writes modify only target entry bytes", [] {
    auto d = L::Branch(direct(8, false, true), 0x100);
    std::array<unsigned char, sizeof(d)> before{}; std::memcpy(before.data(), &d, sizeof(d));
    const std::uint8_t code[8]{};
    L::WriteEntry(&d.cells[0], code);
    const auto offset = reinterpret_cast<const unsigned char*>(&d.cells[0].entry) - reinterpret_cast<const unsigned char*>(&d);
    const auto* after = reinterpret_cast<const unsigned char*>(&d);
    for (std::size_t i = 0; i < sizeof(d); ++i)
      if (i < std::size_t(offset) || i >= std::size_t(offset) + sizeof(L::Entry)) require(before[i] == after[i], "immutable descriptor bytes changed");
    require(d.cells[0].entry == code && !d.cells[1].entry, "only selected cell linked");
    L::WriteEntry(&d.cells[0], nullptr); require(!d.cells[0].entry, "unlink clears cell");
  });
  group("matching completed descriptor resolves with all mismatch fallbacks", [] {
    int owner = 0, state = 0, other = 0; const std::uint8_t code[8]{};
    auto d = L::Fallthrough(0x100); L::WriteEntry(&d.cells[0], code);
    L::Scope scope(&owner, &state, 7, 3);
    require(scope.Resolve(&owner, &state, 7, 3, 0x100).decision == L::Decision::NoCompletion, "unpublished callback cannot link");
    L::Publish(&other, &d);
    require(scope.Resolve(&owner, &state, 7, 3, 0x100).decision == L::Decision::NoCompletion, "wrong PPC state cannot publish");
    L::Publish(&state, &d);
    require(scope.Resolve(&owner, &state, 7, 3, 0x100).entry == code, "matching cached link");
    require(scope.Resolve(&other, &state, 7, 3, 0x100).decision == L::Decision::OwnerMismatch, "owner guard");
    require(scope.Resolve(&owner, &other, 7, 3, 0x100).decision == L::Decision::OwnerMismatch, "PPC state guard");
    require(scope.Resolve(&owner, &state, 8, 3, 0x100).decision == L::Decision::EpochMismatch, "epoch guard");
    require(scope.Resolve(&owner, &state, 7, 4, 0x100).decision == L::Decision::FeatureMismatch, "full feature key guard");
    require(scope.Resolve(&owner, &state, 7, 3, 0x104).decision == L::Decision::NoTarget, "actual completed PC guard");
    L::WriteEntry(&d.cells[0], nullptr);
    require(scope.Resolve(&owner, &state, 7, 3, 0x100).decision == L::Decision::Unlinked, "uncached target falls back");
    scope.Close(); scope.Close();
    require(scope.Resolve(&owner, &state, 7, 3, 0x100).decision == L::Decision::NoCompletion, "closed scope cannot resolve");
  });
  group("epoch and identity guards precede protected descriptor dereference", [] {
    void* page = TestProtectedPage();
    require(page != nullptr, "protected page allocation");
    int owner = 0, state = 0, other = 0;
    { L::Scope scope(&owner, &state, 10, 3);
      L::Publish(&state, static_cast<const L::Descriptor*>(page));
      require(scope.Resolve(&owner, &state, 11, 3, 0).decision == L::Decision::EpochMismatch, "stale source must not dereference freed/reused descriptor");
      require(scope.Resolve(&other, &state, 10, 3, 0).decision == L::Decision::OwnerMismatch, "owner checked before cells");
      require(scope.Resolve(&owner, &state, 10, 4, 0).decision == L::Decision::FeatureMismatch, "features checked before cells"); }
    { L::Scope scope(&owner, &state, 10, 3, false); L::Publish(&state, static_cast<const L::Descriptor*>(page));
      require(scope.Resolve(&owner, &state, 10, 3, 0).decision == L::Decision::Disabled, "disabled consumption must not read descriptor"); }
    require(TestFreeProtectedPage(page) != 0, "protected page release");
  });
  group("epoch wrap fails closed permanently", [] {
    auto epoch = std::numeric_limits<L::U64>::max(); L::AdvanceEpoch(epoch); require(epoch == 0, "wrap becomes invalid epoch");
    L::AdvanceEpoch(epoch); require(epoch == 0, "invalid epoch never resurrects");
    int owner = 0, state = 0; auto d = L::Fallthrough(0x100);
    L::Scope scope(&owner, &state, 0, 3); L::Publish(&state, &d);
    require(scope.Resolve(&owner, &state, 0, 3, 0x100).decision == L::Decision::EpochMismatch, "zero/zero epochs still fail");
  });
  group("nested contexts isolate publishers and restore after close/unwind", [] {
    int owner = 0, state = 0, child_state = 0; const std::uint8_t code[8]{};
    auto d = L::Fallthrough(0x100); L::WriteEntry(&d.cells[0], code);
    require(L::active_context == nullptr, "previous scopes restored null context");
    L::Publish(&state, &d); require(L::active_context == nullptr, "direct no-context callback is a no-op");
    L::Scope outer(&owner, &state, 5, 3); auto* parent = L::active_context;
    try { L::Scope child(&owner, &child_state, 5, 3); L::Publish(&state, &d); L::Publish(&child_state, &d); throw std::runtime_error("unwind"); }
    catch (const std::runtime_error&) {}
    require(L::active_context == parent, "nested unwind restores parent");
    require(outer.Resolve(&owner, &state, 5, 3, 0x100).decision == L::Decision::NoCompletion, "child cannot complete parent");
    L::Publish(&state, &d); require(outer.Resolve(&owner, &state, 5, 3, 0x100).entry == code, "restored parent receives own publication");
  });
  group("execution context is thread-local even with identical PPC state address", [] {
    int owner = 0, state = 0; const std::uint8_t code[8]{}; auto d = L::Fallthrough(0x100); L::WriteEntry(&d.cells[0], code);
    L::Scope parent(&owner, &state, 5, 3); bool independent = false;
    std::thread host([&] {
      independent = L::active_context == nullptr;
      L::Publish(&state, &d);
      { L::Scope child(&owner, &state, 5, 3); L::Publish(&state, &d); independent &= child.Resolve(&owner, &state, 5, 3, 0x100).entry == code; }
      independent &= L::active_context == nullptr;
    }); host.join();
    require(independent, "thread owns independent active context");
    require(parent.Resolve(&owner, &state, 5, 3, 0x100).decision == L::Decision::NoCompletion, "host thread cannot publish into CPU scope");
  });
  std::cout << "{\"passed\":[";
  for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":[";
  for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "]}\n"; return failed.empty() ? 0 : 1;
}
