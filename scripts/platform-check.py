import importlib.util
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('media_native', root / 'implementation/verification/native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
context = native.read_context()
action = sys.argv[1]


def apple_paths():
    host = root / 'tests/native/apple'
    target = context['settings']['applePlatform']
    destination = {'ios-simulator':'phone', 'tvos-simulator':'television', 'mac-catalyst':'catalyst'}[target]
    return destination, dict(project=host / 'MediaHost.xcodeproj', scheme='MediaTelevision' if destination == 'television' else 'MediaHost',
                             derived_data=host / ('.derived-' + destination), package_cache=host / '.packages')


try:
    if action in ['prepare-apple', 'apple-build']:
        native.require(context, ['dependency-download', 'native-build'])
        destination, paths = apple_paths()
        subprocess.run([sys.executable, str(root / 'scripts/check-apple.py'), 'prepare'], env=native.environment(context), check=True, timeout=600)
        subprocess.run([sys.executable, str(root / 'scripts/check-apple.py'), 'build', '--destination', destination], env=native.environment(context), check=True, timeout=600)
        if action == 'prepare-apple':
            native.prepare_apple(context, **paths)
        else:
            native.write_result(native.make_result(context, {'build-produced': (paths['derived_data'] / 'Build/Products').is_dir()}))
    elif action == 'apple':
        _, paths = apple_paths()
        target = 'MediaTelevisionTests' if paths['scheme'] == 'MediaTelevision' else 'MediaTests'
        native.write_result(native.run_apple(context, **paths, expected_targets={target: 'Unit test bundle'}))
    elif action == 'prepare-android':
        native.prepare_android(context, project=root / 'tests/native/android', tasks=[':app:testDebugUnitTest', ':app:assembleDebug'])
    elif action == 'android':
        native.write_result(native.run_android(context, project=root / 'tests/native/android', tasks=[':app:testDebugUnitTest', ':app:assembleDebug'],
                                              artifact_paths=[root / 'tests/native/android/app/build/outputs/apk/debug/app-debug.apk']))
    elif action == 'cleanup':
        result = native.cleanup_native(context)
        native.write_cleanup_result(result)
        if not result['cleanup']['completed']:
            raise SystemExit(1)
    else:
        raise ValueError('context-invalid')
except Exception:
    if action not in ['prepare-apple', 'prepare-android', 'cleanup']:
        native.write_result(native.make_result(context, {}))
    raise SystemExit(1)
