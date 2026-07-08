'use strict';

// Self-time attribution for .cpuprofile files produced by bench-fragmented.js.
//
// Buckets V8 profile samples to decide between the two hypotheses in
// https://github.com/facebook/react/issues/35125:
//
//   - "per-row overhead": row framing/parse and chunk bookkeeping in the
//     Flight client (and row emission in the Flight server) dominates.
//   - "lazy/throw machinery": modeling deferred rows as throw-based lazies
//     (readChunk throwing into Fizz, which spawns/pings/retries suspended
//     tasks) dominates.
//
// URL-based buckets (the fixture bundles the Flight server + app into
// build/rsc-bundle.js via webpack; the Flight client and Fizz are required
// from node_modules at runtime):
//
//   rsc-bundle.js                      -> Flight server render+serialization
//   react-server-dom-webpack-client.*  -> Flight client (split by name into
//                                         lazy/throw vs row-parse)
//   react-dom-server.*                 -> Fizz (split by name into
//                                         suspend/retry vs plain render)
//
// Name lists err toward the lazy/suspend side only for functions that exist
// solely because of the throw-based lazy model; everything else in the same
// bundle stays in the parse/render bucket. Top functions per bucket are
// printed so results can be re-sliced by hand.

// Flight client machinery that exists to model rows as lazy thenables:
// chunk promise wrappers, throwing reads, and listener wake-ups.
const FLIGHT_CLIENT_LAZY_FNS = new Set([
  'readChunk',
  'createLazyChunkWrapper',
  'waitForReference',
  'fulfillReference',
  'rejectReference',
  'wakeChunk',
  'wakeChunkIfInitialized',
  'createPendingChunk',
  'releasePendingChunk',
  'resolveListeners',
  'subscribeToChunk',
  'ReactPromise',
  'then',
]);

// DEV-only Flight client debug-info machinery (fake owner stacks, debug
// chunk initialization). Split out so development runs don't misattribute
// this to row parsing or lazy machinery.
const FLIGHT_CLIENT_DEBUG_FNS = new Set([
  'fakeJSXCallSite',
  'buildFakeCallStack',
  'createFakeFunction',
  'createFakeServerFunction',
  'initializeFakeStack',
  'initializeFakeTask',
  'initializeDebugChunk',
  'initializeDebugInfo',
  'moveDebugInfoFromChunkToInnerValue',
  'getRootTask',
  'resolveDebugInfo',
  'resolveConsoleEntry',
  'forwardDebugInfo',
]);

// Fizz machinery for suspending on a thrown thenable and retrying later.
const FIZZ_SUSPEND_FNS = new Set([
  'spawnNewSuspendedRenderTask',
  'spawnNewSuspendedReplayTask',
  'retryTask',
  'retryRenderTask',
  'retryReplayTask',
  'pingTask',
  'trackUsedThenable',
  'unwrapThenable',
  'createThenableState',
  'readPreviousThenable',
  'getSuspendedThenable',
  'getThenableStateAfterSuspending',
  'queueCompletedSegment',
]);

function bucketForFrame(callFrame) {
  const url = callFrame.url || '';
  const name = callFrame.functionName || '';
  if (url === '') {
    if (
      name === '(garbage collector)' ||
      name === '(program)' ||
      name === '(idle)' ||
      name === '(root)'
    ) {
      return 'vm (gc/program/idle)';
    }
    return 'other';
  }
  if (url.includes('rsc-bundle.js')) {
    return 'flight server (render + serialize rows)';
  }
  if (url.includes('react-server-dom-webpack-client')) {
    if (FLIGHT_CLIENT_DEBUG_FNS.has(name)) {
      return 'flight client: DEV debug info (fake stacks)';
    }
    return FLIGHT_CLIENT_LAZY_FNS.has(name)
      ? 'flight client: lazy/throw machinery'
      : 'flight client: row parse + chunk bookkeeping';
  }
  if (url.includes('react-dom-server')) {
    return FIZZ_SUSPEND_FNS.has(name)
      ? 'fizz: suspend/retry machinery'
      : 'fizz: render';
  }
  if (url.includes('/react/cjs/') || url.includes('react-jsx')) {
    return 'react core';
  }
  if (url.startsWith('node:')) {
    return 'node internals (streams, timers)';
  }
  return 'other';
}

// profile: parsed .cpuprofile JSON. Returns {buckets, totalMs, totalSamples}.
function categorizeProfile(profile) {
  const totalSamples = profile.nodes.reduce((s, n) => s + (n.hitCount || 0), 0);
  const totalMicros = profile.endTime - profile.startTime;
  const microsPerSample = totalSamples > 0 ? totalMicros / totalSamples : 0;

  const buckets = new Map();
  for (const node of profile.nodes) {
    const hitCount = node.hitCount || 0;
    if (hitCount === 0) {
      continue;
    }
    const bucketName = bucketForFrame(node.callFrame);
    let bucket = buckets.get(bucketName);
    if (!bucket) {
      bucket = {samples: 0, fns: new Map()};
      buckets.set(bucketName, bucket);
    }
    bucket.samples += hitCount;
    const name = node.callFrame.functionName || '(anonymous)';
    const loc = node.callFrame.url
      ? node.callFrame.url.replace(/.*\//, '') + ':' + node.callFrame.lineNumber
      : '(native)';
    const key = name + ' @ ' + loc;
    bucket.fns.set(key, (bucket.fns.get(key) || 0) + hitCount);
  }

  return {buckets, totalSamples, microsPerSample};
}

function printAttribution(label, categorized, iterations, topN) {
  const {buckets, totalSamples, microsPerSample} = categorized;
  console.log('  %s:', label);
  console.log(
    '    Total sampled: %s ms (%d samples, %d iterations)',
    ((totalSamples * microsPerSample) / 1000).toFixed(1),
    totalSamples,
    iterations
  );
  const vmBucket = buckets.get('vm (gc/program/idle)');
  const activeSamples = totalSamples - (vmBucket ? vmBucket.samples : 0);
  console.log(
    '    Active (excl. gc/program/idle): %s ms (%s ms/iter)',
    ((activeSamples * microsPerSample) / 1000).toFixed(1),
    ((activeSamples * microsPerSample) / 1000 / iterations).toFixed(3)
  );
  const sorted = [...buckets.entries()].sort(
    (a, b) => b[1].samples - a[1].samples
  );
  for (const [name, bucket] of sorted) {
    const ms = (bucket.samples * microsPerSample) / 1000;
    console.log(
      '    %s%%  %s ms/iter  %s',
      ((bucket.samples / totalSamples) * 100).toFixed(1).padStart(5),
      (ms / iterations).toFixed(3).padStart(7),
      name
    );
    const fns = [...bucket.fns.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN);
    for (const [key, hits] of fns) {
      console.log(
        '        %s%%  %s',
        ((hits / totalSamples) * 100).toFixed(1).padStart(5),
        key
      );
    }
  }
}

module.exports = {categorizeProfile, printAttribution};
