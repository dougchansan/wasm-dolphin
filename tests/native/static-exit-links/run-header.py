from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json
import subprocess

OWN = Path(__file__).resolve().parent
HEADER = SOURCE / 'CachedInterpreterLink.h'
before = HEADER.read_bytes()
exe = OWN / 'test-header.exe'
build = subprocess.run([COMPILER,
    '-std=c++20', '-O2', *NATIVE_FLAGS, '-Wall', '-Wextra', '-DDOLPHIN_WEB_STATIC_EXIT_LINKS=1',
    str(OWN / 'test-header.cpp'), '-o', str(exe)], capture_output=True, text=True, timeout=60)
(OWN / 'header-build.log').write_text(build.stdout + build.stderr, encoding='utf8')
build.check_returncode()
run = subprocess.run([str(exe)], capture_output=True, text=True, timeout=30)
(OWN / 'header-run.log').write_text(run.stdout + run.stderr, encoding='utf8')
report = {'headerSha256': hashlib.sha256(before).hexdigest(), 'headerUnchanged': HEADER.read_bytes() == before,
          'exitCode': run.returncode, 'results': json.loads(run.stdout) if run.stdout.startswith('{') else run.stdout,
          'scope': 'Actual descriptor/decoder/context/resolver API only. Full callback/cache/emitter integration remains separate.'}
(OWN / 'header-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2))
assert report['headerUnchanged'], 'header changed during native validation'
run.check_returncode()
