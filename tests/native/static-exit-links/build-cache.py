from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS, select_link_gates
import hashlib
import json
import subprocess

OWN = Path(__file__).resolve().parent
PPC = ROOT / 'vendor/dolphin/Source/Core/Core/PowerPC'


def enabled(text):
    return select_link_gates(text, links=True, stats=False)


def disabled(text):
    return select_link_gates(text, links=False, stats=False)


def function(text, marker):
    begin = text.index(marker)
    return text[begin:text.index('\n}', begin) + 2]


def structure(text, marker):
    begin = text.index(marker)
    return text[begin:text.index('\n};', begin) + 3]


paths = [SOURCE / name for name in ['CachedInterpreter.h', 'CachedInterpreter.cpp',
         'CachedInterpreterBlockCache.h', 'CachedInterpreterBlockCache.cpp', 'CachedInterpreterLink.h',
         'CachedInterpreter_Disassembler.cpp']]
contents = {p.name: enabled(p.read_text(encoding='utf8')) for p in paths}
base = json.loads((OWN / 'base-methods.json').read_text(encoding='utf8'))
emitter_header = (PPC / 'CachedInterpreter/CachedInterpreterEmitter.h').read_text(encoding='utf8')
emitter = structure(emitter_header, 'class CachedInterpreterEmitter\n')
cache_class = structure(contents['CachedInterpreterBlockCache.h'], 'class CachedInterpreterBlockCache final')
cache_cpp = contents['CachedInterpreterBlockCache.cpp']
cache_cpp = cache_cpp[cache_cpp.index('CachedInterpreterBlockCache::CachedInterpreterBlockCache('):]
cpp = contents['CachedInterpreter.cpp']; header = contents['CachedInterpreter.h']
end_false = structure(header, 'struct CachedInterpreter::EndBlockOperands<false>')
end_true = structure(header, 'struct CachedInterpreter::EndBlockOperands<true>')
methods = '\n\n'.join(function(cpp, marker) for marker in [
    'bool CachedInterpreter::StaticExitLinksEnabled() const',
    'void CachedInterpreter::RegisterStaticExitLinks(',
    'void CachedInterpreter::WriteEndBlock(',
    'template <bool profiled>\ns32 CachedInterpreter::EndBlock(PowerPC::PowerPCState&',
    'void CachedInterpreter::FreeRanges()',
    'void CachedInterpreter::ResetFreeMemoryRanges()',
    'void CachedInterpreter::ClearCache()',
])
deferred = function(cpp, 'void RetryDeferredWasmBlocks(')
base_header = (PPC / 'JitCommon/JitCache.h').read_text(encoding='utf8')
link_begin = base_header.index('  struct LinkData\n')
link_data = base_header[link_begin:base_header.index('\n  };', link_begin) + 5]
disasm = contents['CachedInterpreter_Disassembler.cpp']
disasm_helper = function(disasm, 'void DisassembleStaticExitLinks(')
disasm_end = function(disasm, 'template <bool profiled>\ns32 CachedInterpreter::EndBlock(std::ostream&')
replacements = {
    'EMITTER_CLASS': emitter, 'EMITTER_WRITE': base['EmitterWrite'], 'CACHE_CLASS': cache_class,
    'CACHE_METHODS': cache_cpp, 'END_OPERANDS': 'template <>\n' + end_false + '\n\ntemplate <>\n' + end_true,
    'INTERPRETER_METHODS': methods, 'DISASSEMBLY_METHODS': disasm_helper + '\n' + disasm_end,
    'BASE_METHODS': '\n\n'.join(value for name, value in base.items() if name not in ['FinalizeLinkRegistration', 'EmitterWrite', 'ClearSafe']),
    'REGISTER_LINKS': base['FinalizeLinkRegistration'], 'CLEAR_SAFE': base['ClearSafe'],
    'LINK_DATA': link_data, 'DEFERRED_RETRY': deferred,
}
template = (OWN / 'cache.template.cpp').read_text(encoding='utf8')
for key, value in replacements.items(): template = template.replace(f'/* {key} */', value)
assert '/* ' not in template or not any('/* '+key+' */' in template for key in replacements)
generated = OWN / 'cache.cpp'; generated.write_text(template, encoding='utf8')
inputs = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
exe = OWN / 'cache.exe'
build = subprocess.run([COMPILER, '-std=c++20', '-O2', *NATIVE_FLAGS,
    '-Wall', '-Wextra', '-DDOLPHIN_WEB_STATIC_EXIT_LINKS=1', str(generated), '-o', str(exe)],
    capture_output=True, text=True, timeout=60)
(OWN / 'cache-build.log').write_text(build.stdout + build.stderr, encoding='utf8')
if build.returncode: print(build.stdout + build.stderr)
build.check_returncode()
run = subprocess.run([str(exe)], capture_output=True, text=True, timeout=30)
(OWN / 'cache-run.log').write_text(run.stdout + run.stderr, encoding='utf8')
report = {'inputs': inputs, 'exitCode': run.returncode, 'results': json.loads(run.stdout) if run.stdout.startswith('{') else run.stdout,
          'adapters': ['Minimal JitBlock/map/MMU/platform register containers; actual LinkData declaration layout and all base link/unlink/destroy/erase/clear bodies.',
                       'Actual emitter class/Write, candidate cache class/methods, RegisterStaticExitLinks/WriteEndBlock and EndBlock/disassembly bodies.',
                       'PPC/profiler/formatting stubs record accounting calls; full PowerPC execution is tested separately.']}
report['inputsUnchanged'] = all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == sha for p, sha in inputs.items())
(OWN / 'cache-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2)); assert report['inputsUnchanged']; run.check_returncode()
