import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { videoGrant, listRooms as productionListRooms } from '../server/video.ts';
import { Video } from '../web/video.ts';
import { readOwnership, requireOperations, resource, validateContext } from './result.mjs';
import { launchOwnedBrowser } from './browser-process.mjs';

export function providerEndpoints(context) {
  validateContext(context);
  const address = new URL(context.settings.livekitUrl);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('context-invalid');
  if (context.mode === 'live' && !['wss:', 'https:'].includes(address.protocol)) throw new Error('authorization-denied');
  if (context.mode === 'simulation' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw new Error('authorization-denied');
  const socket = new URL(address);
  socket.protocol = { 'http:': 'ws:', 'https:': 'wss:' }[socket.protocol] ?? socket.protocol;
  const service = new URL(address);
  service.protocol = { 'ws:': 'http:', 'wss:': 'https:' }[service.protocol] ?? service.protocol;
  socket.pathname = socket.pathname.replace(/\/+$/, '') || '/';
  service.pathname = service.pathname.replace(/\/+$/, '') || '/';
  if (context.operations.some(operation => ['join-room', 'publish-synthetic-media', 'subscribe-media'].includes(operation)) && !context.origins.includes(socket.origin)) throw new Error('authorization-denied');
  if (context.operations.some(operation => ['create-room', 'delete-created-room', 'list-account-rooms'].includes(operation)) && !context.origins.includes(service.origin)) throw new Error('authorization-denied');
  return { socket, service, serviceBase: service.href.replace(/\/+$/, '') };
}

export async function readSecrets(context) {
  try {
    const file = JSON.parse(await fs.readFile(process.env.AEPM_SECRETS_FILE, 'utf8'));
    if (file.format !== 1 || ['runId', 'package', 'id'].some(key => file[key] !== context[key])) throw new Error();
    const values = {};
    for (const name of ['livekitKey', 'livekitSecret']) {
      if (!context.secrets[name] || file.values[name]?.version !== context.secrets[name].version || typeof file.values[name].value !== 'string') throw new Error();
      values[name] = file.values[name].value;
    }
    return values;
  } catch { throw new Error('secret-unavailable'); }
}

function token(secrets, video) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ iss: secrets.livekitKey, iat: now, nbf: now - 10, exp: now + 120, video });
  return body + '.' + createHmac('sha256', secrets.livekitSecret).update(body).digest('base64url');
}

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('assertion-failed');
  const chunks = []; let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 1024 * 1024) { await reader.cancel(); throw new Error('assertion-failed'); }
    chunks.push(next.value);
  }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
}

export function createServiceAdapter(context, secrets, fetcher = fetch, endpoints = providerEndpoints(context)) {
  const namespace = `${context.settings.ephemeralRoomPrefix}-${context.runId}-`;
  const ownedName = name => typeof name === 'string' && name.startsWith(namespace) && /^(?:[0-9]|[12][0-9]|3[01])$/.test(name.slice(namespace.length));
  async function call(method, body, operation) {
    requireOperations(context, [operation]);
    const name = body.name ?? body.room ?? body.names?.[0];
    if (name !== undefined && !ownedName(name)) throw new Error('authorization-denied');
    if (method === 'ListRooms' && !body.names && operation !== 'list-account-rooms') throw new Error('authorization-denied');
    const grant = method === 'CreateRoom' ? { roomCreate: true } : method === 'ListRooms' ? { roomList: true } : { roomAdmin: true, room: name };
    try {
      const response = await fetcher(`${endpoints.serviceBase}/twirp/livekit.RoomService/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + token(secrets, grant), 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok || response.redirected || response.status >= 300 && response.status < 400) throw new Error();
      return await (await boundedResponse(response)).json();
    } catch { throw new Error('assertion-failed'); }
  }
  const record = value => {
    let metadata;
    try { metadata = JSON.parse(value.metadata ?? '{}'); } catch { throw new Error('assertion-failed'); }
    return { id: value.name, metadata: { aepmRunId: metadata.aepmRunId } };
  };
  return {
    async createRoom({ name, metadata }) {
      if (metadata.aepmRunId !== context.runId) throw new Error('authorization-denied');
      const journal = await readOwnership(context);
      if (!journal.some(({ intent, created }) => intent.kind === 'provider-room' && intent.requestedId === name && !created)) throw new Error('authorization-denied');
      return record(await call('CreateRoom', { name, metadata: JSON.stringify(metadata) }, 'create-room'));
    },
    async getRoom(name) {
      const operation = context.operations.includes('delete-created-room') ? 'delete-created-room' : 'create-room';
      const found = await call('ListRooms', { names: [name] }, operation);
      const rooms = found.rooms ?? [];
      if (rooms.some(room => room.name !== name) || rooms.length > 1) throw new Error('assertion-failed');
      return rooms.length ? record(rooms[0]) : null;
    },
    async deleteRoom(name) {
      const journal = await readOwnership(context);
      if (!journal.some(({ intent, created }) => intent.kind === 'provider-room' && intent.requestedId === name && (!created || created.resourceId === name))) throw new Error('authorization-denied');
      const found = await call('ListRooms', { names: [name] }, 'delete-created-room');
      if (!Array.isArray(found.rooms) || found.rooms.length !== 1 || found.rooms[0].name !== name || record(found.rooms[0]).metadata.aepmRunId !== context.runId) throw new Error('authorization-denied');
      await call('DeleteRoom', { room: name }, 'delete-created-room');
    },
    async checkingFetch(url, options) {
      requireOperations(context, ['list-account-rooms']);
      const allowed = ['ListRooms', 'ListParticipants'].map(method => `${endpoints.serviceBase}/twirp/livekit.RoomService/${method}`);
      if (!allowed.includes(String(url))) throw new Error('authorization-denied');
      const body = JSON.parse(options.body);
      if (String(url).endsWith('ListParticipants') && !ownedName(body.room)) throw new Error('authorization-denied');
      try {
        const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok || response.redirected) throw new Error();
        return await boundedResponse(response);
      } catch { throw new Error('assertion-failed'); }
    },
  };
}

export function validateApplicationClients(applicationClients) {
  if (!applicationClients) return;
  const roles = ['publisher', 'subscriber', 'spectator'];
  if (roles.some(role => !applicationClients.pages?.[role] || typeof applicationClients.identities?.[role]?.id !== 'string' || !applicationClients.identities[role].id || typeof applicationClients.identities[role].name !== 'string') ||
      new Set(roles.map(role => applicationClients.identities[role].id)).size !== 3 ||
      new Set(roles.map(role => applicationClients.pages[role])).size !== 3 ||
      ['applyGrants', 'enterDisplay', 'observe'].some(name => typeof applicationClients[name] !== 'function')) throw new Error('context-invalid');
}

async function createBrowserClients(context, grants, applicationClients, endpoints) {
  const { build } = await import('esbuild');
  const source = fileURLToPath(new URL('./browser.ts', import.meta.url));
  const bundle = await build({ entryPoints: [source], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' });
  let ownedBrowser = null;
  if (!applicationClients) {
    if (!process.env.AEPM_CONTEXT_FILE || !process.env.AEPM_PRIVATE_ROOT) throw new Error('context-missing');
    const profileRoot = path.join(path.dirname(process.env.AEPM_CONTEXT_FILE), 'profiles/browser');
    await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 });
    ownedBrowser = await launchOwnedBrowser({ profileRoot });
  }
  const browser = ownedBrowser?.browser;
  let open = 3;
  let denied = false;
  const result = {};
  try {
    for (const name of ['publisher', 'subscriber', 'spectator']) {
      const page = applicationClients ? applicationClients.pages[name] : await browser.newPage();
      const applicationOrigin = applicationClients ? new URL(page.url()) : null;
      if (applicationOrigin && (!['http:', 'https:'].includes(applicationOrigin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(applicationOrigin.hostname))) throw new Error('authorization-denied');
      const applicationOrigins = new Set(applicationOrigin ? [applicationOrigin.origin] : []);
      if (applicationClients) {
        const priorRequests = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
        for (const value of priorRequests) {
          const address = new URL(value, page.url());
          if (['http:', 'https:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) applicationOrigins.add(address.origin);
        }
      }
      const devtools = await page.context().newCDPSession(page);
      await devtools.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', requestStage: 'Response' }] });
      devtools.on('Fetch.requestPaused', async event => {
        try {
          const url = new URL(event.request.url);
          const base = url.protocol.startsWith('ws') ? endpoints.socket : endpoints.service;
          const pathAllowed = url.pathname === base.pathname || url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/');
          const localApplication = [...applicationOrigins].some(origin => url.origin === origin || url.origin === origin.replace(/^http/, 'ws'));
          if ((!localApplication && (url.origin !== base.origin || !pathAllowed)) || [301, 302, 303, 307, 308].includes(event.responseStatusCode)) {
            denied = true;
            await devtools.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
          } else await devtools.send('Fetch.continueRequest', { requestId: event.requestId });
        } catch { denied = true; }
      });
      if (!applicationClients) await page.setContent('<!doctype html><html data-mode="player"><body></body></html>');
      await page.evaluate(({ socketOrigin, socketPath, applicationOrigins }) => {
        const NativeSocket = window.WebSocket;
        window.WebSocket = new Proxy(NativeSocket, {
          construct(target, args) {
            const address = new URL(String(args[0]), location.href);
            const applicationSocket = applicationOrigins.some(origin => address.origin === origin.replace(/^http/, 'ws'));
            if (!applicationSocket && (address.origin !== socketOrigin || !(address.pathname === socketPath || address.pathname.startsWith(socketPath.replace(/\/$/, '') + '/')))) throw new Error('authorization-denied');
            return Reflect.construct(target, args);
          },
        });
      }, { socketOrigin: endpoints.socket.origin, socketPath: endpoints.socket.pathname, applicationOrigins: [...applicationOrigins] });
      await page.evaluate(configuration => { window.mediaVerificationConfiguration = configuration; },
        { application: Boolean(applicationClients), publisherIdentity: applicationClients?.identities.publisher.id ?? 'publisher' });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const grant = grants[name + 'Grant'];
      await page.evaluate(grant => window.mediaVerification.setGrant(grant), { ...grant, url: endpoints.socket.href.replace(/\/$/, '') });
      let closed = false;
      let stopped = null;
      const invoke = async (method, ...args) => {
        if (denied) throw new Error('assertion-failed');
        const value = await page.evaluate(async ({ method, args }) => await window.mediaVerification[method](...args), { method, args });
        if (denied) throw new Error('assertion-failed');
        return value;
      };
      result[name] = {
        async connect() { await invoke('connect'); await applicationClients?.observe(name, 'connected', page); },
        publishSynthetic: () => invoke('publishSynthetic'),
        async waitForFrames(minimum, timeout) { const frames = await invoke('waitForFrames', minimum, timeout); await applicationClients?.observe(name, 'frames', page); return frames; },
        attemptPublish: () => invoke('attemptPublish'), disconnect: () => invoke('disconnect'), reconnect: () => invoke('reconnect'),
        async enterDisplay() {
          if (applicationClients) await applicationClients.enterDisplay(name, page);
          else await invoke('enterDisplay');
          await applicationClients?.observe(name, 'display', page);
        },
        async activeCaptureCount() {
          const count = closed ? stopped : await invoke('activeCaptureCount');
          if (!Number.isInteger(count) || count < 0) throw new Error('assertion-failed');
          return count;
        },
        async close() {
          if (closed) return;
          try { await applicationClients?.observe(name, 'closing', page); }
          finally {
            try { if (applicationClients) await applicationClients.enterDisplay(name, page); }
            finally {
              try { stopped = await invoke('close'); }
              finally {
                closed = true;
                try { await devtools.detach(); }
                finally {
                  try { if (!applicationClients) await page.close(); }
                  finally { if (--open === 0 && ownedBrowser) await ownedBrowser.close(); }
                }
              }
            }
          }
        },
      };
    }
    if (applicationClients) await applicationClients.applyGrants(grants);
    return result;
  } catch {
    await Promise.allSettled(Object.values(result).map(client => client.close()));
    if (ownedBrowser) await ownedBrowser.close();
    throw new Error('process-failed');
  }
}

export async function createProviderDependencies(context, { applicationClients } = {}) {
  validateApplicationClients(applicationClients);
  if (context.mode === 'simulation' && context.simulationKind === 'fixture') {
    if (applicationClients) throw new Error('authorization-denied');
    return await (await import('./fixture.mjs')).createFixtureDependencies(context);
  }
  const secrets = await readSecrets(context);
  const endpoints = providerEndpoints(context);
  const service = createServiceAdapter(context, secrets, fetch, endpoints);
  const mappedGrant = (env, room, role, name, now, publish, prefix) => {
    const identity = applicationClients?.identities[role];
    return videoGrant({ ...env, LIVEKIT_URL: endpoints.socket.href.replace(/\/$/, '') }, room, identity?.id ?? role, identity?.name ?? name, now, publish, prefix);
  };
  return { Video, videoGrant: mappedGrant, listRooms: (env, now, prefix) => productionListRooms(env, now, prefix, service.checkingFetch),
    createRoom: service.createRoom, getRoom: service.getRoom, deleteRoom: service.deleteRoom,
    createClients: grants => createBrowserClients(context, grants, applicationClients, endpoints), readSecrets: async () => secrets, now: () => Date.now() };
}

export async function cleanupProvider(context) {
  const service = context.mode === 'simulation' && context.simulationKind === 'fixture'
    ? await (await import('./fixture.mjs')).createFixtureDependencies(context)
    : createServiceAdapter(context, await readSecrets(context));
  const records = await readOwnership(context);
  const resources = [];
  let complete = true;
  for (const { intent, created } of records) {
    if (intent.kind !== 'provider-room') continue;
    const name = intent.requestedId;
    let cleaned = false;
    try {
      const current = await service.getRoom(name);
      if (current === null) cleaned = true;
      else if (current?.metadata?.aepmRunId === context.runId && (!created || created.resourceId === name)) {
        await service.deleteRoom(name); cleaned = await service.getRoom(name) === null;
      }
    } catch { cleaned = false; }
    complete &&= cleaned;
    resources.push(resource(context, 'provider-room', name, Boolean(created), cleaned));
  }
  return { format: 1, runId: context.runId, package: context.package, id: context.id, resources,
    cleanup: { required: records.length > 0, attempted: records.length > 0, completed: complete, reason: complete ? '' : 'cleanup-failed' } };
}
