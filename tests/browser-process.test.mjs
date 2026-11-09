import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { configurePrivateBrowserCache, createOwnedBrowserLauncher, fixedArguments, parseEndpoint } from '../implementation/verification/browser-process-core.mjs';

async function fixture(run, options = {}) {
  const privateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owned-browser-fixture-')));
  const root = path.join(privateRoot, 'profiles');
  await fs.mkdir(root, { mode: 0o700 });
  const priorRoot = process.env.AEPM_PRIVATE_ROOT;
  const priorContext = process.env.AEPM_CONTEXT_FILE;
  process.env.AEPM_PRIVATE_ROOT = privateRoot;
  delete process.env.AEPM_CONTEXT_FILE;
  const executable = path.join(privateRoot, 'chromium');
  await fs.writeFile(executable, 'fixture executable', { mode: 0o700 });
  const calls = [];
  let tick = 0;
  let profile;
  let written = Promise.resolve();
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null });
  child.kill = signal => {
    calls.push(signal);
    if (options.exitOnKill && signal === 'SIGKILL' || options.exitOnTerminate && signal === 'SIGTERM') {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    }
    return true;
  };
  const browser = {
    async newBrowserCDPSession() {
      calls.push('browser-session');
      return { async send(method) {
        calls.push(method);
        if (!options.neverExit && !options.exitOnKill && !options.exitOnTerminate) {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }
      } };
    },
    async close() { calls.push('connection-close'); },
  };
  const launch = createOwnedBrowserLauncher({
    spawn(command, args, settings) {
      calls.push({ command, args, settings });
      profile = args.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      if (options.spawnError) queueMicrotask(() => { child.pid = undefined; child.emit('error', new Error('fixture failure')); });
      else if (!options.noEndpoint) written = fs.writeFile(path.join(profile, 'DevToolsActivePort'), options.endpoint ?? '23456\n/devtools/browser/fixture-id\n');
      return child;
    },
    chromium: {
      executablePath: () => options.selectedExecutable ?? executable,
      async connectOverCDP(endpoint, settings) {
        calls.push({ endpoint, settings });
        if (options.connectionError) throw new Error('fixture connection failure');
        return browser;
      },
    },
    now: () => tick,
    pause: async milliseconds => { await written; tick += milliseconds; },
    async limit(promise) {
      let complete = false; let value; let failure;
      promise.then(result => { value = result; complete = true; }, error => { failure = error; complete = true; });
      for (let i = 0; i < 10 && !complete; i++) await Promise.resolve();
      if (!complete) throw new Error('timeout');
      if (failure) throw failure;
      return value;
    },
  });
  try { await run({ root, executable, child, browser, calls, launch, profile: () => profile }); }
  finally {
    if (priorRoot === undefined) delete process.env.AEPM_PRIVATE_ROOT; else process.env.AEPM_PRIVATE_ROOT = priorRoot;
    if (priorContext === undefined) delete process.env.AEPM_CONTEXT_FILE; else process.env.AEPM_CONTEXT_FILE = priorContext;
    await written;
    await fs.rm(privateRoot, { recursive: true, force: true });
  }
}

test('fixed launcher inherits containment, isolates profile and sends Browser.close before observing exit', async () => {
  await fixture(async ({ root, executable, launch, calls, browser, profile }) => {
    const owned = await launch({ profileRoot: root });
    assert.equal(owned.browser, browser);
    const spawn = calls[0];
    assert.equal(spawn.command, executable);
    assert.deepEqual(spawn.args, fixedArguments(profile()));
    assert.equal(spawn.settings.detached, false);
    assert.equal(spawn.settings.env.HOME, profile());
    assert.equal(spawn.settings.env.USERPROFILE, profile());
    assert.equal(Object.hasOwn(spawn.settings.env, 'AEPM_SECRETS_FILE'), false);
    assert.ok(spawn.args.includes('--password-store=basic'));
    assert.ok(spawn.args.includes('--use-mock-keychain'));
    assert.ok(!spawn.args.includes('--no-sandbox'));
    assert.ok(!spawn.args.includes('--use-fake-ui-for-media-stream'));
    assert.equal(calls[1].endpoint, 'ws://127.0.0.1:23456/devtools/browser/fixture-id');
    await owned.close();
    await owned.close();
    assert.equal(calls.filter(value => value === 'Browser.close').length, 1);
    assert.ok(calls.indexOf('Browser.close') < calls.indexOf('connection-close'));
    assert.equal(calls.includes('SIGTERM'), false);
    assert.ok((await fs.stat(profile())).isDirectory(), 'Parent owns final profile removal');
  });
});

test('transport disconnect does not pass while retained child survives', async () => {
  await fixture(async ({ root, launch, calls }) => {
    const owned = await launch({ profileRoot: root });
    await assert.rejects(owned.close(), /cleanup-failed/);
    assert.ok(calls.includes('connection-close'));
    assert.ok(calls.includes('SIGTERM'));
    assert.ok(calls.includes('SIGKILL'));
  }, { neverExit: true });
});

test('close escalates and waits for the known child', async () => {
  await fixture(async ({ root, launch, calls, child }) => {
    const owned = await launch({ profileRoot: root });
    await owned.close();
    assert.deepEqual(calls.filter(value => typeof value === 'string' && value.startsWith('SIG')), ['SIGTERM', 'SIGKILL']);
    assert.equal(child.signalCode, 'SIGKILL');
  }, { exitOnKill: true });
});

test('connection failure terminates child without claiming profile cleanup', async () => {
  await fixture(async ({ root, launch, calls, profile }) => {
    await assert.rejects(launch({ profileRoot: root }), /process-failed/);
    assert.ok(calls.includes('SIGTERM'));
    assert.ok((await fs.stat(profile())).isDirectory());
  }, { connectionError: true, exitOnTerminate: true });
});

test('startup timeout and spawn failure are bounded', async () => {
  await fixture(async ({ root, launch, calls }) => {
    await assert.rejects(launch({ profileRoot: root, timeoutMilliseconds: 50 }), /timeout/);
    assert.ok(calls.includes('SIGTERM'));
  }, { noEndpoint: true, exitOnTerminate: true });
  await fixture(async ({ root, launch, calls }) => {
    await assert.rejects(launch({ profileRoot: root }), /process-failed/);
    assert.equal(calls.includes('SIGTERM'), false);
  }, { spawnError: true });
});

test('debug endpoint cannot supply a host, arbitrary path or invalid port', () => {
  for (const text of ['0\n/devtools/browser/id', '65536\n/devtools/browser/id', '1234\nws://other.invalid', '1234\n/other/id', '1234\n/devtools/browser/id\nextra']) {
    assert.throws(() => parseEndpoint(text), /result-invalid/);
  }
});

test('caller cannot override executable, arguments, or select a linked/shared profile root', async () => {
  await fixture(async ({ root, launch, calls }) => {
    await assert.rejects(launch({ profileRoot: root, executablePath: '/ambient/browser' }), /context-invalid/);
    await assert.rejects(launch({ profileRoot: 'relative' }), /context-invalid/);
    const link = path.join(root, 'linked');
    await fs.symlink(root, link);
    await assert.rejects(launch({ profileRoot: link }), /resource-missing/);
    assert.equal(calls.length, 0);
  });
});

test('runner private root is mandatory and ambient executable selection is rejected', async () => {
  await fixture(async ({ root, launch, calls }) => {
    delete process.env.AEPM_PRIVATE_ROOT;
    await assert.rejects(launch({ profileRoot: root }), /context-missing/);
    assert.equal(calls.length, 0);
  });
  await fixture(async ({ root, launch, calls }) => {
    await assert.rejects(launch({ profileRoot: root }), /tool-unavailable/);
    assert.equal(calls.length, 0);
  }, { selectedExecutable: process.execPath });
});

test('contextual profile root must match the runner-owned browser location', async () => {
  await fixture(async ({ root, launch, calls }) => {
    process.env.AEPM_CONTEXT_FILE = path.join(process.env.AEPM_PRIVATE_ROOT, 'protocol/context.json');
    await assert.rejects(launch({ profileRoot: root }), /context-invalid/);
    assert.equal(calls.length, 0);
  });
});

test('preparation validates HOME and cache before any ambient write and selects one private cache', async () => {
  await fixture(async ({ root }) => {
    const keys = ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR','TMP','TEMP','PLAYWRIGHT_BROWSERS_PATH'];
    const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const privateRoot = process.env.AEPM_PRIVATE_ROOT;
    try {
      for (const key of keys) delete process.env[key];
      process.env.HOME = root;
      const selected = await configurePrivateBrowserCache();
      assert.equal(selected, path.join(privateRoot, 'browser-cache'));
      assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, selected);
      assert.equal(await configurePrivateBrowserCache(), selected);
      process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(privateRoot, 'application/.verification-browser');
      assert.equal(await configurePrivateBrowserCache(), process.env.PLAYWRIGHT_BROWSERS_PATH);
      process.env.PLAYWRIGHT_BROWSERS_PATH = privateRoot + '-ambient-cache';
      await assert.rejects(configurePrivateBrowserCache(), /resource-missing/);
      await assert.rejects(fs.stat(privateRoot + '-ambient-cache'), { code: 'ENOENT' });
      process.env.PLAYWRIGHT_BROWSERS_PATH = selected;
      process.env.HOME = path.dirname(privateRoot);
      await assert.rejects(configurePrivateBrowserCache(), /resource-missing/);
      delete process.env.HOME;
      await assert.rejects(configurePrivateBrowserCache(), /context-missing/);
    } finally {
      for (const key of keys) if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  });
});
