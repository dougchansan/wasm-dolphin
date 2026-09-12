from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json

OWN = Path(__file__).resolve().parent
PPC = ROOT / 'vendor/dolphin/Source/Core/Core/PowerPC'


def function(source, marker):
    begin = source.index(marker)
    end = source.index('\n}', begin) + 2
    return source[begin:end]


base_path = PPC / 'JitCommon/JitCache.cpp'
base = base_path.read_text(encoding='utf8')
names = ['GetBlockFromStartAddress', 'LinkBlockExits', 'LinkBlock', 'UnlinkBlock',
         'DestroyBlock', 'EraseSingleBlock', 'ErasePhysicalRange', 'Clear']
methods = {name: function(base, ('JitBlock* ' if name == 'GetBlockFromStartAddress' else 'void ') +
                          'JitBaseBlockCache::' + name + '(') for name in names}
finalize = function(base, 'void JitBaseBlockCache::FinalizeBlock(')
begin = finalize.index('  if (block_link)')
end = finalize.index('\n\n  const Common::Symbol*', begin)
methods['FinalizeLinkRegistration'] = finalize[begin:end]
emitter_path = PPC / 'CachedInterpreter/CachedInterpreterEmitter.cpp'
emitter = emitter_path.read_text(encoding='utf8')
methods['EmitterWrite'] = function(emitter, 'void CachedInterpreterEmitter::Write(')
interface_path = PPC / 'JitInterface.cpp'
interface = interface_path.read_text(encoding='utf8')
methods['ClearSafe'] = function(interface, 'void JitInterface::ClearSafe()')
(OWN / 'base-methods.json').write_text(json.dumps(methods, indent=2) + '\n', encoding='utf8')
(OWN / 'base-extraction.json').write_text(json.dumps({
    'sources': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [base_path, emitter_path, interface_path]},
    'methods': list(methods),
    'scope': 'Exact unchanged algorithms. Fixture adapters may simplify MMU/platform containers, but must not replace linking, unlinking, destroy, erase or clear bodies.',
}, indent=2) + '\n', encoding='utf8')
print('Extracted real base linker/unlink/invalidation/clear and emitter algorithms')
