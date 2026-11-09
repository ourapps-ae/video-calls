import { makeResult, recordCreated, recordIntent, requireOperations, resource, validateContext } from './result.mjs';

export async function verifyMedia(context, dependencies) {
  validateContext(context);
  const { Video, videoGrant, listRooms, createRoom, getRoom, deleteRoom, createClients, readSecrets, now } = dependencies;
  if (typeof Video !== 'function') throw new Error('context-invalid');
  requireOperations(context, ['create-room', 'delete-created-room', 'join-room', 'publish-synthetic-media', 'subscribe-media']);
  if (context.assertions.includes('room-listed')) requireOperations(context, ['list-account-rooms']);
  if (!['simulation', 'live'].includes(context.mode) || context.mode === 'simulation' && !['fixture', 'local-provider'].includes(context.simulationKind)) throw new Error('authorization-denied');
  const prefix = context.settings.ephemeralRoomPrefix;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(prefix)) throw new Error('context-invalid');
  const name = `${prefix}-${context.runId}-0`;
  const timeout = Math.min(context.settings.maximumSeconds ?? 60, 900) * 1000;
  const observations = {};
  let clients;
  let created = false;
  let creationAttempted = false;
  let cleaned = false;
  if (await getRoom(name) !== null) return makeResult(context);
  const intent = await recordIntent(context, 'provider-room', name);
  try {
    creationAttempted = true;
    const room = await createRoom({ name, metadata: { aepmRunId: context.runId } });
    if (room.id !== name || room.metadata?.aepmRunId !== context.runId) throw new Error('assertion-failed');
    created = true;
    await recordCreated(intent, room.id);
    const secrets = await readSecrets();
    const env = { LIVEKIT_URL: context.settings.livekitUrl, LIVEKIT_API_KEY: secrets.livekitKey, LIVEKIT_API_SECRET: secrets.livekitSecret };
    const grant = (id, publish) => videoGrant(env, name, id, id, now(), publish, '');
    const [publisherGrant, subscriberGrant, spectatorGrant] = await Promise.all([grant('publisher', true), grant('subscriber', true), grant('spectator', false)]);
    if (!publisherGrant || !subscriberGrant || !spectatorGrant) throw new Error('assertion-failed');
    clients = await createClients({ room: name, publisherGrant, subscriberGrant, spectatorGrant });
    await clients.publisher.connect(); observations['publisher-joined'] = true;
    await clients.subscriber.connect(); observations['subscriber-joined'] = true;
    await clients.spectator.connect();
    observations['subscriber-publish-denied'] = await clients.spectator.attemptPublish() === false;
    await clients.publisher.publishSynthetic();
    const frames = await clients.subscriber.waitForFrames(1, timeout);
    observations['synthetic-track-received'] = Number.isInteger(frames) && frames >= 0 && frames <= 2147483647 ? frames : null;
    await clients.subscriber.disconnect();
    await clients.subscriber.reconnect();
    const reconnectedFrames = await clients.subscriber.waitForFrames(1, timeout);
    observations.reconnected = Number.isInteger(reconnectedFrames) && reconnectedFrames >= 1 && reconnectedFrames <= 2147483647;
    if (context.assertions.includes('room-listed')) {
      const rooms = await listRooms(env, now(), name);
      observations['room-listed'] = Array.isArray(rooms) && rooms.some(room => room.room === name);
    }
    await clients.publisher.enterDisplay();
    observations['board-capture-denied'] = await clients.publisher.activeCaptureCount() === 0;
  } catch {
    // Results retain assertions only; provider diagnostics can contain grants.
  } finally {
    if (clients) {
      const outcomes = await Promise.allSettled(Object.values(clients).map(client => client.close()));
      const counts = await Promise.allSettled(Object.values(clients).map(client => client.activeCaptureCount()));
      observations['media-stopped-on-close'] = outcomes.every(outcome => outcome.status === 'fulfilled') && counts.every(count => count.status === 'fulfilled' && count.value === 0);
    }
    try {
      const current = await getRoom(name);
      if (current === null) cleaned = true;
      else if (creationAttempted && current?.id === name && current.metadata?.aepmRunId === context.runId) {
        await deleteRoom(name);
        cleaned = await getRoom(name) === null;
      }
    } catch { cleaned = false; }
    observations['room-deleted'] = cleaned;
  }
  return makeResult(context, observations, [resource(context, 'provider-room', name, created, cleaned)],
    { required: true, attempted: true, completed: false, reason: cleaned ? '' : 'cleanup-failed' });
}
