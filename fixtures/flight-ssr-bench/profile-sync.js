'use strict';

// CPU-profile attribution for the *dashboard* (sync App) pipelines, to see
// what the remaining Flight overhead is made of after the model channel and
// row packing landed. Profiles three variants with the same buckets as
// bench-fragmented.js:
//
//   fizz     - plain Fizz render of the same tree (the floor)
//   bytes    - Flight -> byte stream -> Flight client -> Fizz
//   channel  - Flight -> model channel -> Flight client -> Fizz
//
// Run with: NODE_ENV=production node --expose-gc profile-sync.js

require('@babel/register')({
  presets: [['@babel/preset-react', {runtime: 'automatic'}]],
  plugins: ['@babel/plugin-transform-modules-commonjs'],
  only: [/\/src\//],
});

const path = require('path');
const fs = require('fs');
const inspector = require('node:inspector');

const {clientManifest, ssrManifest} = require('./webpack-mock');
const {categorizeProfile, printAttribution} = require('./profile-attribution');
const {
  renderFizzNode,
  renderFlightFizzNode,
  renderFlightFizzNodeChannel,
  nodeStreamToString,
} = require('./render-helpers');

const PROFILE_WARMUP = 100;
const PROFILE_ITERATIONS = 800;
const ITEM_COUNT = 200;

const canGC = typeof globalThis.gc === 'function';

function startProfiler() {
  const session = new inspector.Session();
  session.connect();
  return new Promise(function (resolve, reject) {
    session.post('Profiler.enable', function (err) {
      if (err) return reject(err);
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
    8
  );
  console.log('');
}

async function main() {
  const {renderRSCNode, App: RSCApp} = require('./build/rsc-bundle.js');
  const App = require('./src/App.js').default;

  const profileDir = path.resolve(__dirname, 'build/profiles');

  // Sanity: the pipelines produce the same HTML as plain Fizz.
  const fizzHtml = await nodeStreamToString(renderFizzNode(App, ITEM_COUNT));
  const bytesHtml = await nodeStreamToString(
    renderFlightFizzNode(renderRSCNode, RSCApp, ITEM_COUNT, clientManifest, ssrManifest, {inject: false})
  );
  const channelHtml = await nodeStreamToString(
    renderFlightFizzNodeChannel(renderRSCNode, RSCApp, ITEM_COUNT, clientManifest, ssrManifest, {inject: false})
  );
  if (bytesHtml !== fizzHtml || channelHtml !== fizzHtml) {
    throw new Error('HTML mismatch between variants');
  }
  console.log('fizz html: %d bytes (all variants identical)', fizzHtml.length);

  await profileAttributed(
    'dashboard plain Fizz',
    () => nodeStreamToString(renderFizzNode(App, ITEM_COUNT)),
    path.join(profileDir, 'sync-fizz.cpuprofile')
  );

  await profileAttributed(
    'dashboard Flight bytes -> Fizz',
    () =>
      nodeStreamToString(
        renderFlightFizzNode(
          renderRSCNode,
          RSCApp,
          ITEM_COUNT,
          clientManifest,
          ssrManifest,
          {inject: false}
        )
      ),
    path.join(profileDir, 'sync-bytes.cpuprofile')
  );

  await profileAttributed(
    'dashboard Flight channel -> Fizz',
    () =>
      nodeStreamToString(
        renderFlightFizzNodeChannel(
          renderRSCNode,
          RSCApp,
          ITEM_COUNT,
          clientManifest,
          ssrManifest,
          {inject: false}
        )
      ),
    path.join(profileDir, 'sync-channel.cpuprofile')
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
