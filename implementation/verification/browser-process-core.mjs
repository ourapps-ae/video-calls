import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const fixedArguments = profile => [
  '--headless=new', `--user-data-dir=${profile}`,
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-sync',
  '--disable-breakpad', '--disable-crash-reporter', '--password-store=basic',
  '--use-mock-keychain', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
];

export function parseEndpoint(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length !== 2 || !/^[1-9][0-9]{0,4}$/.test(lines[0]) || Number(lines[0]) > 65535 ||
      !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,128}$/.test(lines[1])) throw new Error('result-invalid');
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

export function insideRoot(root, value, allowRoot = false) {
  const relative = path.relative(root, value);
  return (allowRoot || relative !== '') && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

export async function privateRootDirectory() {
  const issuedRoot = process.env.AEPM_PRIVATE_ROOT;
  if (!issuedRoot || !path.isAbsolute(issuedRoot)) throw new Error('context-missing');
  const info = await fs.lstat(issuedRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('resource-missing');
  return await fs.realpath(issuedRoot);
}

async function privateDirectory(root, value, create = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('context-invalid');
  const target = path.resolve(value);
  if (!insideRoot(root, target, true)) throw new Error('resource-missing');
  let existing = target;
  while (true) {
    try {
      const info = await fs.lstat(existing);
      if (!info.isDirectory() || info.isSymbolicLink() || !insideRoot(root, await fs.realpath(existing), true)) throw new Error('resource-missing');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || !create || existing === root) throw error;
      existing = path.dirname(existing);
    }
  }
  if (create) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const resolved = await fs.realpath(target);
  if (!insideRoot(root, resolved, true)) throw new Error('resource-missing');
  return resolved;
}

export async function configurePrivateBrowserCache() {
  const root = await privateRootDirectory();
  if (!process.env.HOME) throw new Error('context-missing');
  await privateDirectory(root, process.env.HOME);
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key] !== undefined) await privateDirectory(root, process.env[key], true);
  }
  if (!process.env.TMPDIR && !process.env.TMP && !process.env.TEMP) {
    const temporary = await privateDirectory(root, path.join(root, 'browser-temporary'), true);
    Object.assign(process.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
  }
  const selected = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(root, 'browser-cache');
  const cache = await privateDirectory(root, selected, true);
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  return cache;
}

export function createOwnedBrowserLauncher({ spawn, chromium, now = () => performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), limit = bounded }) {
  return async function launchOwnedBrowser(options) {
    if (!options || Object.keys(options).some(key => !['profileRoot', 'timeoutMilliseconds'].includes(key)) ||
        typeof options.profileRoot !== 'string' || !path.isAbsolute(options.profileRoot)) throw new Error('context-invalid');
    const timeout = options.timeoutMilliseconds ?? 30000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('context-invalid');
    const privateRoot = await privateRootDirectory();
    const rootInfo = await fs.lstat(options.profileRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || process.platform !== 'win32' && (rootInfo.mode & 0o077)) throw new Error('resource-missing');
    const profileRoot = await fs.realpath(options.profileRoot);
    if (!insideRoot(privateRoot, profileRoot)) throw new Error('resource-missing');
    if (process.env.AEPM_CONTEXT_FILE && profileRoot !== path.resolve(path.dirname(process.env.AEPM_CONTEXT_FILE), 'profiles/browser')) throw new Error('context-invalid');
    const selected = chromium.executablePath();
    const executableInfo = await fs.lstat(selected);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) throw new Error('tool-unavailable');
    await fs.access(selected, constants.X_OK);
    const executable = await fs.realpath(selected);
    if (!insideRoot(privateRoot, executable)) throw new Error('tool-unavailable');
    const profile = await fs.mkdtemp(path.join(profileRoot, 'chromium-'));
    const temporary = path.join(profile, 'temporary');
    const appdata = path.join(profile, 'appdata');
    const localappdata = path.join(profile, 'localappdata');
    await Promise.all([temporary, appdata, localappdata].map(directory => fs.mkdir(directory, { mode: 0o700 })));
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'LANG', 'LC_ALL', 'TZ']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: appdata, LOCALAPPDATA: localappdata,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary });
    const deadline = now() + timeout;
    const child = spawn(executable, fixedArguments(profile), { detached: false, stdio: 'ignore', windowsHide: true, env });
    let exited = child.exitCode !== null || child.signalCode !== null;
    let spawnFailed = false;
    let resolveExit;
    const exit = new Promise(resolve => { resolveExit = resolve; });
    child.once('exit', () => { exited = true; resolveExit(); });
    child.once('error', () => { spawnFailed = true; if (!child.pid) { exited = true; resolveExit(); } });
    if (exited) resolveExit();
    let browser;
    let closing;

    async function waitExit() {
      if (!exited) await limit(exit, 5000);
    }

    async function stopChild(graceful) {
      if (graceful) {
        try { await waitExit(); return; } catch { /* Escalation remains scoped to the retained child. */ }
      }
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (exited) return;
        try { child.kill(signal); } catch { if (!exited) throw new Error('cleanup-failed'); }
        try { await waitExit(); return; } catch { /* Try the next bounded signal. */ }
      }
      throw new Error('cleanup-failed');
    }

    function close() {
      if (!closing) closing = (async () => {
        if (browser && !exited) {
          try {
            await limit((async () => {
              const session = await browser.newBrowserCDPSession();
              await session.send('Browser.close');
            })(), 5000);
          } catch { /* Only observed child exit establishes shutdown. */ }
          try { await limit(browser.close(), 5000); } catch { /* The child still must exit. */ }
        }
        await stopChild(Boolean(browser));
      })();
      return closing;
    }

    try {
      let endpoint;
      while (now() < deadline) {
        if (spawnFailed || exited) throw new Error('process-failed');
        try {
          const file = path.join(profile, 'DevToolsActivePort');
          const info = await fs.lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024) throw new Error('result-invalid');
          if (info.size === 0) { await pause(25); continue; }
          endpoint = parseEndpoint(await fs.readFile(file, 'utf8'));
          break;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await pause(25);
      }
      const remaining = Math.ceil(deadline - now());
      if (!endpoint || remaining <= 0) throw new Error('timeout');
      browser = await limit(chromium.connectOverCDP(endpoint, { timeout: remaining }), remaining);
      if (spawnFailed || exited) throw new Error('process-failed');
      return { browser, close };
    } catch (error) {
      await close();
      throw new Error(['timeout', 'result-invalid', 'process-failed'].includes(error.message) ? error.message : 'process-failed');
    }
  };
}
