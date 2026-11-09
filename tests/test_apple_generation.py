import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class AppleGenerationTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('xcodegen'), 'XcodeGen unavailable')
    def test_private_tool_shim_resolves_resources(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='media-apple-generation-') as directory:
            root = Path(directory)
            for relative in ['implementation/apple', 'tests/apple', 'tests/native/apple']:
                shutil.copytree(source / relative, root / relative,
                                ignore=shutil.ignore_patterns('.packages', '.package-cache', '.derived-*', '*.xcodeproj'))
            (root / 'scripts').mkdir()
            shutil.copyfile(source / 'scripts/check-apple.py', root / 'scripts/check-apple.py')
            tools = root / 'bin'
            tools.mkdir()
            (tools / 'xcodegen').symlink_to(Path(shutil.which('xcodegen')).resolve())
            env = dict(PATH=str(tools) + os.pathsep + '/usr/bin:/bin', HOME=str(root), USER='builder', LOGNAME='builder')
            output = subprocess.run([sys.executable, str(root / 'scripts/check-apple.py'), 'generate'],
                                    env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(output.returncode, 0, output.stdout + output.stderr)
            host = root / 'tests/native/apple'
            self.assertEqual((host / 'Package.resolved').read_bytes(),
                             (host / 'MediaHost.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved').read_bytes())


if __name__ == '__main__':
    unittest.main()
