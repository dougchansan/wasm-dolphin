from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json
import runpy
import subprocess

OWN = Path(__file__).resolve().parent
PPC = ROOT / 'vendor/dolphin/Source/Core/Core/PowerPC'
# Rebuild the exact cache/emitter prerequisite, then reuse its source selectors.
utilities = runpy.run_path(str(OWN / 'build-cache.py'))
enabled, disabled, function, structure = (utilities[name] for name in ('enabled', 'disabled', 'function', 'structure'))
candidate = enabled((SOURCE / 'CachedInterpreter.cpp').read_text(encoding='utf8'))
header = enabled((SOURCE / 'CachedInterpreter.h').read_text(encoding='utf8'))
# After promotion vendor contains the candidate. Derive the differential reference
# from its explicit macro-0 arms, never from raw vendor text compiled under gate 1.
original = disabled((SOURCE / 'CachedInterpreter.cpp').read_text(encoding='utf8'))
original_header = disabled((SOURCE / 'CachedInterpreter.h').read_text(encoding='utf8'))
disasm = enabled((SOURCE / 'CachedInterpreter_Disassembler.cpp').read_text(encoding='utf8'))
gekko = (PPC / 'Gekko.h').read_text(encoding='utf8')
union = structure(gekko, 'union UGeckoInstruction\n')
signext = '\n'.join(function(gekko, marker) for marker in ['constexpr s32 SignExt16(', 'constexpr s32 SignExt26('])
operand_names = ['FastInstructionOperands', 'FastBranchBdnzOperands', 'CheckHaltOperands', 'WasmBlockOperands']
candidate_operands = '\n'.join(structure(header, 'struct CachedInterpreter::' + name + '\n') for name in operand_names)
original_operands = '\n'.join(structure(original_header, 'struct CachedInterpreter::' + name + '\n') for name in operand_names)
original_operands += '\ntemplate <>\n' + structure(original_header, 'struct CachedInterpreter::EndBlockOperands<false>')
original_operands += '\ntemplate <>\n' + structure(original_header, 'struct CachedInterpreter::EndBlockOperands<true>')
original_operands = original_operands.replace('CachedInterpreter::', 'BaselineInterpreter::')
assert 'StaticExitLinks::Descriptor' not in original_operands, 'Macro-0 reference retained link operands'
assert 'StaticExitLinks::Descriptor' in candidate_operands, 'Macro-1 candidate lost link operands'
markers = [
    'DOLPHIN_WEB_FAST_BRANCH_INLINE s32 CachedInterpreter::FastBranch(',
    's32 CachedInterpreter::FastBranchBdnz(',
    's32 CachedInterpreter::CheckFPU(',
    'DOLPHIN_WEB_DIRECT_WASM_BLOCK_INLINE s32 CachedInterpreter::RunWasmBlock(',
]


def abi_adapt(body):
    if 'using WasmBlockFunction' in body:
        body = body.replace('  using WasmBlockFunction = int (*)(int);\n', '')
        begin = body.index('  const int halted =')
        end = body.index(';\n', begin) + 1
        body = body[:begin] + '  const int halted = NativeWasmInvoke(operands.handle, ppc_state);' + body[end:]
    return body


candidate_methods = '\n'.join(abi_adapt(function(candidate, marker)) for marker in markers)
baseline_methods = '\n'.join(abi_adapt(function(original, marker)) for marker in markers)
baseline_methods += '\n' + function(original, 'template <bool profiled>\ns32 CachedInterpreter::EndBlock(PowerPC::PowerPCState&')
baseline_methods = baseline_methods.replace('CachedInterpreter::', 'BaselineInterpreter::')
assert 'StaticExitLinks::Publish' not in baseline_methods, 'Reference accidentally uses enabled publication'
assert 'StaticExitLinks::Publish' in candidate_methods, 'Candidate publication seam is absent'
wasm_body = function(candidate, 'bool CachedInterpreter::TryWriteWasmBlock(')
begin = wasm_body.index('  const bool fuse_end_block =')
end = wasm_body.index('\n\n  if (fuse_end_block)', begin)
wasm_emission = wasm_body[begin:end]
wasm_disasm = function(disasm, 's32 CachedInterpreter::RunWasmBlock(std::ostream&')
cache = (OWN / 'cache.cpp').read_text(encoding='utf8')
cache = cache.replace('int main()\n', 'int CacheFixtureMain()\n')
state_old = 'namespace PowerPC { struct PowerPCState { u32 pc = 0, npc = 0; s32 downcount = 100; std::vector<std::string> effects; }; }'
state_new = (OWN / 'callback-state.inc').read_text(encoding='utf8')
assert state_old in cache
cache = cache.replace(state_old, state_new)
decl = (OWN / 'callback-declarations.inc').read_text(encoding='utf8')
anchor = '  template<bool> struct EndBlockOperands;'
cache = cache.replace(anchor, decl + '\n' + anchor, 1)
prelude = union + '\n' + signext + '\nconstexpr u32 BO_DONT_DECREMENT_FLAG = 4;\n'
cache = cache.replace('struct JitBlock\n', prelude + '\nstruct JitBlock\n', 1)
operands_anchor = 'template <>\nstruct CachedInterpreter::EndBlockOperands<false>'
cache = cache.replace(operands_anchor, candidate_operands + '\n' + operands_anchor, 1)
extra = (OWN / 'callback.template.cpp').read_text(encoding='utf8')
for key, value in {
    'CANDIDATE_METHODS': candidate_methods, 'BASELINE_OPERANDS': original_operands,
    'BASELINE_METHODS': baseline_methods, 'WASM_EMISSION': wasm_emission, 'WASM_DISASSEMBLY': wasm_disasm,
}.items(): extra = extra.replace('/* ' + key + ' */', value)
cpp = OWN / 'callbacks.cpp'; cpp.write_text(cache + '\n' + extra, encoding='utf8')
inputs = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [SOURCE / 'CachedInterpreter.cpp', SOURCE / 'CachedInterpreter.h', SOURCE / 'CachedInterpreterLink.h']}
build = subprocess.run([COMPILER, '-std=c++20', '-O2', *NATIVE_FLAGS, '-Wall', '-Wextra',
    '-DDOLPHIN_WEB_STATIC_EXIT_LINKS=1', str(cpp), '-o', str(OWN / 'callbacks.exe')], capture_output=True, text=True, timeout=60)
(OWN / 'callbacks-build.log').write_text(build.stdout + build.stderr, encoding='utf8')
if build.returncode: print(build.stdout + build.stderr)
build.check_returncode()
run = subprocess.run([str(OWN / 'callbacks.exe')], capture_output=True, text=True, timeout=30)
(OWN / 'callbacks-run.log').write_text(run.stdout + run.stderr, encoding='utf8')
result = {'inputs': inputs, 'exitCode': run.returncode, 'results': json.loads(run.stdout) if run.stdout.startswith('{') else run.stdout,
          'referenceMode': 'explicit macro-0 view of actual promoted vendor source',
          'referenceViewSha256': hashlib.sha256((original + original_header).encode()).hexdigest(),
          'candidateViewSha256': hashlib.sha256((candidate + header).encode()).hexdigest(),
          'ABIAdapter': 'Only the WASM handle->function/state i32 ABI call is replaced with NativeWasmInvoke(handle,state&) for native x64; actual halt/end/accounting/publication and original/new operand layouts retained.',
          'scope': 'Actual original/candidate branch, CheckFPU, EndBlock, RunWasmBlock methods; actual fused emission metadata/write/registration and disassembly callbacks. Specialized helpers and redispatch loop gates are covered separately in helpers-result.json and gates-result.json.'}
result['inputsUnchanged'] = all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == sha for path, sha in inputs.items())
(OWN / 'callbacks-result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
print(json.dumps(result, indent=2)); assert result['inputsUnchanged']; run.check_returncode()
