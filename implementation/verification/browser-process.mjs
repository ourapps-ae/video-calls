import { spawn } from 'node:child_process';
import path from 'node:path';
import { configurePrivateBrowserCache, createOwnedBrowserLauncher, insideRoot } from './browser-process-core.mjs';

export async function launchOwnedBrowser(options) {
  const cache = await configurePrivateBrowserCache();
  const { chromium } = await import('playwright');
  if (!insideRoot(cache, path.resolve(chromium.executablePath()))) throw new Error('tool-unavailable');
  return await createOwnedBrowserLauncher({ spawn, chromium })(options);
}
