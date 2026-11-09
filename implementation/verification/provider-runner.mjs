import { cleanupProvider, createProviderDependencies } from './adapters.mjs';
import { verifyMedia } from './provider.mjs';
import { makeResult, readContext, writeCleanupResult, writeResult } from './result.mjs';

let context;
try {
  context = await readContext();
  if (process.argv[2] === 'cleanup') {
    const result = await cleanupProvider(context);
    await writeCleanupResult(result);
    if (!result.cleanup.completed) process.exitCode = 1;
  } else {
    const dependencies = context.mode === 'simulation' && context.simulationKind === 'fixture'
      ? await (await import('./fixture.mjs')).createFixtureDependencies(context)
      : await createProviderDependencies(context);
    const result = await verifyMedia(context, dependencies);
    await writeResult(result);
    if (result.assertions.some(assertion => !assertion.passed) || result.cleanup.reason) process.exitCode = 1;
  }
} catch {
  if (context && process.argv[2] !== 'cleanup') {
    try { await writeResult(makeResult(context)); } catch { /* The runner reports invalid/missing output. */ }
  }
  process.exitCode = 1;
}
