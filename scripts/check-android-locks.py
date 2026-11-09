"""Reject missing and changed locks in a private host copy."""
from pathlib import Path
import subprocess

host = Path(__file__).resolve().parents[1] / 'tests/native/android'
lock = host / 'app/gradle.lockfile'
original = lock.read_bytes()
command = [str(host / 'gradlew'), '--no-daemon', '--offline', '--console=plain',
           '--dependency-verification=strict', ':app:checkDebugAarMetadata', '--rerun-tasks']
try:
    for name, content in [('missing', None), ('changed', original.replace(b'io.livekit:livekit-android:2.29.0=', b'io.livekit:livekit-android:0.0.0='))]:
        if content is None:
            lock.unlink()
        else:
            assert content != original
            lock.write_bytes(content)
        result = subprocess.run(command, cwd=host, capture_output=True, timeout=180)
        output = result.stdout + result.stderr
        print(name, output.decode(errors='replace'))
        assert result.returncode != 0, name + ' lock was accepted'
        assert b'lock' in output.lower(), 'Failure did not identify lock rejection'
finally:
    lock.write_bytes(original)
