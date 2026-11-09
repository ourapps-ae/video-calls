import fs from 'node:fs/promises';
import path from 'node:path';

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function validateContext(context) {
  if (context?.format !== 1 || !/^[a-f0-9]{64}$/.test(context.runId) || !/^[a-f0-9]{64}$/.test(context.package) || typeof context.id !== 'string' || !Array.isArray(context.operations) || !Array.isArray(context.assertions)) throw new Error('context-invalid');
  return context;
}

export async function readContext() {
  if (!process.env.AEPM_CONTEXT_FILE) throw new Error('context-missing');
  return validateContext(JSON.parse(await fs.readFile(process.env.AEPM_CONTEXT_FILE, 'utf8')));
}

export function requireOperations(context, operations) {
  if (operations.some(operation => !context.operations.includes(operation))) throw new Error('authorization-denied');
}

export async function writeCanonical(file, value, exclusive = false) {
  const destination = path.resolve(file);
  const temporary = exclusive ? destination : destination + '.pending';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(canonical(value)); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await fs.rename(temporary, destination);
}

export async function writeResult(result) {
  if (!process.env.AEPM_RESULT_FILE) throw new Error('result-missing');
  await writeCanonical(process.env.AEPM_RESULT_FILE, result);
}

export async function writeCleanupResult(result) {
  if (!process.env.AEPM_CLEANUP_RESULT_FILE) throw new Error('result-missing');
  await writeCanonical(process.env.AEPM_CLEANUP_RESULT_FILE, result);
}

export function ownershipDirectory() {
  if (!process.env.AEPM_OWNERSHIP_DIRECTORY) throw new Error('context-missing');
  return path.resolve(process.env.AEPM_OWNERSHIP_DIRECTORY);
}

export async function recordIntent(context, kind, requestedId, counter = 0) {
  validateContext(context);
  if (!Number.isInteger(counter) || counter < 0 || counter > 31 || !/^[A-Za-z0-9_.:-]{1,256}$/.test(requestedId)) throw new Error('context-invalid');
  const record = { format: 1, runId: context.runId, package: context.package, id: context.id, counter, kind, requestedId, namespace: context.runId };
  await writeCanonical(path.join(ownershipDirectory(), `intent-${counter}.json`), record, true);
  return record;
}

export async function recordCreated(intent, resourceId) {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(resourceId)) throw new Error('result-invalid');
  await writeCanonical(path.join(ownershipDirectory(), `created-${intent.counter}.json`), { ...intent, resourceId }, true);
}

export async function readOwnership(context) {
  const directory = ownershipDirectory();
  const records = [];
  for (const name of (await fs.readdir(directory)).filter(name => /^intent-\d+\.json$/.test(name)).sort()) {
    const intent = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    if (intent.runId !== context.runId || intent.package !== context.package || intent.id !== context.id || intent.namespace !== context.runId) throw new Error('result-invalid');
    let created = null;
    try { created = JSON.parse(await fs.readFile(path.join(directory, `created-${intent.counter}.json`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (created && Object.keys(intent).some(key => created[key] !== intent[key])) throw new Error('result-invalid');
    records.push({ intent, created });
  }
  return records;
}

export function resource(context, kind, id, created, cleaned) {
  return { kind, id, namespace: context.runId, createdByRunId: context.runId, created, cleaned };
}

export function makeResult(context, observations = {}, resources = [], cleanup = { required: false, attempted: false, completed: true, reason: '' }) {
  const assertions = [...context.assertions].sort().map(id => {
    const actual = id === 'process-tree-terminated' ? null : Object.hasOwn(observations, id) ? observations[id] : null;
    const passed = actual === null ? false : typeof actual === 'boolean' ? actual : id === 'tests-passed' ? actual === 0 : actual >= 1;
    return { id, passed, actual };
  });
  return { format: 1, runId: context.runId, package: context.package, id: context.id, assertions, artifacts: [], resources, cleanup };
}
