import fs from 'node:fs/promises';
import path from 'node:path';
import { Video } from '../web/video.ts';
import { videoGrant, listRooms } from '../server/video.ts';
import { readSecrets, providerEndpoints } from './adapters.mjs';
import { writeCanonical } from './result.mjs';

export async function createFixtureDependencies(context) {
  if (context.mode !== 'simulation' || context.simulationKind !== 'fixture') throw new Error('authorization-denied');
  providerEndpoints(context);
  const file = path.join(path.dirname(process.env.AEPM_CONTEXT_FILE), 'fixture-provider-' + context.runId + '.json');
  const load = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
  const persist = value => writeCanonical(file, value);
  return {
    Video, videoGrant, now: () => Date.now(), readSecrets: () => readSecrets(context),
    async createRoom({ name, metadata }) { const rooms = await load(); if (rooms[name]) throw new Error('assertion-failed'); rooms[name] = { id: name, metadata }; await persist(rooms); return rooms[name]; },
    async getRoom(name) { return (await load())[name] ?? null; },
    async deleteRoom(name) { const rooms = await load(); delete rooms[name]; await persist(rooms); },
    listRooms: (env, now, prefix) => listRooms(env, now, prefix, async url => Response.json(String(url).endsWith('ListRooms')
      ? { rooms: Object.keys(await load()).map(name => ({ name })) } : { participants: [] })),
    async createClients(grants) {
      const states = {};
      const clients = {};
      for (const role of ['publisher', 'subscriber', 'spectator']) {
        const grant = JSON.parse(Buffer.from(grants[role + 'Grant'].token.split('.')[1], 'base64url'));
        const state = { connected: false, capture: 0, display: false };
        states[role] = state;
        clients[role] = {
          async connect() { if (!await thisRoom()) throw new Error('assertion-failed'); state.connected = true; },
          async publishSynthetic() { if (!state.connected || !grant.video.canPublish || state.display) throw new Error('assertion-failed'); state.capture = 1; },
          async waitForFrames(minimum) { return state.connected && states.publisher.capture && minimum > 0 ? minimum : 0; },
          async attemptPublish() { try { await clients[role].publishSynthetic(); return true; } catch { return false; } },
          async disconnect() { state.connected = false; state.capture = 0; },
          async reconnect() { await clients[role].connect(); },
          async enterDisplay() { state.display = true; await clients[role].disconnect(); },
          async activeCaptureCount() { return state.capture; },
          async close() { await clients[role].disconnect(); },
        };
        const thisRoom = async () => (await load())[grants.room];
      }
      return clients;
    },
  };
}
