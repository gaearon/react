'use strict';
// Pure data-props payload: a big JSON model, no elements. Measures Flight
// server render+flush (bytes) and channel delivery. Run in the fixture dir.
const {Writable, PassThrough} = require('stream');
const {renderToPipeableStream} = require('react-server-dom-webpack/server');
const {createModelChannel, createFromModelChannel} =
  require('react-server-dom-webpack/client');

function makeData(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: i, sku: 'SKU-' + i, name: 'Product name ' + i,
      price: (i * 7919) % 100000 / 100, quantity: (i * 31) % 50,
      tags: ['alpha', 'beta', 'gamma'],
      dims: {w: i % 10, h: (i * 3) % 10, d: (i * 7) % 10},
      active: i % 2 === 0,
    });
  }
  return {items};
}
const DATA = makeData(5000);

function nullSink() {
  return new Writable({write(c, e, cb) { cb(); }});
}
function renderBytes() {
  return new Promise((resolve, reject) => {
    const {pipe} = renderToPipeableStream({data: DATA}, null, {onError: reject});
    const sink = nullSink();
    sink.on('finish', resolve);
    pipe(sink);
  });
}
function renderChannel() {
  return new Promise((resolve, reject) => {
    const channel = createModelChannel();
    const result = createFromModelChannel(channel, {serverConsumerManifest: {moduleMap: null, moduleLoading: null}});
    const {pipe} = renderToPipeableStream({data: DATA}, null, {
      onError: reject, modelChannel: channel,
    });
    const sink = nullSink();
    sink.on('finish', () => {
      Promise.resolve(result).then(r => {
        if (r.data.items.length !== 5000) reject(new Error('bad model'));
        resolve(r);
      }, reject);
    });
    pipe(sink);
  });
}
async function bench(name, fn, iters) {
  for (let i = 0; i < 30; i++) await fn();
  if (global.gc) global.gc();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log('%s median %s ms  p95 %s ms', name.padEnd(10),
    times[iters >> 1].toFixed(3), times[Math.floor(iters * 0.95)].toFixed(3));
}
async function main() {
  // Identity probe: does the channel deliver the caller's own objects?
  const probe = await renderChannel();
  console.log('identity preserved:', probe.data === DATA, probe.data.items[0] === DATA.items[0]);
  await bench('bytes', renderBytes, 200);
  await bench('channel', renderChannel, 200);
}
main().catch(e => { console.error(e); process.exit(1); });
