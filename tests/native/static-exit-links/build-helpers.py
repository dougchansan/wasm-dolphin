from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json
import re
import runpy
import subprocess

OWN = Path(__file__).resolve().parent
utilities = runpy.run_path(str(OWN / 'build-callbacks.py'))
candidate, header, original, original_header, disasm = (utilities[k] for k in ('candidate', 'header', 'original', 'original_header', 'disasm'))
function, structure = utilities['function'], utilities['structure']
source = (OWN / 'callbacks.cpp').read_text(encoding='utf8').replace('int main()\n', 'int CallbackFixtureMain()\n')
extra_state = (OWN / 'helper-state.inc').read_text(encoding='utf8')
source = source.replace('  std::vector<std::string> effects;\n', extra_state + '\n  std::vector<std::string> effects;\n', 1)
names = ['MeleeIdlePollLoopOperands', 'MeleeTitleLoopOperands', 'OsInterruptFunctionOperands']
declarations = ''.join('  struct ' + name + ';\n' for name in names)
declarations += ''.join('  static s32 ' + name + '(PowerPC::PowerPCState&, const ' + operand + '&);\n'
                       for name, operand in zip(['FastMeleeIdlePollLoop', 'FastMeleeTitleLoop', 'FastOsInterruptCallBranch'], names))
source = source.replace('  struct FastInstructionOperands;', declarations + '  struct FastInstructionOperands;')
source = source.replace('  bool debug = false,', '''  static s32 FastMeleeIdlePollLoop(std::ostream&, const MeleeIdlePollLoopOperands&);
  static s32 FastMeleeTitleLoop(std::ostream&, const MeleeTitleLoopOperands&);
  void EmitIdleForTest(PowerPC::PowerPCManager& power_pc, u32 cycles, u32 loadstores);
  void EmitTitleForTest(PowerPC::PowerPCManager& power_pc, u32 cycles, u32 loadstores, u32 fp_inst);
  bool debug = false,''', 1)
new_operands = '\n'.join(structure(header, 'struct CachedInterpreter::' + name + '\n') for name in names)
old_operands = '\n'.join(structure(original_header, 'struct CachedInterpreter::' + name + '\n') for name in names).replace('CachedInterpreter::', 'BaselineInterpreter::')
source = source.replace('template <>\nstruct CachedInterpreter::EndBlockOperands<false>', new_operands + '\n\ntemplate <>\nstruct CachedInterpreter::EndBlockOperands<false>', 1)
source = source.replace('struct BaselineInterpreter::FastInstructionOperands', old_operands + '\nstruct BaselineInterpreter::FastInstructionOperands', 1)
method_names = ['FastMeleeIdlePollLoop', 'FastMeleeTitleLoop', 'FastOsInterruptCallBranch']
new_methods = '\n'.join(function(candidate, 's32 CachedInterpreter::' + name + '(PowerPC::PowerPCState&') for name in method_names)
old_methods = '\n'.join(function(original, 's32 CachedInterpreter::' + name + '(PowerPC::PowerPCState&') for name in method_names).replace('CachedInterpreter::', 'BaselineInterpreter::')
disasm_methods = '\n'.join(function(disasm, 's32 CachedInterpreter::' + name + '(std::ostream&') for name in method_names[:2])
counter_names = sorted(set(re.findall(r'\bs_fast_[a-z0-9_]+', old_methods + new_methods)))
constants = []
for name in ['MELEE_IDLE_POLL_LOOP_PC', 'MELEE_IDLE_POLL_LOOP_END_PC', 'MELEE_IDLE_POLL_LOOP_NO_EXIT_THROTTLE_BLOCKS',
             'MELEE_IDLE_POLL_LOOP_MAX_BATCH', 'OS_INTERRUPT_DISABLE', 'OS_INTERRUPT_RESTORE', 'MSR_EE_MASK',
             'OS_INTERRUPT_RESTORE_ENABLE_CYCLES', 'OS_INTERRUPT_RESTORE_DISABLE_CYCLES']:
    found = re.search(r'^(?:static )?constexpr (?:u32|s32) ' + name + r'\s*=.*?;', original, re.M | re.S)
    assert found, name
    constants.append(found[0])
counter_decl = '\n'.join('u32 ' + name + ' = 0;' for name in counter_names)
reset = '\n'.join('  ' + name + ' = 0;' for name in counter_names)
snapshot = 'return {' + ', '.join(counter_names) + '};'
idle_writer = function(candidate, 'bool CachedInterpreter::TryWriteMeleeIdlePollLoop(')
idle_writer = idle_writer[idle_writer.index('  auto static_links ='):idle_writer.index('\n  return true;')]
title_writer = function(candidate, 'bool CachedInterpreter::TryWriteMeleeTitleLoop(')
title_emission = title_writer[title_writer.index('  auto static_links ='):title_writer.index('\n  return true;')]
title_constants = '\n'.join(re.findall(r'  constexpr u32 loop_(?:start|end) = [^;]+;', title_writer))
extra = (OWN / 'helper.template.cpp').read_text(encoding='utf8')
for key, value in {'CONSTANTS': '\n'.join(constants), 'COUNTERS': counter_decl,
                   'RESET_COUNTERS': reset, 'SNAPSHOT_COUNTERS': snapshot,
                   'ORIGINAL_HELPERS': old_methods, 'CANDIDATE_HELPERS': new_methods,
                   'DISASSEMBLY': disasm_methods, 'IDLE_EMISSION': idle_writer,
                   'TITLE_EMISSION': title_constants + '\n' + title_emission}.items():
    extra = extra.replace('/* ' + key + ' */', value)
cpp = OWN / 'helpers.cpp'; cpp.write_text(source + '\n' + extra, encoding='utf8')
build = subprocess.run([COMPILER, '-std=c++20', '-O2', *NATIVE_FLAGS, '-Wall', '-Wextra',
    '-DDOLPHIN_WEB_STATIC_EXIT_LINKS=1', str(cpp), '-o', str(OWN / 'helpers.exe')], capture_output=True, text=True, timeout=60)
(OWN / 'helpers-build.log').write_text(build.stdout + build.stderr, encoding='utf8')
if build.returncode: print(build.stdout + build.stderr)
build.check_returncode()
run = subprocess.run([str(OWN / 'helpers.exe')], capture_output=True, text=True, timeout=30)
(OWN / 'helpers-run.log').write_text(run.stdout + run.stderr, encoding='utf8')
report = {'sourceSha256': hashlib.sha256((SOURCE / 'CachedInterpreter.cpp').read_bytes()).hexdigest(),
          'exitCode': run.returncode, 'results': json.loads(run.stdout) if run.stdout.startswith('{') else run.stdout,
          'scope': 'Actual original/candidate complete idle/title callbacks, actual emitted operand layouts and registration tail, actual disassembly callbacks.',
          'adapters': 'Deterministic RAM/config/FP primitive stubs shared by both variants; compares PPC state, RAM, accounting and helper counters. Not an independent validation of underlying floating-point primitive accuracy.'}
(OWN / 'helpers-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2)); run.check_returncode()
