'use strict';

// Focused measurement for the row-fragmentation debate in
// https://github.com/facebook/react/issues/35125.
//
// Two competing hypotheses for why fragmented pages are slow through the
// Flight pipeline:
//
//   1. Per-row overhead (mhart): once a children array crosses
//      MAX_ROW_SIZE=3200, every remaining sibling becomes its own ~60-byte
//      $L row, and emitting/framing/parsing thousands of rows is the cost.
//   2. Lazy/throw machinery (gnoff): each deferred row is modeled as a
//      throw-based lazy on the client, so the SSR pass throws and retries
//      thousands of times, and that machinery is the cost.
//
// To separate them, this script replays the exact same captured Flight
// payload (same bytes, same chunk boundaries) through Flight client + Fizz
// in two modes:
//
//   buffered: all rows resolved before Fizz starts -> zero throws, full
//             per-row parse cost.
//   streamed: rows arrive one macrotask apart while Fizz renders -> same
//             per-row parse cost, plus the full throw/suspend/retry cost.
//
// streamed - buffered isolates the lazy/throw machinery. buffered - plain
// Fizz isolates per-row parse + chunk bookkeeping. A CPU-profile bucket
// attribution over the full pipeline cross-checks both. Throws cost
// differently in dev and prod, so run this under both:
//
//   yarn bench:fragmented       (NODE_ENV=production)
//   yarn bench:fragmented:dev   (NODE_ENV=development)

require('@babel/register')({
  presets: [['@babel/preset-react', {runtime: 'automatic'}]],
  plugins: ['@babel/plugin-transform-modules-commonjs'],
  only: [/\/src\//],
});

const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const inspector = require('node:inspector');
const {PassThrough} = require('stream');

const {clientManifest, ssrManifest} = require('./webpack-mock');
const {
  renderFizzNode,
  renderFlightFizzNode,
  captureRSCChunks,
  renderFlightFizzNodeReplay,
  nodeStreamToString,
} = require('./render-helpers');
const {
  analyzeFlightPayload,
  printFlightRowStats,
  splitFlightPayloadRows,
} = require('./flight-row-stats');
const {categorizeProfile, printAttribution} = require('./profile-attribution');

const MODE = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
const SKIP_PROFILE = process.argv.includes('--no-profile');

const ITEM_COUNT = 200; // dashboard app rows
const FRAGMENTED_SECTION_COUNT = 20; // ~100 sibling paragraphs per section

const WARMUP = Number(process.env.WARMUP) || (MODE === 'prod' ? 50 : 20);
const ITERATIONS =
  Number(process.env.ITERATIONS) || (MODE === 'prod' ? 500 : 200);
const PROFILE_WARMUP = 20;
const PROFILE_ITERATIONS =
  Number(process.env.PROFILE_ITERATIONS) || (MODE === 'prod' ? 300 : 100);

function build() {
  const config = require('./webpack.config');
  return new Promise(function (resolve, reject) {
    webpack(config, function (err, stats) {
      if (err) {
        reject(err);
        return;
      }
      if (stats.hasErrors()) {
        reject(new Error(stats.toString({errors: true})));
        return;
      }
      resolve();
    });
  });
}

const canGC = typeof globalThis.gc === 'function';

async function runBenchmark(name, fn, iterations, warmup) {
  if (canGC) globalThis.gc();
  for (let i = 0; i < warmup; i++) {
    await fn();
  }
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  const mean = trimmed.reduce((s, t) => s + t, 0) / trimmed.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const result = {name, mean, median, p95};
  console.log(
    '  %s  mean %s ms  median %s ms  p95 %s ms',
    name.padEnd(46),
    mean.toFixed(2).padStart(7),
    median.toFixed(2).padStart(7),
    p95.toFixed(2).padStart(7)
  );
  return result;
}

function startProfiler() {
  const session = new inspector.Session();
  session.connect();
  return new Promise(function (resolve, reject) {
    session.post('Profiler.enable', function (err) {
      if (err) return reject(err);
      // Max sampling resolution for finer self-time attribution.
      session.post(
        'Profiler.setSamplingInterval',
        {interval: 100},
        function (err2) {
          if (err2) return reject(err2);
          session.post('Profiler.start', function (err3) {
            if (err3) return reject(err3);
            resolve(session);
          });
        }
      );
    });
  });
}

function stopProfiler(session, outputPath) {
  return new Promise(function (resolve, reject) {
    session.post('Profiler.stop', function (err, {profile}) {
      if (err) return reject(err);
      fs.mkdirSync(path.dirname(outputPath), {recursive: true});
      fs.writeFileSync(outputPath, JSON.stringify(profile));
      session.post('Profiler.disable');
      session.disconnect();
      resolve(profile);
    });
  });
}

async function profileAttributed(label, fn, outputPath) {
  for (let i = 0; i < PROFILE_WARMUP; i++) {
    await fn();
  }
  if (canGC) globalThis.gc();
  const session = await startProfiler();
  for (let i = 0; i < PROFILE_ITERATIONS; i++) {
    await fn();
  }
  const profile = await stopProfiler(session, outputPath);
  printAttribution(
    label + ' -> ' + path.relative(__dirname, outputPath),
    categorizeProfile(profile),
    PROFILE_ITERATIONS,
    5
  );
  console.log('');
}

// Writes chunks one macrotask apart into a no-op consumer. Measures the raw
// event-loop cost of the streamed replay's drip-feed, so the throw/suspend
// deltas can be read net of scheduling overhead.
function dripChunks(chunks) {
  return new Promise(function (resolve) {
    const stream = new PassThrough();
    stream.on('data', function () {});
    stream.on('end', resolve);
    let i = 0;
    (function writeNext() {
      if (i < chunks.length) {
        stream.write(chunks[i++]);
        setImmediate(writeNext);
      } else {
        stream.end();
      }
    })();
  });
}

function delta(label, a, b) {
  console.log(
    '  %s  %s ms  (%s ms -> %s ms, %sx)',
    label.padEnd(46),
    (b.median - a.median).toFixed(2).padStart(7),
    a.median.toFixed(2),
    b.median.toFixed(2),
    (b.median / a.median).toFixed(2)
  );
}

async function main() {
  console.log('Building RSC bundle (NODE_ENV=%s)...', process.env.NODE_ENV);
  await build();

  const {
    renderRSCNode,
    App: RSCApp,
    AppFragmented: RSCAppFragmented,
  } = require('./build/rsc-bundle.js');
  const AppFragmented = require('./src/AppFragmented.js').default;

  // --- Flight payload row stats ---------------------------------------------
  console.log('\n--- Flight payload row stats (%s) ---\n', MODE);

  const dashboardChunks = await captureRSCChunks(
    renderRSCNode,
    RSCApp,
    ITEM_COUNT,
    clientManifest
  );
  const fragmentedChunks = await captureRSCChunks(
    renderRSCNode,
    RSCAppFragmented,
    FRAGMENTED_SECTION_COUNT,
    clientManifest
  );
  const dashboardPayload = Buffer.concat(dashboardChunks);
  const fragmentedPayload = Buffer.concat(fragmentedChunks);

  printFlightRowStats(
    'Dashboard app (' + ITEM_COUNT + ' items)',
    analyzeFlightPayload(dashboardPayload)
  );
  console.log('    Stream chunks:      %d', dashboardChunks.length);
  printFlightRowStats(
    'Fragmented app (' +
      FRAGMENTED_SECTION_COUNT +
      ' sections x ~103 paragraphs)',
    analyzeFlightPayload(fragmentedPayload)
  );
  console.log('    Stream chunks:      %d', fragmentedChunks.length);

  const fragmentedRowChunks = splitFlightPayloadRows(fragmentedPayload);

  // --- Verify all variants agree ---------------------------------------------
  console.log('\n--- Verifying renders ---\n');

  const fizzHtml = await nodeStreamToString(
    renderFizzNode(AppFragmented, FRAGMENTED_SECTION_COUNT)
  );
  const pipelineHtml = await nodeStreamToString(
    renderFlightFizzNode(
      renderRSCNode,
      RSCAppFragmented,
      FRAGMENTED_SECTION_COUNT,
      clientManifest,
      ssrManifest,
      {inject: false}
    )
  );
  const bufferedHtml = await renderFlightFizzNodeReplay(
    fragmentedChunks,
    ssrManifest,
    'buffered'
  );
  const streamedHtml = await renderFlightFizzNodeReplay(
    fragmentedRowChunks,
    ssrManifest,
    'streamed'
  );
  console.log('Fizz HTML:              %d bytes', fizzHtml.length);
  console.log('Full pipeline HTML:     %d bytes', pipelineHtml.length);
  console.log('Buffered replay HTML:   %d bytes', bufferedHtml.length);
  console.log('Streamed replay HTML:   %d bytes', streamedHtml.length);
  if (pipelineHtml !== bufferedHtml || pipelineHtml !== streamedHtml) {
    throw new Error('Replay variants produced different HTML.');
  }

  // --- Timings ----------------------------------------------------------------
  console.log(
    '\n--- Timings (%s, %d warmup, %d iterations) ---\n',
    MODE,
    WARMUP,
    ITERATIONS
  );

  const fizzOnly = await runBenchmark(
    'Fizz only (no Flight)',
    () =>
      nodeStreamToString(
        renderFizzNode(AppFragmented, FRAGMENTED_SECTION_COUNT)
      ),
    ITERATIONS,
    WARMUP
  );

  const flightServerOnly = await runBenchmark(
    'Flight server only (serialize rows)',
    () =>
      captureRSCChunks(
        renderRSCNode,
        RSCAppFragmented,
        FRAGMENTED_SECTION_COUNT,
        clientManifest
      ),
    ITERATIONS,
    WARMUP
  );

  const fullPipeline = await runBenchmark(
    'Full pipeline (Flight server+client+Fizz)',
    () =>
      nodeStreamToString(
        renderFlightFizzNode(
          renderRSCNode,
          RSCAppFragmented,
          FRAGMENTED_SECTION_COUNT,
          clientManifest,
          ssrManifest,
          {inject: false}
        )
      ),
    ITERATIONS,
    WARMUP
  );

  const replayBuffered = await runBenchmark(
    'Replay buffered (0 throws, all rows parsed)',
    () => renderFlightFizzNodeReplay(fragmentedChunks, ssrManifest, 'buffered'),
    ITERATIONS,
    WARMUP
  );

  const replayStreamedNatural = await runBenchmark(
    'Replay streamed (natural chunk boundaries)',
    () => renderFlightFizzNodeReplay(fragmentedChunks, ssrManifest, 'streamed'),
    ITERATIONS,
    WARMUP
  );

  const replayStreamedPerRow = await runBenchmark(
    'Replay streamed (1 chunk per row, worst case)',
    () =>
      renderFlightFizzNodeReplay(fragmentedRowChunks, ssrManifest, 'streamed'),
    ITERATIONS,
    WARMUP
  );

  const dripNatural = await runBenchmark(
    'Drip baseline (natural chunks, no React)',
    () => dripChunks(fragmentedChunks),
    ITERATIONS,
    WARMUP
  );

  const dripPerRow = await runBenchmark(
    'Drip baseline (per-row chunks, no React)',
    () => dripChunks(fragmentedRowChunks),
    ITERATIONS,
    WARMUP
  );

  // --- Attribution ------------------------------------------------------------
  console.log('\n--- Cost attribution (medians) ---\n');
  delta('Flight tax (full pipeline vs Fizz only)', fizzOnly, fullPipeline);
  delta('Row parse cost (buffered replay vs Fizz)', fizzOnly, replayBuffered);
  delta(
    'Throw/suspend cost, natural chunks',
    replayBuffered,
    replayStreamedNatural
  );
  delta(
    'Throw/suspend cost, per-row chunks',
    replayBuffered,
    replayStreamedPerRow
  );
  console.log(
    '\n  Net of drip-feed scheduling overhead (setImmediate per chunk):\n' +
      '    throw/suspend, natural chunks: %s ms (drip baseline %s ms)\n' +
      '    throw/suspend, per-row chunks: %s ms (drip baseline %s ms)',
    (
      replayStreamedNatural.median -
      replayBuffered.median -
      dripNatural.median
    ).toFixed(2),
    dripNatural.median.toFixed(2),
    (
      replayStreamedPerRow.median -
      replayBuffered.median -
      dripPerRow.median
    ).toFixed(2),
    dripPerRow.median.toFixed(2)
  );
  console.log(
    '\n  (Replay variants parse identical bytes; buffered resolves every row\n' +
      '  before Fizz starts so readChunk never throws, streamed forces the\n' +
      '  throw-based suspend/retry path for rows that have not arrived yet.\n' +
      '  Flight server only: %s ms median.)',
    flightServerOnly.median.toFixed(2)
  );

  // --- CPU profile bucket attribution ------------------------------------------
  if (!SKIP_PROFILE) {
    console.log(
      '\n--- CPU profile attribution (%s, %d iterations each) ---\n',
      MODE,
      PROFILE_ITERATIONS
    );
    const profileDir = path.resolve(__dirname, 'build/profiles');

    await profileAttributed(
      'Full pipeline',
      () =>
        nodeStreamToString(
          renderFlightFizzNode(
            renderRSCNode,
            RSCAppFragmented,
            FRAGMENTED_SECTION_COUNT,
            clientManifest,
            ssrManifest,
            {inject: false}
          )
        ),
      path.join(profileDir, 'fragmented-pipeline-' + MODE + '.cpuprofile')
    );

    await profileAttributed(
      'Replay buffered (no throws)',
      () =>
        renderFlightFizzNodeReplay(fragmentedChunks, ssrManifest, 'buffered'),
      path.join(
        profileDir,
        'fragmented-replay-buffered-' + MODE + '.cpuprofile'
      )
    );

    await profileAttributed(
      'Replay streamed (per-row chunks, max throws)',
      () =>
        renderFlightFizzNodeReplay(
          fragmentedRowChunks,
          ssrManifest,
          'streamed'
        ),
      path.join(
        profileDir,
        'fragmented-replay-streamed-' + MODE + '.cpuprofile'
      )
    );
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
