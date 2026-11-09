# Local workflow

Local only: no commits, pushes, remote changes or publishing without George's say-so. Licence wording remains deferred.
Do not edit `mcinpoker/`, `skull/`, `aepm/`, `OurPoker/proof/` or `OurPoker/recipe/`.

Required-local suites, from the package root: `node --test tests/video.test.mjs`, `node --test tests/browser-process.test.mjs`, `node --test tests/provider.test.mjs`, the three `python3 -m unittest discover -s tests -p test_*.py` suites (`test_dependency_metadata.py`, `test_apple_results.py`, `test_native_runner.py`) and `npm run typecheck` (after `npm ci --ignore-scripts --no-audit --no-fund`).
Heavy suites (Xcode, Gradle, Chromium download, deployed provider): `scripts/platform-check.py apple-build|apple|android`, `implementation/verification/provider-runner.mjs`. Do not run them casually.
Validate: `PYTHONPATH=/Users/george/Projects/com/my/aepm /Users/george/.pyenv/versions/3.12.8/bin/python3.12 -B /Users/george/Projects/com/my/tools/check_component.py components/video-calls`. The checker does not run suite `prepare` steps, so the npm-dependent suites fail in it unless `node_modules/` is in its package copy. Always `-B`; remove any `tests/__pycache__`.
