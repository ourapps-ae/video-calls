import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync('python3', [fileURLToPath(new URL('./platform-check.py', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
