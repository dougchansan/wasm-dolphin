  struct FastInstructionOperands; struct FastBranchBdnzOperands; struct CheckHaltOperands; struct WasmBlockOperands;
  static s32 FastBranch(PowerPC::PowerPCState&, const FastInstructionOperands&);
  static s32 FastBranchBdnz(PowerPC::PowerPCState&, const FastBranchBdnzOperands&);
  static s32 CheckFPU(PowerPC::PowerPCState&, const CheckHaltOperands&);
  static s32 RunWasmBlock(PowerPC::PowerPCState&, const WasmBlockOperands&);
  static s32 RunWasmBlock(std::ostream&, const WasmBlockOperands&);
  struct CodeOp { UGeckoInstruction inst; u32 address; bool skip = false, canEndBlock = true; };
  void EmitWasmForTest(bool did_merge, bool compiled_entire_block, bool compiled_block_ends_with_branch,
                      bool write_npc, u32 block_next_pc, const std::vector<CodeOp>& ops);

