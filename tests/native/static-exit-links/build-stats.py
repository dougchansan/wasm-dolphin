from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json
import re
import subprocess

OWN = Path(__file__).resolve().parent
cpp = (SOURCE / 'CachedInterpreter.cpp').read_text(encoding='utf8')
begin = cpp.index('extern "C" const char* GetPpcWasmHelperStats()')
end = cpp.index('  std::vector<std::pair<u32, u32>> hot_keys;', begin)
prefix = cpp[begin:end]
names = sorted(set(re.findall(r'\bs_(?:wasm|fast)_[a-z0-9_]+', prefix)))
decls = '\n'.join('u32 ' + name + ' = 0;' for name in names)
getter = prefix + '''  std::ostringstream out;
#if DOLPHIN_WEB_STATIC_EXIT_LINKS && DOLPHIN_WEB_STATIC_EXIT_LINK_STATS
  StaticExitLinks::Stats::Format(out, static_link_snapshot);
#endif
  stats = out.str();
  return stats.c_str();
}
'''
template = (OWN / 'stats.template.cpp').read_text(encoding='utf8')
template = template.replace('/* COUNTERS */', decls).replace('/* ACTUAL_GETTER_CACHE_PREFIX */', getter)
file = OWN / 'stats.cpp'; file.write_text(template, encoding='utf8')
compiler = COMPILER
build = subprocess.run([compiler, '-std=c++20', '-O2', *NATIVE_FLAGS, '-Wall', '-Wextra', '-DDOLPHIN_WEB_STATIC_EXIT_LINKS=1',
    '-DDOLPHIN_WEB_STATIC_EXIT_LINK_STATS=1', str(file), '-o', str(OWN / 'stats.exe')], capture_output=True, text=True, timeout=60)
(OWN / 'stats-build.log').write_text(build.stdout + build.stderr, encoding='utf8')
if build.returncode: print(build.stdout + build.stderr)
build.check_returncode()
run = subprocess.run([str(OWN / 'stats.exe')], capture_output=True, text=True, timeout=30)
(OWN / 'stats-run.log').write_text(run.stdout + run.stderr, encoding='utf8')
preprocess_file = OWN / 'stats-preprocess.cpp'
preprocess_file.write_text(template[:template.index('std::vector<std::string> passed, failed;')], encoding='utf8')
macro_checks = []
for links, stats in [(0, 0), (1, 0), (1, 1)]:
    processed = subprocess.run([compiler, '-std=c++20', '-E', *NATIVE_FLAGS, '-P', f'-DDOLPHIN_WEB_STATIC_EXIT_LINKS={links}',
        f'-DDOLPHIN_WEB_STATIC_EXIT_LINK_STATS={stats}', str(preprocess_file)], capture_output=True, text=True, timeout=60)
    processed.check_returncode()
    present = 'class Stats' in processed.stdout or 'StaticExitLinks::Stats' in processed.stdout
    assert present == bool(links and stats), 'Stats leaked across compile-time gate'
    macro_checks.append({'links': links, 'stats': stats, 'statsPresent': present})
result = {'headerSha256': hashlib.sha256((SOURCE / 'CachedInterpreterLink.h').read_bytes()).hexdigest(),
          'sourceSha256': hashlib.sha256((SOURCE / 'CachedInterpreter.cpp').read_bytes()).hexdigest(),
          'exitCode': run.returncode, 'results': json.loads(run.stdout) if run.stdout.startswith('{') else run.stdout,
          'macroChecks': macro_checks,
          'scope': 'Actual Stats class plus exact production getter cache-prefix and Stats formatter; unrelated helper formatting replaced with empty text, old counters held fixed.'}
(OWN / 'stats-result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
print(json.dumps(result, indent=2)); run.check_returncode()
