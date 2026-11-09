"""Capture installed schema definitions without running tests or opening a result bundle."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
records = []
for kind in ['summary', 'tests']:
    command = ['xcrun', 'xcresulttool', 'get', 'test-results', kind, '--schema', '--schema-version', '0.5.0']
    result = subprocess.run(command, capture_output=True, check=True, timeout=20)
    json.loads(result.stdout)
    target = root / 'tests/fixtures' / ('xcresult-' + kind + '-0.5.0.schema.json')
    target.write_bytes(result.stdout)
    records.append({'argv': command, 'path': str(target.relative_to(root)), 'sha256': hashlib.sha256(result.stdout).hexdigest()})
print(json.dumps(records))
