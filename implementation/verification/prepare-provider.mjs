import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readContext, requireOperations } from './result.mjs';
import { configurePrivateBrowserCache } from './browser-process-core.mjs';

try {
  const context = await readContext();
  requireOperations(context, ['dependency-download']);
  if (!(context.mode === 'simulation' && context.simulationKind === 'fixture')) {
    await configurePrivateBrowserCache();
    const require = createRequire(import.meta.url);
    const command = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const result = spawnSync(process.execPath, [command, 'install', 'chromium'], { stdio: 'ignore', timeout: 180000 });
    if (result.status !== 0) process.exitCode = 1;
  }
} catch { process.exitCode = 1; }
